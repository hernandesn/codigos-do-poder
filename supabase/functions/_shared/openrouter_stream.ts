// Cliente HTTP do OpenRouter. A chave entra só no header e não volta em erro nem em log.

import { OpenRouterError, redactSecrets, type OpenRouterChunk, type OpenRouterClient, type OpenRouterUsage } from './chat_core.ts'

function openRouterErrorSummary(raw: string, status: number): string {
  const trimmed = raw.trim()
  if (!trimmed) return `status=${status} empty_body`
  try {
    const json = JSON.parse(trimmed) as { error?: { message?: unknown; code?: unknown; metadata?: unknown } }
    const err = json?.error
    if (err && typeof err === 'object') {
      const message = typeof err.message === 'string' ? err.message.slice(0, 240) : ''
      const code = err.code != null ? String(err.code).slice(0, 40) : ''
      return `status=${status} code=${code} message=${message}`
    }
  } catch {
    // corpo não-JSON
  }
  return `status=${status} body=${trimmed.slice(0, 240)}`
}


export function createFetchOpenRouter(opts: { apiKey: string; url: string }): OpenRouterClient {
  return {
    async *stream(input) {
      if (!opts.apiKey) throw new OpenRouterError('rede', 'chave ausente')
      let response: Response
      try {
        response = await fetch(opts.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            'content-type': 'application/json',
            'http-referer': 'https://aion.hernandesnogueira.com.br',
            'x-title': 'Atlas Codigos do Poder',
          },
          body: JSON.stringify(input.body),
          signal: input.signal,
        })
      } catch (err) {
        if (input.signal.aborted || isAbort(err)) {
          const abortErr = new Error('aborted')
          abortErr.name = 'AbortError'
          throw abortErr
        }
        throw new OpenRouterError('rede', 'falha de rede')
      }
      if (!response.ok) {
        const raw = await response.text().catch(() => '')
        const limited = response.status === 402 || (response.status === 403 && providerLimitBody(raw))
        const kind = limited
          ? 'limite_chave'
          : response.status === 429
            ? 'modelo_ocupado'
            : response.status === 400 || response.status === 404 || response.status === 422
              ? 'modelo_indisponivel'
              : 'rede'
        console.error(redactSecrets(`openrouter_http ${openRouterErrorSummary(raw, response.status)}`))
        throw new OpenRouterError(kind, `http ${response.status}`)
      }
      if (!response.body) throw new OpenRouterError('rede', 'resposta vazia')
      yield* iterateOpenRouterSse(response.body, input.signal)
    },
  }
}

export async function* iterateOpenRouterSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<OpenRouterChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal.aborted) {
        const abortErr = new Error('aborted')
        abortErr.name = 'AbortError'
        throw abortErr
      }
      let done = false
      let value: Uint8Array | undefined
      try {
        const next = await reader.read()
        done = next.done
        value = next.value
      } catch (err) {
        if (signal.aborted || isAbort(err)) {
          const abortErr = new Error('aborted')
          abortErr.name = 'AbortError'
          throw abortErr
        }
        throw err
      }
      if (signal.aborted) {
        const abortErr = new Error('aborted')
        abortErr.name = 'AbortError'
        throw abortErr
      }
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const split = buffer.split('\n\n')
      buffer = split.pop() ?? ''
      for (const block of split) {
        const parsed = parseOpenRouterBlock(block)
        if (parsed === null || 'done' in parsed) continue
        if ('error' in parsed) {
          console.error(redactSecrets(`openrouter_stream_error ${parsed.kind}`))
          throw new OpenRouterError(parsed.kind, 'erro no stream')
        }
        yield parsed.chunk
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function parseOpenRouterBlock(block: string): { done: true } | { error: true; kind: 'modelo_indisponivel' | 'modelo_ocupado' } | { chunk: OpenRouterChunk } | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('')
  if (!data) return null
  if (data === '[DONE]') return { done: true }
  let json: Record<string, unknown>
  try {
    json = JSON.parse(data)
  } catch {
    return { error: true, kind: 'modelo_indisponivel' }
  }
  if (json.error) {
    const err = json.error
    const message = err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
      ? String((err as { message: string }).message).slice(0, 240)
      : 'erro no stream'
    console.error(redactSecrets(`openrouter_stream_error ${message}`))
    const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
    return { error: true, kind: code === 429 || code === '429' ? 'modelo_ocupado' : 'modelo_indisponivel' }
  }
  const choice = Array.isArray(json.choices) ? json.choices[0] as { delta?: { content?: unknown } } | undefined : undefined
  const content = choice?.delta?.content
  const usage = readUsage(json.usage)
  const chunk: OpenRouterChunk = {}
  if (typeof content === 'string' && content) chunk.delta = content
  if (usage) chunk.usage = usage
  if (!chunk.delta && !chunk.usage) return null
  return { chunk }
}

function readUsage(value: unknown): OpenRouterUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const usage: OpenRouterUsage = {}
  if (typeof row.prompt_tokens === 'number') usage.prompt_tokens = row.prompt_tokens
  if (typeof row.completion_tokens === 'number') usage.completion_tokens = row.completion_tokens
  if (typeof row.total_tokens === 'number') usage.total_tokens = row.total_tokens
  const cost = row.cost ?? row.total_cost
  if (typeof cost === 'number') usage.cost = cost
  return usage
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function providerLimitBody(raw: string): boolean {
  return raw.includes('openrouter_key_limit')
    || raw.includes('openrouter_credits')
    || raw.includes('openrouter_in_flight_budget')
    || raw.includes('openrouter_guardrail_budget')
    || raw.includes('openrouter_workspace_budget')
}
