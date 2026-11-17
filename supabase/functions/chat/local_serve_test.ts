// Exercita o handler HTTP com OpenRouter num mock local. Não usa chave real.

import { handleChatRequest, resetJwksCacheForTests, resetMemoryForTests } from './handler.ts'

const SECRET = 'fixture-hmac-ux3c'
const KEY = 'local-mock-not-a-real-key'
const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const QUESTION = 'Quais as conexões documentadas de Mauá?'

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

function answer() {
  return JSON.stringify({
    blocos: [{
      tipo: 'documentado',
      texto: 'Mauá aparece no recorte.',
      entidades: ['maua'],
      relacoes: ['r1'],
      fontes: ['S1'],
    }],
    entidades: ['maua'],
    relacoes: ['r1'],
    fontes: ['S1'],
    avisos: [],
    sem_base: false,
    sugestoes: [],
  })
}

const FIXTURE_ISS = 'https://fixture.supabase.co/auth/v1'

async function sign(sub: string): Promise<string> {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64(JSON.stringify({
    sub,
    role: 'authenticated',
    aud: 'authenticated',
    iss: FIXTURE_ISS,
    exp: Math.floor(Date.now() / 1000) + 600,
  }))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
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

function parseSse(body: string) {
  return body.split('\n\n').filter(Boolean).map((block) => {
    const event = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim()
    const data = block.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim()
    return { event, data: data ? JSON.parse(data) : null }
  })
}

Deno.test('functions serve local sem OpenRouter real', async () => {
  resetMemoryForTests()
  let posts = 0
  const postCount = () => posts
  let keyMode: 'invalid' | 'exhausted' | 'valid' = 'invalid'
  const mock = Deno.serve({ port: 0, hostname: '127.0.0.1' }, async (req) => {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${KEY}`) return new Response('no', { status: 401 })
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname.endsWith('/key')) {
      if (keyMode === 'invalid') {
        return Response.json({ data: { limit: null, limit_reset: null, limit_remaining: null, include_byok_in_limit: false } })
      }
      if (keyMode === 'exhausted') {
        return Response.json({ data: { limit: 3, limit_reset: 'daily', limit_remaining: 0, include_byok_in_limit: false } })
      }
      return Response.json({ data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false } })
    }
    if (req.method !== 'POST') return new Response('no', { status: 404 })
    posts += 1
    const payload = await req.json()
    const text = typeof payload?.messages?.[1]?.content === 'string' ? payload.messages[1].content : ''
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        if (text.startsWith('ABORT')) {
          send({ choices: [{ delta: { content: '{"blocos":' } }] })
          // O sinal do request no Deno.serve local às vezes só dispara
          // quando o servidor tenta escrever de novo. O ping força isso.
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (req.signal.aborted) {
                clearInterval(timer)
                resolve()
                return
              }
              try {
                controller.enqueue(encoder.encode(': ping\n\n'))
              } catch {
                clearInterval(timer)
                resolve()
              }
            }, 20)
          })
          try {
            controller.close()
          } catch {
            // o fetch já cancelou
          }
          return
        }
        const json = answer()
        send({ choices: [{ delta: { content: json.slice(0, 30) } }] })
        send({ choices: [{ delta: { content: json.slice(30) } }] })
        send({ choices: [{}], usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.02 } })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  })

  Deno.env.set('CHAT_DB', 'memory')
  Deno.env.set('CHAT_EXPOSE_STATE', '1')
  const mockAddr = mock.addr
  if (!('port' in mockAddr)) throw new Error('mock sem porta')
  Deno.env.set('OPENROUTER_URL', `http://127.0.0.1:${mockAddr.port}/v1/chat/completions`)
  Deno.env.set('OPENROUTER_KEY_URL', `http://127.0.0.1:${mockAddr.port}/api/v1/key`)
  Deno.env.set('OPENROUTER_API_KEY', KEY)
  Deno.env.set('JWT_SECRET', SECRET)
  Deno.env.set('SUPABASE_URL', 'https://fixture.supabase.co')
  Deno.env.set('CHAT_DAILY_BUDGET_USD', '3')

  const app = Deno.serve({ port: 0, hostname: '127.0.0.1' }, (req) => handleChatRequest(req))
  const base = `http://127.0.0.1:${app.addr.port}`
  let jwksServer: Deno.HttpServer | null = null
  const transcript: string[] = []
  const log = (line: string) => {
    transcript.push(line)
    console.log(line)
  }

  try {
    const origin = 'https://aion.hernandesnogueira.com.br'
    const preflight = await fetch(base, { method: 'OPTIONS', headers: { origin } })
    log(`OPTIONS produção ${preflight.status} acao=${preflight.headers.get('access-control-allow-origin')}`)
    assert(preflight.status === 204, 'options 204')
    assert(preflight.headers.get('access-control-allow-origin') === origin, 'reflete a origem')

    const local = await fetch(base, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:5173' } })
    log(`OPTIONS 127.0.0.1 ${local.status} acao=${local.headers.get('access-control-allow-origin')}`)
    assert(local.headers.get('access-control-allow-origin') === 'http://127.0.0.1:5173', 'localhost permitido')

    const evil = await fetch(base, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    log(`OPTIONS evil acao=${evil.headers.get('access-control-allow-origin')}`)
    assert(evil.headers.get('access-control-allow-origin') === null, 'evil sem CORS')

    const anon = await fetch(base, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ mensagem: QUESTION, contexto: { entidades: ['maua'] }, modelo: 'basico', user_id: OTHER }),
    })
    const anonBody = await anon.text()
    log(`sem_login ${anon.status} ${anonBody.trim()}`)
    assert(anon.status === 401, '401')
    assert(anonBody.includes('sem_login'), 'code sem_login')
    assert(!anonBody.includes(KEY), 'resposta sem a chave')

    const token = await sign(USER)
    const ok = await fetch(base, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mensagem: QUESTION,
        contexto: { entidades: ['maua'] },
        modelo: 'basico',
        user_id: OTHER,
      }),
    })
    const okBody = await ok.text()
    log(`happy ${ok.status} bytes=${okBody.length}`)
    assert(ok.status === 503, 'chave inválida 503')
    assert(ok.headers.get('access-control-allow-origin') === origin, 'cors no post')
    assert(okBody.includes('chave_recusada'), 'fecha sem chamar')
    assert(okBody.includes('não foi aceita'), 'motivo')
    assert(!okBody.includes(KEY), 'sse sem chave')
    assert(!okBody.includes('sk-or-'), 'sse sem sk-or')
    assert(postCount() === 0, 'completions não foi chamado')

    keyMode = 'exhausted'
    const spent = await fetch(base, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mensagem: QUESTION, contexto: { entidades: ['maua'] }, modelo: 'basico' }),
    })
    const spentBody = await spent.text()
    log(`chave esgotada ${spent.status}`)
    assert(spent.status === 503, 'restante zero')
    assert(spentBody.includes('limite_chave'), 'limite nativo')
    assert(spentBody.includes('acabou'), 'texto')
    assert(!spentBody.includes('US$'), 'sem anunciar teto')
    assert(postCount() === 0, 'ainda sem completions')

    keyMode = 'valid'
    const paid = await fetch(base, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mensagem: QUESTION,
        contexto: { entidades: ['maua'] },
        modelo: 'basico',
        user_id: OTHER,
      }),
    })
    const paidBody = await paid.text()
    log(`pago ${paid.status} bytes=${paidBody.length}`)
    assert(paid.status === 200, 'chave válida chega ao modelo')
    assert(postCount() === 1, 'uma completion')
    assert(paidBody.includes('Mauá aparece'), 'resposta do mock')
    assert(paidBody.includes('0.02'), 'custo informado')
    assert(!paidBody.includes(OTHER), 'user_id do body não vira usuário')
    assert(!paidBody.includes(KEY), 'sse sem chave')

    const state1 = await (await fetch(`${base}/__state`)).json()
    log(`estado após chamada ${JSON.stringify(state1.quotas)} logs=${state1.logs.length}`)
    assert(state1.quotas.some((row: { key: string; used: number }) => row.key.startsWith(USER) && row.used === 1), 'debitou o sub')
    assert(state1.logs.some((row: { custo_usd: number; user_key: string }) => row.user_key === USER && row.custo_usd === 0.02), 'log com o custo real')

    const esUser = '33333333-3333-4333-8333-333333333333'
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    jwksServer = Deno.serve({ port: 0, hostname: '127.0.0.1' }, () => Response.json({
      keys: [{ ...jwk, alg: 'ES256', kid: 'fixture-es256', use: 'sig' }],
    }))
    const jwksAddr = jwksServer.addr
    if (!('port' in jwksAddr)) throw new Error('jwks sem porta')
    Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${jwksAddr.port}`)
    resetJwksCacheForTests()
    const signEs = async (claims: Record<string, unknown>) => {
      const header = b64(JSON.stringify({ alg: 'ES256', kid: 'fixture-es256', typ: 'JWT' }))
      const payload = b64(JSON.stringify(claims))
      const sig = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      ))
      return `${header}.${payload}.${b64bytes(sig)}`
    }
    const esIss = `http://127.0.0.1:${jwksAddr.port}/auth/v1`
    const esToken = await signEs({
      sub: esUser,
      role: 'authenticated',
      aud: 'authenticated',
      iss: esIss,
      exp: Math.floor(Date.now() / 1000) + 600,
      user_metadata: { sub: OTHER, role: 'service_role' },
    })
    const es = await fetch(base, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${esToken}`, apikey: 'sb_publishable_fixture', 'content-type': 'application/json' },
      body: JSON.stringify({
        mensagem: QUESTION,
        contexto: { entidades: ['maua'] },
        modelo: 'basico',
        user_id: OTHER,
      }),
    })
    const esBody = await es.text()
    log(`es256 ${es.status} bytes=${esBody.length}`)
    assert(es.status === 200, 'ES256 autenticado chega ao modelo')
    assert(esBody.includes('event: final'), 'final depois do JWT')
    assert(!esBody.includes(OTHER), 'user_metadata não vira usuário')
    const esState = await (await fetch(`${base}/__state`)).json()
    assert(esState.quotas.some((row: { key: string; used: number }) => row.key.startsWith(esUser) && row.used === 1), 'debitou o sub do JWT')
    assert(postCount() === 2, 'segunda completion')
    assert(!esBody.includes('sb_publishable_fixture'), 'resposta sem a chave pública')

    const expired = await signEs({
      sub: esUser,
      role: 'authenticated',
      aud: 'authenticated',
      iss: esIss,
      exp: Math.floor(Date.now() / 1000) - 120,
    })
    const expiredRes = await fetch(base, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${expired}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mensagem: QUESTION, contexto: { entidades: ['maua'] }, modelo: 'basico' }),
    })
    const expiredBody = await expiredRes.text()
    log(`es256 expirado ${expiredRes.status}`)
    assert(expiredRes.status === 401, 'expirado 401')
    assert(expiredBody.includes('sem_login'), 'expirado sem_login')

    const otherPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const forgedHeader = b64(JSON.stringify({ alg: 'ES256', kid: 'fixture-es256', typ: 'JWT' }))
    const forgedPayload = b64(JSON.stringify({
      sub: esUser,
      role: 'authenticated',
      aud: 'authenticated',
      iss: esIss,
      exp: Math.floor(Date.now() / 1000) + 600,
    }))
    const forgedSig = new Uint8Array(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      otherPair.privateKey,
      new TextEncoder().encode(`${forgedHeader}.${forgedPayload}`),
    ))
    const forged = await fetch(base, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${forgedHeader}.${forgedPayload}.${b64bytes(forgedSig)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mensagem: QUESTION, contexto: { entidades: ['maua'] }, modelo: 'basico' }),
    })
    assert(forged.status === 401, 'assinatura ES256 alheia recusada')
  } finally {
    if (jwksServer) await jwksServer.shutdown()
    await app.shutdown()
    await mock.shutdown()
    Deno.env.delete('SUPABASE_URL')
    resetJwksCacheForTests()
    Deno.env.delete('CHAT_DB')
    Deno.env.delete('CHAT_EXPOSE_STATE')
    Deno.env.delete('OPENROUTER_URL')
    Deno.env.delete('OPENROUTER_KEY_URL')
    Deno.env.delete('OPENROUTER_API_KEY')
    Deno.env.delete('JWT_SECRET')
    Deno.env.delete('CHAT_DAILY_BUDGET_USD')
    resetMemoryForTests()
  }
})
