// HTTP da Edge Function chat. O user_id sai do JWT. O body não escolhe usuário.
// verify_jwt no gateway é a trava principal; aqui ainda exigimos sub.

import {
  CHAT_MODEL_TIMEOUT_MS,
  OPENROUTER_KEY_URL,
  OPENROUTER_URL,
  chatErrorMessage,
  loadInferenceKeyAssessment,
  corsHeaders,
  formatSse,
  prepareChat,
  redactSecrets,
  resolveDailyBudgetUsd,
  streamPrepared,
  supabaseIssuer,
  userIdFromAuthorization,
  type ChatDb,
  type ChatSseEvent,
  type Es256Jwk,
} from '../_shared/chat_core.ts'
import { createMemoryDb } from '../_shared/memory_db.ts'
import { createFetchOpenRouter } from '../_shared/openrouter_stream.ts'

let memory: ReturnType<typeof createMemoryDb> | null = null
let pgDb: ChatDb | null = null

export function readEnv(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get(name: string): string | undefined } } }).Deno
  if (deno?.env) return deno.env.get(name)
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}

function budgetUsd(): number | null {
  return resolveDailyBudgetUsd(readEnv('CHAT_DAILY_BUDGET_USD'))
}

function jwtSecret(): string | undefined {
  return readEnv('JWT_SECRET') || readEnv('SUPABASE_JWT_SECRET') || undefined
}

let jwksCache: { url: string; keys: Es256Jwk[]; at: number } | null = null

export function resetJwksCacheForTests(): void {
  jwksCache = null
}

export async function loadProjectJwks(): Promise<{ keys: Es256Jwk[] }> {
  const base = readEnv('SUPABASE_URL')
  if (!base) return { keys: [] }
  let url: string
  try {
    url = new URL('/auth/v1/.well-known/jwks.json', base.endsWith('/') ? base : `${base}/`).href
  } catch {
    return { keys: [] }
  }
  const now = Date.now()
  if (jwksCache && jwksCache.url === url && now - jwksCache.at < 10 * 60 * 1000) {
    return { keys: jwksCache.keys }
  }
  try {
    const response = await fetch(url)
    if (!response.ok) return { keys: [] }
    const body = await response.json() as { keys?: Es256Jwk[] }
    const keys = Array.isArray(body.keys) ? body.keys : []
    jwksCache = { url, keys, at: now }
    return { keys }
  } catch {
    return { keys: [] }
  }
}

async function chatDb(): Promise<ChatDb> {
  if (readEnv('CHAT_DB') === 'memory') {
    if (!memory) memory = createMemoryDb()
    return memory
  }
  if (pgDb) return pgDb
  const url = readEnv('ATLAS_CHAT_DB_URL')
  if (!url) throw new Error('db_url_ausente')
  const { createPgChatDb } = await import('../_shared/pg_chat_db.ts')
  pgDb = createPgChatDb(url)
  return pgDb
}

export function resetMemoryForTests(): void {
  memory = null
  pgDb = null
}

function sse(events: ChatSseEvent[], status: number, extra: Record<string, string>): Response {
  const body = events.map(formatSse).join('')
  return new Response(body, {
    status,
    headers: {
      ...extra,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}

export async function handleChatRequest(req: Request): Promise<Response> {
  const origin = req.headers.get('origin')
  const headers = corsHeaders(origin)
  const url = new URL(req.url)

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })

  if (req.method === 'GET' && url.pathname === '/__state' && readEnv('CHAT_DB') === 'memory' && readEnv('CHAT_EXPOSE_STATE') === '1') {
    return Response.json(memory ? memory.dump() : { quotas: [], logs: [] }, { headers })
  }

  if (req.method !== 'POST') {
    return Response.json({ code: 'pedido_invalido', message: 'Use POST.' }, { status: 405, headers })
  }

  const userId = await userIdFromAuthorization(req.headers.get('authorization'), {
    jwtSecret: jwtSecret(),
    loadJwks: loadProjectJwks,
    issuer: supabaseIssuer(readEnv('SUPABASE_URL')),
    audience: 'authenticated',
  })
  if (!userId) {
    return sse([{ event: 'error', data: { code: 'sem_login', message: chatErrorMessage('sem_login') } }], 401, headers)
  }

  const budget = budgetUsd()
  if (budget === null) {
    return sse([{ event: 'error', data: { code: 'orcamento_esgotado', message: chatErrorMessage('orcamento_esgotado') } }], 503, headers)
  }

  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > 65_536) {
    return sse([{ event: 'error', data: { code: 'pedido_invalido', message: chatErrorMessage('pedido_invalido') } }], 400, headers)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return sse([{ event: 'error', data: { code: 'pedido_invalido', message: chatErrorMessage('pedido_invalido') } }], 400, headers)
  }

  let db: ChatDb
  try {
    db = await chatDb()
  } catch (err) {
    console.error(redactSecrets(err instanceof Error ? err.message : 'db indisponível'))
    return sse([{ event: 'error', data: { code: 'rede', message: 'Serviço indisponível.' } }], 502, headers)
  }

  let prepared: Awaited<ReturnType<typeof prepareChat>>
  try {
    prepared = await prepareChat({
      userId,
      body,
      db,
      budgetUsd: budget,
      loadInferenceKey: () => loadInferenceKeyAssessment({
        apiKey: readEnv('OPENROUTER_API_KEY') ?? '',
        url: readEnv('OPENROUTER_KEY_URL') || OPENROUTER_KEY_URL,
      }),
    })
  } catch (err) {
    console.error(redactSecrets(err instanceof Error ? err.message : 'falha interna'))
    return sse([{ event: 'error', data: { code: 'rede', message: 'Falha interna.' } }], 502, headers)
  }
  if (!prepared.ok) return sse([prepared.event], prepared.httpStatus, headers)

  const localAbort = new AbortController()
  const timeout = AbortSignal.timeout(CHAT_MODEL_TIMEOUT_MS)
  const onUserAbort = () => localAbort.abort('client')
  const onTimeout = () => localAbort.abort('timeout')
  req.signal.addEventListener('abort', onUserAbort)
  timeout.addEventListener('abort', onTimeout)
  const detach = () => {
    req.signal.removeEventListener('abort', onUserAbort)
    timeout.removeEventListener('abort', onTimeout)
  }

  const buffered: ChatSseEvent[] = []
  let live: ((event: ChatSseEvent) => void) | null = null
  let opened = false
  let resolveGate!: (value: { mode: 'stream' } | { mode: 'early'; status: number }) => void
  const gate = new Promise<{ mode: 'stream' } | { mode: 'early'; status: number }>((resolve) => {
    resolveGate = resolve
  })

  const finished = streamPrepared({
    prepared,
    db,
    openrouter: createFetchOpenRouter({
      apiKey: readEnv('OPENROUTER_API_KEY') ?? '',
      url: readEnv('OPENROUTER_URL') || OPENROUTER_URL,
    }),
    signal: localAbort.signal,
    isUserAbort: () => req.signal.aborted || localAbort.signal.reason === 'client',
    emit(event) {
      if (live) {
        live(event)
        return
      }
      buffered.push(event)
      if (!opened && (event.event === 'meta' || event.event === 'delta')) {
        opened = true
        resolveGate({ mode: 'stream' })
      }
    },
  }).then(
    (status) => {
      if (!opened) resolveGate({ mode: 'early', status })
      return status
    },
    (err) => {
      console.error(redactSecrets(err instanceof Error ? err.message : 'stream'))
      const hasTerminal = buffered.some((event) => event.event === 'final' || event.event === 'error')
      if (!hasTerminal) {
        const terminal: ChatSseEvent = { event: 'error', data: { code: 'rede', message: chatErrorMessage('rede') } }
        if (live) live(terminal)
        else buffered.push(terminal)
      }
      if (!opened) resolveGate({ mode: 'early', status: 200 })
      return 200
    },
  )

  const decision = await gate
  if (decision.mode === 'early') {
    detach()
    return sse(buffered, decision.status, headers)
  }

  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let streamEnded = false
  const closeIfReady = () => {
    if (!streamEnded || !controller) return
    detach()
    try {
      controller.close()
    } catch {
      // já fechado
    }
  }
  finished.finally(() => {
    streamEnded = true
    closeIfReady()
  })

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
      const push = (event: ChatSseEvent) => {
        try {
          ctrl.enqueue(encoder.encode(formatSse(event)))
        } catch {
          // O cliente já fechou. O release acontece no abort do fetch.
        }
      }
      for (const event of buffered.splice(0, buffered.length)) push(event)
      live = push
      closeIfReady()
    },
    cancel() {
      localAbort.abort('client')
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}


