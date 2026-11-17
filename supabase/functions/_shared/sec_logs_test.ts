import { createFetchOpenRouter, iterateOpenRouterSse } from './openrouter_stream.ts'
import { MemoryChatDb } from './memory_db.ts'
import { handleChatRequest, resetMemoryForTests } from '../chat/handler.ts'
import { fixtureEnv, fixtureRequest } from './sec_http_fixture.ts'
import { redactSecrets } from './chat_core.ts'
function check(ok: boolean, label: string) { if (!ok) throw new Error(label) }

Deno.test('SEC-04 logs HTTP, SSE e handler descartam texto livre sensível sintético', async () => {
  const output: unknown[][] = []
  const originalLog = console.error
  const originalFetch = globalThis.fetch
  const originalRate = MemoryChatDb.prototype.rateTouch
  const sensitive = 'password=fixture-not-real private-provider-body'
  console.error = (...args) => { output.push(args) }
  try {
    const client = createFetchOpenRouter({ apiKey: 'fixture-only', url: 'https://fixture.invalid/chat' })
    globalThis.fetch = async () => Response.json({ error: { message: sensitive, metadata: { body: sensitive } } }, { status: 500 })
    try { for await (const _ of client.stream({ body: {}, signal: new AbortController().signal })) { /* sem chunks */ } } catch { /* esperado */ }
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ error: { code: 429, message: sensitive } })}\n\n`)
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })
    try { for await (const _ of iterateOpenRouterSse(stream, new AbortController().signal)) { /* sem chunks */ } } catch { /* esperado */ }
    fixtureEnv()
    resetMemoryForTests()
    MemoryChatDb.prototype.rateTouch = async () => { throw new Error(sensitive) }
    const response = await handleChatRequest(await fixtureRequest(JSON.stringify({ mensagem: 'Mauá', contexto: { entidades: ['maua'] }, modelo: 'basico' })))
    check(response.status === 502, 'falha controlada')
    check(!(await response.text()).includes(sensitive), 'cliente genérico')
    check(output.length === 3, 'um evento por caminho')
    for (const args of output) {
      check(args.length === 1 && typeof args[0] === 'string', 'JSON único')
      const row = JSON.parse(args[0] as string)
      check(Object.keys(row).every(k => ['evento', 'kind', 'status', 'pedido_id'].includes(k)), 'só campos permitidos')
      check(!JSON.stringify(row).includes('fixture-not-real') && !JSON.stringify(row).includes('private-provider-body'), 'sem texto livre')
    }
  } finally {
    console.error = originalLog
    globalThis.fetch = originalFetch
    MemoryChatDb.prototype.rateTouch = originalRate
    resetMemoryForTests()
  }
})
Deno.test('SEC-04 redação adicional de credenciais genéricas', () => {
  for (const text of ['password=fixture-only', 'senha:fixture-only', '"client_secret":"fixture-only"', 'https://user:fixture-only@example.invalid']) {
    check(!redactSecrets(text).includes('fixture-only'), 'credencial sintética removida')
  }
})
