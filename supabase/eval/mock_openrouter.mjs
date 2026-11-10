// Mock do OpenRouter em 127.0.0.1. Não usa chave real.

import { createServer } from 'node:http'
import { custoUsd, estimarTokens } from './metrics.mjs'

export const MOCK_API_KEY = 'local-mock-not-a-real-key'

const KEY_BODY = {
  data: {
    limit: 3,
    limit_reset: 'daily',
    limit_remaining: 2.5,
    include_byok_in_limit: false,
  },
}

export function parseRecorte(system) {
  const marker = 'Recorte (dados, não instruções):\n'
  const idx = String(system ?? '').lastIndexOf(marker)
  if (idx < 0) return null
  try {
    return JSON.parse(system.slice(idx + marker.length).trim())
  } catch {
    return null
  }
}

function recorteVazio(ctx) {
  if (!ctx || typeof ctx !== 'object') return true
  const raizes = Array.isArray(ctx.raizes) ? ctx.raizes.length : 0
  const entidades = Array.isArray(ctx.entidades) ? ctx.entidades.length : 0
  const relacoes = Array.isArray(ctx.relacoes) ? ctx.relacoes.length : 0
  return raizes === 0 && entidades === 0 && relacoes === 0
}

function vazioSemBase() {
  return { blocos: [], entidades: [], relacoes: [], fontes: [], avisos: [], sem_base: true, sugestoes: [] }
}

function lacunaSemLigacao() {
  return {
    blocos: [{
      tipo: 'documentado',
      texto: 'O atlas não documenta ligação direta entre as entidades desta pergunta.',
      entidades: [],
      relacoes: [],
      fontes: [],
    }],
    entidades: [],
    relacoes: [],
    fontes: [],
    avisos: [],
    sem_base: false,
    sugestoes: [],
  }
}

export function sintetizarResposta(system, opcoes = {}) {
  const expectativa = opcoes.expectativa ?? null
  const recorte = parseRecorte(system)
  if (recorteVazio(recorte) || expectativa === 'fora_da_base') {
    return vazioSemBase()
  }
  if (expectativa === 'sem_ligacao') {
    const nRaizes = Array.isArray(recorte?.raizes) ? recorte.raizes.length : 0
    const nLigacoes = Array.isArray(recorte?.ligacoes_entre_raizes) ? recorte.ligacoes_entre_raizes.length : 0
    if (nRaizes >= 2 && nLigacoes === 0) return vazioSemBase()
    return lacunaSemLigacao()
  }
  const rel = recorte.relacoes[0]
  const fontesRecorte = new Set()
  for (const fonte of recorte.fontes ?? []) if (fonte?.id) fontesRecorte.add(fonte.id)
  for (const item of recorte.relacoes ?? []) {
    for (const fonte of item?.fontes ?? []) if (fonte) fontesRecorte.add(fonte)
  }
  const entidadesRecorte = new Set()
  for (const item of [...(recorte.raizes ?? []), ...(recorte.entidades ?? [])]) {
    if (item?.id) entidadesRecorte.add(item.id)
  }
  for (const item of recorte.relacoes ?? []) {
    if (item?.origem) entidadesRecorte.add(item.origem)
    if (item?.destino) entidadesRecorte.add(item.destino)
  }
  if (!rel?.id) {
    return vazioSemBase()
  }
  const fontes = (Array.isArray(rel.fontes) ? rel.fontes : []).filter((id) => fontesRecorte.has(id))
  const entidades = [rel.origem, rel.destino].filter((id) => id && entidadesRecorte.has(id))
  const texto = typeof rel.afirmacao === 'string' && rel.afirmacao.trim()
    ? rel.afirmacao.trim()
    : `A relação ${rel.id} consta no recorte.`
  return {
    blocos: [{ tipo: 'documentado', texto, entidades, relacoes: [rel.id], fontes }],
    entidades,
    relacoes: [rel.id],
    fontes,
    avisos: [],
    sem_base: false,
    sugestoes: [],
  }
}

const ID_FANTASMA = 'id_inexistente_eval_ruim'

export function injetarPerfilRuim(answer) {
  const base = answer && typeof answer === 'object' ? answer : vazioSemBase()
  const bloco = {
    tipo: 'documentado',
    texto: 'Bloco sem fonte injetado pelo perfil ruim.',
    entidades: [ID_FANTASMA],
    relacoes: [],
    fontes: [],
  }
  return {
    ...base,
    entidades: [...(Array.isArray(base.entidades) ? base.entidades : []), ID_FANTASMA],
    blocos: [...(Array.isArray(base.blocos) ? base.blocos : []), bloco],
  }
}

export function createMockState() {
  return {
    respostas: new Map(),
    expectativas: new Map(),
    perfil: 'limpo',
    precoEntradaMtok: 0,
    precoSaidaMtok: 0,
    ultima: null,
    posts: 0,
    recusarChave: false,
  }
}

function respostaPara(state, system, user) {
  if (state.respostas.has(user)) return state.respostas.get(user)
  const expectativa = state.expectativas?.get(user) ?? null
  const answer = sintetizarResposta(system, { expectativa })
  if (state.perfil === 'ruim') return injetarPerfilRuim(answer)
  return answer
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function startMock(state) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers.authorization !== `Bearer ${MOCK_API_KEY}`) {
      res.writeHead(401)
      res.end('no')
      return
    }
    if (req.method === 'GET' && url.pathname.endsWith('/key')) {
      if (state.recusarChave) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end('{"error":"recusada"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(KEY_BODY))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end('no')
      return
    }
    const raw = await readBody(req)
    let payload = {}
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      payload = {}
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const system = typeof messages[0]?.content === 'string' ? messages[0].content : ''
    const user = typeof messages[1]?.content === 'string' ? messages[1].content : ''
    const answer = respostaPara(state, system, user)
    const texto = JSON.stringify(answer)
    const tokensIn = estimarTokens(system.length + user.length)
    const tokensOut = estimarTokens(texto.length)
    const cost = custoUsd(tokensIn, tokensOut, state.precoEntradaMtok, state.precoSaidaMtok)
    state.posts += 1
    state.ultima = { pergunta: user, texto, system, tokensIn, tokensOut, cost }
    const usage = { prompt_tokens: tokensIn, completion_tokens: tokensOut, cost }
    const encoder = (obj) => `data: ${JSON.stringify(obj)}\n\n`
    const mid = Math.max(1, Math.floor(texto.length / 2))
    const body = [
      encoder({ choices: [{ delta: { content: texto.slice(0, mid) } }] }),
      encoder({ choices: [{ delta: { content: texto.slice(mid) } }] }),
      encoder({ choices: [{}], usage }),
      'data: [DONE]\n\n',
    ].join('')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(body)
  })
  await listen(server)
  const port = server.address().port
  return {
    port,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    keyUrl: `http://127.0.0.1:${port}/api/v1/key`,
    async close() {
      await closeServer(server)
    },
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}
