// Contrato SSE da UX3a. Falha se faltar campo ou se o tipo divergir.

import { assessInferenceKey, chatErrorMessage, OpenRouterError, runChat, type ChatDb, type ChatSseEvent, type OpenRouterClient } from './chat_core.ts'
import { createMemoryDb } from './memory_db.ts'
import { handleChatRequest, resetMemoryForTests } from '../chat/handler.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const CLOCK = () => new Date('2026-11-05T15:00:00-03:00')
const FIXTURE = new URL('../chat/fixtures/final_exemplo.json', import.meta.url)

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n actual=${JSON.stringify(actual)}\n expected=${JSON.stringify(expected)}`)
  }
}

const META_KEYS = [
  'conversa_id',
  'modelo',
  'custo_estimado',
  'n_entidades',
  'n_fontes',
  'gratis_restantes',
  'saldo_pago',
] as const

const FINAL_KEYS = [
  'conversa_id',
  'blocos',
  'entidades',
  'fontes',
  'fontes_detalhe',
  'avisos',
  'custo_real',
  'gratis_restantes',
  'saldo_pago',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function assertStringArray(value: unknown, label: string) {
  assert(Array.isArray(value), `${label} array`)
  for (const item of value) assert(typeof item === 'string', `${label} string`)
}

export function assertMeta(value: unknown): void {
  assert(isRecord(value), 'meta objeto')
  for (const key of META_KEYS) assert(key in value, `meta.${key}`)
  for (const key of Object.keys(value)) assert((META_KEYS as readonly string[]).includes(key), `meta campo extra ${key}`)
  assert(typeof value.conversa_id === 'string' && value.conversa_id.length > 0, 'meta.conversa_id')
  assert(value.modelo === 'basico' || value.modelo === 'avancado', 'meta.modelo')
  assert(typeof value.custo_estimado === 'number', 'meta.custo_estimado')
  assert(typeof value.n_entidades === 'number', 'meta.n_entidades')
  assert(typeof value.n_fontes === 'number', 'meta.n_fontes')
  assert(typeof value.gratis_restantes === 'number', 'meta.gratis_restantes')
  assert(typeof value.saldo_pago === 'number', 'meta.saldo_pago')
}

export function assertBloco(value: unknown): void {
  assert(isRecord(value), 'bloco objeto')
  assert(typeof value.texto === 'string', 'bloco.texto')
  if (value.tipo === 'documentado') {
    for (const key of ['tipo', 'texto', 'entidades', 'relacoes', 'fontes']) assert(key in value, `documentado.${key}`)
    assertStringArray(value.entidades, 'documentado.entidades')
    assertStringArray(value.relacoes, 'documentado.relacoes')
    assertStringArray(value.fontes, 'documentado.fontes')
    return
  }
  assert(value.tipo === 'inferencia', 'bloco.tipo')
  for (const key of ['tipo', 'texto', 'base', 'justificativa']) assert(key in value, `inferencia.${key}`)
  assertStringArray(value.base, 'inferencia.base')
  assert(typeof value.justificativa === 'string', 'inferencia.justificativa')
}

export function assertFinal(value: unknown): void {
  assert(isRecord(value), 'final objeto')
  for (const key of FINAL_KEYS) assert(key in value, `final.${key}`)
  for (const key of Object.keys(value)) {
    if (key === 'usage') continue
    assert((FINAL_KEYS as readonly string[]).includes(key), `final campo extra ${key}`)
  }
  assert(!('saldo' in value), 'sem alias saldo')
  assert(typeof value.conversa_id === 'string' && value.conversa_id.length > 0, 'final.conversa_id')
  assert(Array.isArray(value.blocos) && value.blocos.length > 0, 'final.blocos')
  const tipos = new Set<string>()
  for (const bloco of value.blocos) {
    assertBloco(bloco)
    tipos.add((bloco as { tipo: string }).tipo)
  }
  assert(tipos.has('documentado') && tipos.has('inferencia'), 'os dois tipos de bloco')
  assert(Array.isArray(value.entidades), 'final.entidades')
  for (const item of value.entidades) {
    assert(isRecord(item), 'entidade objeto')
    assert(typeof item.id === 'string' && item.id.length > 0, 'entidade.id')
    assert(typeof item.nome === 'string' && item.nome.length > 0, 'entidade.nome')
  }
  assertStringArray(value.fontes, 'final.fontes')
  assert(isRecord(value.fontes_detalhe), 'fontes_detalhe')
  for (const id of value.fontes as string[]) {
    const detalhe = value.fontes_detalhe[id]
    assert(isRecord(detalhe), `detalhe ${id}`)
    assert(typeof detalhe.titulo === 'string', 'detalhe.titulo')
    if ('url' in detalhe) assert(typeof detalhe.url === 'string', 'detalhe.url')
    if ('localizador' in detalhe) assert(typeof detalhe.localizador === 'string', 'detalhe.localizador')
  }
  assert(Array.isArray(value.avisos), 'avisos')
  for (const aviso of value.avisos) {
    assert(isRecord(aviso), 'aviso objeto')
    assert(aviso.tipo === 'estado' || aviso.tipo === 'citacao_removida' || aviso.tipo === 'outro', 'aviso.tipo')
    assert(typeof aviso.texto === 'string' && aviso.texto.length > 0, 'aviso.texto')
    if ('relacao' in aviso) assert(typeof aviso.relacao === 'string', 'aviso.relacao')
    if ('valor' in aviso) assert(typeof aviso.valor === 'string', 'aviso.valor')
  }
  if ('usage' in value) assert(isRecord(value.usage), 'usage objeto')
  assert(typeof value.custo_real === 'number', 'custo_real')
  assert(typeof value.gratis_restantes === 'number', 'final.gratis_restantes')
  assert(typeof value.saldo_pago === 'number', 'final.saldo_pago')
}

function answerJson() {
  return JSON.stringify({
    blocos: [{
      tipo: 'documentado',
      texto: 'Mauá aparece no recorte com fonte.',
      entidades: ['maua'],
      relacoes: ['r1'],
      fontes: ['S1'],
    }, {
      tipo: 'inferencia',
      texto: 'A leitura não cria fato novo.',
      base: ['maua', 'r1'],
      justificativa: 'O recorte mostra a sociedade e não um fato além dele.',
    }],
    sem_base: false,
  })
}

function client(delta: string): OpenRouterClient {
  return {
    async *stream() {
      yield { delta }
      yield { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, cost: 0.0002 } }
    },
  }
}

Deno.test('contrato UX3a meta e final', async () => {
  const store = createMemoryDb({ clock: CLOCK })
  const result = await runChat({
    userId: USER,
    body: { mensagem: 'Quais as conexões documentadas de Mauá?', contexto: { entidades: ['maua'] }, modelo: 'basico' },
    db: store as ChatDb,
    openrouter: client(answerJson()),
    clock: CLOCK,
    inferenceKey: assessInferenceKey({
      data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false },
    }),
  })
  eq(result.httpStatus, 200, 'chave limitada chega ao modelo')
  eq(result.events.some((event) => event.event === 'final'), true, 'final')
  const fixture = JSON.parse(await Deno.readTextFile(FIXTURE))
  assertFinal(fixture)
})

Deno.test('rate_limit traz os segundos e modelo precoce é 503', async () => {
  const store = createMemoryDb({ clock: CLOCK })
  store.seedRate(USER, 10, CLOCK())
  const limited = await runChat({
    userId: USER,
    body: { mensagem: 'Mauá', contexto: { entidades: ['maua'] }, modelo: 'basico' },
    db: store,
    openrouter: client('{}'),
    clock: CLOCK,
  })
  eq(limited.httpStatus, 429, '429')
  const data = limited.events[0].data as { code: string; message: string; retry_after_s: number }
  eq(data.code, 'rate_limit', 'code')
  eq(data.message, chatErrorMessage('rate_limit', data.retry_after_s), 'mensagem oficial')
  assert(data.message.includes(String(data.retry_after_s)), 'número de segundos')

  const down = createMemoryDb({ clock: CLOCK })
  const early = await runChat({
    userId: USER,
    body: { mensagem: 'Mauá', contexto: { entidades: ['maua'] }, modelo: 'basico' },
    db: down,
    openrouter: {
      async *stream() {
        throw new OpenRouterError('modelo_indisponivel', 'http 404')
      },
    },
    clock: CLOCK,
    inferenceKey: assessInferenceKey({
      data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false },
    }),
  })
  eq(early.httpStatus, 503, 'precoce 503')
  eq((early.events.at(-1)?.data as { code: string }).code, 'modelo_indisponivel', 'erro do modelo')
  assert(!early.events.some((event: ChatSseEvent) => event.event === 'meta'), 'sem meta antes do stream')

  await assertHttp503()
})

async function assertHttp503(): Promise<void> {
  resetMemoryForTests()
  let posts = 0
  const mock = Deno.serve({ port: 0, hostname: '127.0.0.1' }, (req) => {
    if (req.method === 'POST') posts += 1
    return new Response('missing', { status: 404 })
  })
  const secret = 'fixture-hmac-ux3c2'
  const addr = mock.addr
  if (!('port' in addr)) throw new Error('mock sem porta')
  Deno.env.set('CHAT_DB', 'memory')
  Deno.env.set('JWT_SECRET', secret)
  Deno.env.set('SUPABASE_URL', 'https://fixture.supabase.co')
  Deno.env.set('OPENROUTER_API_KEY', 'local-mock-not-a-real-key')
  Deno.env.set('OPENROUTER_URL', `http://127.0.0.1:${addr.port}/v1/chat/completions`)
  Deno.env.set('OPENROUTER_KEY_URL', `http://127.0.0.1:${addr.port}/api/v1/key`)
  try {
    const token = await sign(USER, secret)
    const response = await handleChatRequest(new Request('http://127.0.0.1/chat', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mensagem: 'Mauá', contexto: { entidades: ['maua'] }, modelo: 'basico' }),
    }))
    const body = await response.text()
    eq(response.status, 503, 'HTTP 503')
    assert(body.includes('chave_recusada'), 'evento')
    assert(body.includes('não foi aceita'), 'texto')
    eq(posts, 0, 'completions não foi chamado')
  } finally {
    await mock.shutdown()
    Deno.env.delete('CHAT_DB')
    Deno.env.delete('JWT_SECRET')
    Deno.env.delete('SUPABASE_URL')
    Deno.env.delete('OPENROUTER_API_KEY')
    Deno.env.delete('OPENROUTER_URL')
    Deno.env.delete('OPENROUTER_KEY_URL')
    resetMemoryForTests()
  }
}

async function sign(sub: string, secret: string): Promise<string> {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64(JSON.stringify({
    sub,
    role: 'authenticated',
    aud: 'authenticated',
    iss: 'https://fixture.supabase.co/auth/v1',
    exp: Math.floor(Date.now() / 1000) + 600,
  }))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)))
  return `${header}.${payload}.${b64bytes(sig)}`
}

function b64(text: string): string {
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function b64bytes(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
