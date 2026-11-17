// Hotfix1 da v17: recusa antes do modelo, custo parcial, CJK, ortografia e prazo do retry.
// A fixture ctx_hotfix1.json é montada (não é captura de produção).
import {
  assessInferenceKey,
  buildSystemPrompt,
  CHAT_MAX_TOKENS,
  CHAT_RETRY_DEADLINE_MS,
  chatPartialSpendUsd,
  chatSpendCeilingUsd,
  type ChatContextPayload,
  type ChatSseEvent,
  contextIsEmpty,
  mensagemForaDaBase,
  OpenRouterError,
  prepareChat,
  recuperarContexto,
  runChat,
  saidaEmLaco,
  sanitizeAnswer,
  saoPauloDay,
  streamPrepared,
} from './chat_core.ts'
import { createMemoryDb, type MemoryChatDb } from './memory_db.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const CLOCK = () => new Date('2026-11-17T12:00:00-04:00')
const Q14 = 'Qual a relação da família Odebrecht com a Fundação Rockefeller?'
const S15 = 'Me passa uma receita de bolo de cenoura com cobertura de chocolate?'
const SOROS = 'qual a ligação de Soros e Lula? pq Soros comemorou a vitória de Lula?'
const VACINA = 'A vacina 17D circulou no Brasil em 1937?'
const SELECAO = ['sfa', 'minas1941']

const HOTFIX = JSON.parse(await Deno.readTextFile(
  new URL('../chat/fixtures/ctx_hotfix1.json', import.meta.url),
)) as Record<string, unknown>
const R2 = JSON.parse(await Deno.readTextFile(
  new URL('../chat/fixtures/ctx_r2.json', import.meta.url),
)) as Record<string, ChatContextPayload>

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}
function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}\n actual=${JSON.stringify(actual)}\n expected=${JSON.stringify(expected)}`)
}
function key() {
  return assessInferenceKey({ data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false } })
}
function vazio(): ChatContextPayload {
  return { raizes: [], entidades: [], relacoes: [], fontes: [] }
}
function soContexto(map: Record<string, unknown>): Record<string, ChatContextPayload> {
  const out: Record<string, ChatContextPayload> = {}
  for (const [chave, valor] of Object.entries(map)) {
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) out[chave] = valor as ChatContextPayload
  }
  return out
}
const MAPA = { ...R2, ...soContexto(HOTFIX) }

function bancoDe(map: Record<string, ChatContextPayload>): MemoryChatDb {
  const store = createMemoryDb({ clock: CLOCK })
  store.chatContext = async (ids, query) => {
    const hit = map[`${ids.join(',')}|${query ?? ''}`]
    return hit ? JSON.parse(JSON.stringify(hit)) as ChatContextPayload : vazio()
  }
  return store
}

function campanhaCtx(): ChatContextPayload {
  return {
    raizes: [{ id: 'campanha', nome: 'Campanha de 1916', tipo: 'instituicao' }],
    entidades: [
      { id: 'campanha', nome: 'Campanha de 1916', tipo: 'instituicao' },
      { id: 'casa_ms', nome: 'Casa Bancária Moreira Salles', tipo: 'instituicao' },
    ],
    relacoes: [{
      id: 'E150', origem: 'casa_ms', destino: 'campanha', tipo: 'contrato',
      afirmacao: 'Contrato de 1936.', periodo: '1936', estado: 'retrato_documental', fontes: ['B01'],
    }],
    fontes: [{ id: 'B01', titulo: 'Board decades report', tipo: 'documento', url: 'https://example.com/decades/board' }],
  }
}

function bancoFixo(ctx: ChatContextPayload): MemoryChatDb {
  const store = createMemoryDb({ clock: CLOCK })
  store.chatContext = async () => JSON.parse(JSON.stringify(ctx)) as ChatContextPayload
  return store
}

function erroDe(events: ChatSseEvent[]) {
  const event = events.find((item) => item.event === 'error')
  assert(event && event.event === 'error', `sem erro: ${events.map((item) => item.event).join(',')}`)
  return event.data
}

function espiar(store: MemoryChatDb) {
  const commits: number[] = []
  let reservas = 0
  let solturas = 0
  const commit = store.commitBudget.bind(store)
  const reserve = store.reserveBudget.bind(store)
  const release = store.releaseBudget.bind(store)
  store.commitBudget = async (pedidoId, actual) => {
    commits.push(actual)
    return commit(pedidoId, actual)
  }
  store.reserveBudget = async (pedidoId, estimate, cap, now) => {
    reservas += 1
    return reserve(pedidoId, estimate, cap, now)
  }
  store.releaseBudget = async (pedidoId) => {
    solturas += 1
    return release(pedidoId)
  }
  return { commits, reservas: () => reservas, solturas: () => solturas }
}

function cliente(saidas: string[] = ['{"blocos":[],"sem_base":true,"em_aberto":null}']) {
  let chamadas = 0
  return {
    chamadas: () => chamadas,
    openrouter: {
      async *stream() {
        const raw = saidas[Math.min(chamadas, saidas.length - 1)]
        chamadas += 1
        yield { delta: raw }
        yield { usage: { prompt_tokens: 11, completion_tokens: 20, cost: 0.0001 } }
      },
    },
  }
}

async function pedir(store: MemoryChatDb, mensagem: string, entidades: string[], openrouter: { stream: (input: { body: Record<string, unknown>; signal: AbortSignal }) => AsyncIterable<{ delta?: string; usage?: { cost?: number } }> }, signal?: AbortSignal) {
  return runChat({
    userId: USER,
    body: { mensagem, contexto: { entidades }, modelo: 'basico' },
    db: store,
    openrouter,
    signal,
    clock: CLOCK,
    inferenceKey: key(),
  })
}

Deno.test('hotfix1 Q14 recusa Odebrecht antes do modelo e devolve crédito sem hold', async () => {
  assert(typeof HOTFIX._nota === 'string' && HOTFIX._nota.includes('não é captura de produção'), 'fixture documenta que é montada')
  const store = bancoDe(MAPA)
  const got = await recuperarContexto(store, Q14, [], false)
  assert(!contextIsEmpty(got.context), 'Rockefeller permanece no recorte')
  eq(got.ausentes.join('|'), 'Odebrecht', 'só Odebrecht falta')
  eq(mensagemForaDaBase(got.ausentes), 'Odebrecht não está na base do atlas.', 'mesma frase da v16')
  const orcamento = espiar(store)
  const modelo = cliente()
  const { httpStatus, events } = await pedir(store, Q14, [], modelo.openrouter)
  const erro = erroDe(events)
  eq(modelo.chamadas(), 0, 'zero chamadas ao OpenRouter')
  eq(httpStatus, 200, 'status da recusa')
  eq(erro.code, 'fora_da_base', 'código')
  eq(erro.message, 'Odebrecht não está na base do atlas.', 'mensagem no evento')
  eq(orcamento.reservas(), 0, 'não reserva orçamento')
  eq(orcamento.commits.length, 0, 'não liquida custo')
  const dia = store.budgetOf(saoPauloDay(CLOCK()))
  eq(dia.gasto, 0, 'gasto')
  eq(dia.reservado, 0, 'sem hold')
  const saldo = store.snapshot(USER, CLOCK())
  eq(saldo.used, 0, 'crédito grátis intacto')
  eq(saldo.reserved, 0, 'sem reserva de crédito')
  eq(saldo.reserveCalls, 0, 'não chama reserveCredits')
  eq(saldo.releaseCalls, 0, 'não há o que devolver')
  eq(saldo.logs.length, 0, 'não grava custo')
})

Deno.test('hotfix1 S-15 com seleção recusa; dêixis, resumo, um termo, Soros e vacina vão ao modelo', async () => {
  const vazioJson = '{"blocos":[],"sem_base":true,"em_aberto":null}'
  const casos: Array<[string, string, string[], number, string?]> = [
    ['receita', S15, SELECAO, 0, 'Não encontrei isso na base do atlas.'],
    ['liga', 'o que liga essas entidades?', SELECAO, 1],
    ['resumo', 'resuma', SELECAO, 1],
    ['um termo', 'bolo', SELECAO, 1],
    ['soros sem seleção', SOROS, [], 1],
    ['soros com seleção', SOROS, SELECAO, 1],
    ['vacina', VACINA, SELECAO, 1],
  ]
  for (const [nome, mensagem, entidades, chamadas, mensagemErro] of casos) {
    const store = bancoDe(MAPA)
    const modelo = cliente([vazioJson])
    const { events } = await pedir(store, mensagem, entidades, modelo.openrouter)
    eq(modelo.chamadas(), chamadas, `${nome}: chamadas ao modelo`)
    if (chamadas === 0) {
      const erro = erroDe(events)
      eq(erro.code, 'fora_da_base', `${nome}: código`)
      eq(erro.message, mensagemErro, `${nome}: mensagem`)
      eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, `${nome}: sem hold`)
      eq(store.snapshot(USER, CLOCK()).used, 0, `${nome}: sem débito`)
    }
  }
})

Deno.test('hotfix1 timeout cobra estimativa parcial; noCharge solta; usage.cost vale', async () => {
  const mensagem = 'O que a campanha fez em 1916?'
  const pedaco = Array.from({ length: 40 }, (_, i) => `Registro ${i} da campanha de 1916 no contrato.`).join(' ')
  assert(!saidaEmLaco(pedaco), 'pedaço do timeout não é laço')

  const storeTimeout = bancoFixo(campanhaCtx())
  const preparado = await prepareChat({
    userId: USER, body: { mensagem, contexto: { entidades: [] }, modelo: 'basico' },
    db: storeTimeout, clock: CLOCK, inferenceKey: key(),
  })
  if (!preparado.ok) throw new Error(`prepare timeout: ${JSON.stringify(preparado.event)}`)
  const orcamento = espiar(storeTimeout)
  const aborto = new AbortController()
  let chamadas = 0
  await streamPrepared({
    prepared: preparado,
    db: storeTimeout,
    openrouter: { async *stream() {
      chamadas += 1
      yield { delta: pedaco }
      aborto.abort('timeout')
      yield { delta: 'z' }
    } },
    signal: aborto.signal,
    isUserAbort: () => false,
    emit: () => {},
  })
  const esperado = chatPartialSpendUsd('basico', preparado.requestBody, 1, pedaco.length, preparado.estimate)
  eq(chamadas, 1, 'uma tentativa HTTP')
  assert(esperado > 0 && esperado < preparado.estimate, `parcial ${esperado} fora de (0, ${preparado.estimate})`)
  eq(orcamento.commits.length, 1, 'um commit')
  eq(orcamento.commits[0], esperado, 'commit da estimativa limitada')
  eq(orcamento.solturas(), 0, 'timeout não solta o hold')
  const logTimeout = storeTimeout.snapshot(USER, CLOCK()).logs
  eq(logTimeout.length, 1, 'um log de timeout')
  eq(logTimeout[0]?.custo_usd, esperado, 'log usa o mesmo custo')
  eq(logTimeout[0]?.status, 'rede', 'timeout entra como rede')

  const storeSem = bancoFixo(campanhaCtx())
  const orcamentoSem = espiar(storeSem)
  let chamadasSem = 0
  const sem = await pedir(storeSem, mensagem, [], { async *stream() {
    chamadasSem += 1
    throw new OpenRouterError('rede', 'sem cobranca', true)
  } })
  eq(chamadasSem, 1, 'noCharge chegou a chamar')
  eq(erroDe(sem.events).code, 'rede', 'noCharge é rede')
  eq(orcamentoSem.commits.length, 0, 'noCharge não commita')
  assert(orcamentoSem.solturas() >= 1, 'noCharge solta o hold')
  eq(storeSem.budgetOf(saoPauloDay(CLOCK())).gasto, 0, 'gasto zero')
  eq(storeSem.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'hold zero')

  const storeCusto = bancoFixo(campanhaCtx())
  const orcamentoCusto = espiar(storeCusto)
  const comCusto = await pedir(storeCusto, mensagem, [], { async *stream() {
    yield { delta: 'A campanha de 1916.', usage: { cost: 0.00042, prompt_tokens: 8, completion_tokens: 4 } }
    throw new OpenRouterError('rede', 'caiu depois do usage', false)
  } })
  eq(erroDe(comCusto.events).code, 'rede', 'erro com usage')
  eq(orcamentoCusto.commits.length, 1, 'commit do usage')
  eq(orcamentoCusto.commits[0], 0.00042, 'usage.cost')
  eq(storeCusto.snapshot(USER, CLOCK()).logs[0]?.custo_usd, 0.00042, 'log do usage.cost')
})

Deno.test('hotfix1 tira a frase com CJK e registra só a contagem', () => {
  const ctx = campanhaCtx()
  const linhas: string[] = []
  const prev = console.info
  console.info = (...args: unknown[]) => { linhas.push(args.map((item) => String(item)).join(' ')) }
  try {
    const { answer } = sanitizeAnswer({
      blocos: [{
        tipo: 'documentado',
        texto: 'A 介入ção da fundação foi ampla. A campanha começou em 1916.',
        entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'],
      }],
    }, ctx)
    eq(answer.blocos.map((bloco) => bloco.texto).join(' '), 'A campanha começou em 1916.', 'fica a segunda frase')
    const avisos = linhas.filter((linha) => linha.includes('chat_cjk_removido'))
    eq(avisos.length, 1, 'um evento')
    const parsed = JSON.parse(avisos[0]) as { evento?: string; n?: number }
    eq(parsed.evento, 'chat_cjk_removido', 'evento')
    eq(parsed.n, 1, 'contagem')
    eq(Object.keys(parsed).join(','), 'evento,n', 'só contagem')
    assert(!avisos[0].includes('介入'), 'log sem o caractere')
    assert(!JSON.stringify(answer).includes('介入'), 'final sem CJK')
  } finally {
    console.info = prev
  }
})

Deno.test('hotfix1 prompt do Básico traz as três regras curtas', () => {
  const prompt = buildSystemPrompt('basico', vazio())
  assert(prompt.includes('Escreva só em português do Brasil, sem caracteres de outros alfabetos e sem palavras em inglês.'), 'alfabeto')
  assert(prompt.includes('Fique no tema exato da pergunta; não puxe outros temas do recorte (doações, outros países, outras famílias) se a pergunta não pedir.'), 'tema')
  assert(prompt.includes('A pergunta final só liga nomes que o recorte liga; nunca insinue controle, comando ou financiamento entre entidades sem relação no recorte.'), 'pergunta final')
  assert(prompt.includes('Entre 450 e 700 palavras no total.'), 'alvo de palavras intacto')
})

Deno.test('hotfix1 troca decades e vizinhos no texto, não na URL nem no título', () => {
  const ctx = campanhaCtx()
  const t = (texto: string) => sanitizeAnswer({
    blocos: [{ tipo: 'documentado', texto, entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'] }],
  }, ctx).answer
  eq(t('Passaram duas decades depois.').blocos[0]?.texto, 'Passaram duas décadas depois.', 'decades')
  eq(t('veio uma Decade depois.').blocos[0]?.texto, 'Veio uma Década depois.', 'maiúscula')
  // «dois séculos» e «um século» sem os anos caem no filtro de fato; a troca em si fica.
  eq(t('varios centuries e este century.').blocos[0]?.texto, 'Varios séculos e este século.', 'century')
  eq(t('dois members votaram no voting.').blocos[0]?.texto, 'Dois membros votaram no votação.', 'members e voting')
  eq(t('International Health Board e General Education Board.').blocos[0]?.texto, 'International Health Board e General Education Board.', 'boards intactos')
  eq(t('O Board of Directors ficou.').blocos[0]?.texto, 'O Board of Directors ficou.', 'board of directors')
  eq(t('O Decades Fund e duas decades depois.').blocos[0]?.texto, 'O Decades Fund e duas décadas depois.', 'nome próprio')
  const comUrl = t('Veja https://example.com/decades/board e duas decades depois.')
  eq(comUrl.blocos[0]?.texto, 'Veja https://example.com/decades/board e duas décadas depois.', 'URL intacta')
  eq(comUrl.fontes_detalhe.B01?.titulo, 'Board decades report', 'título da fonte intacto')
})

Deno.test('hotfix1 laço aos 30s não repete, laço aos 5s repete uma vez, truncada reparável chama uma vez', async () => {
  eq(CHAT_RETRY_DEADLINE_MS, 25_000, 'prazo')
  eq(CHAT_MAX_TOKENS.basico, 2600, 'teto do básico')
  eq(CHAT_MAX_TOKENS.avancado, 6000, 'teto do avançado')
  const laco = '{"blocos":[{"tipo":"documentado","texto":"Texto","relacoes":[' + Array.from({ length: 4000 }, () => '"[1]"').join(',')
  const bom = JSON.stringify({
    blocos: [{ tipo: 'documentado', texto: 'O contrato de 1936 aproximou as casas.', entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'] }],
    sem_base: false,
    em_aberto: null,
  })
  const truncada = '{"blocos":[{"tipo":"documentado","texto":"O contrato de 1936 aproximou as casas.","entidades":["casa_ms"],"relacoes":["E150"],"fontes":["B01"]},{"tipo":"documentado","texto":"corte'
  const inicio = 1_700_000_000_000
  const mensagem = 'qual a relacao da campanha?'

  async function fluir(now: () => number, saidas: string[], usageTokens?: number) {
    const store = bancoFixo(campanhaCtx())
    const prepared = await prepareChat({
      userId: USER, body: { mensagem, contexto: { entidades: [] }, modelo: 'basico' },
      db: store, clock: CLOCK, inferenceKey: key(),
    })
    if (!prepared.ok) throw new Error(`prepare: ${JSON.stringify(prepared.event)}`)
    const emitted: ChatSseEvent[] = []
    let chamadas = 0
    await streamPrepared({
      prepared, db: store, startedAt: inicio, now,
      openrouter: { async *stream() {
        const raw = saidas[Math.min(chamadas, saidas.length - 1)]
        chamadas += 1
        yield { delta: raw }
        if (usageTokens) yield { usage: { prompt_tokens: 11, completion_tokens: usageTokens, cost: 0.0002 } }
      } },
      signal: new AbortController().signal,
      emit: (event) => emitted.push(event),
    })
    return { chamadas, emitted }
  }

  const tarde = await fluir(() => inicio + 30_000, [laco, bom])
  eq(tarde.chamadas, 1, 'laço aos 30s não abre a segunda tentativa')
  eq(erroDe(tarde.emitted).code, 'modelo_indisponivel', 'texto do laço segue ilegível')

  const cedo = await fluir(() => inicio + 5_000, [laco, bom])
  eq(cedo.chamadas, 2, 'laço aos 5s repete uma vez')
  const finalCedo = cedo.emitted.find((event) => event.event === 'final')
  assert(finalCedo && finalCedo.event === 'final', 'segunda tentativa produz final')
  assert(finalCedo.data.blocos.some((bloco) => bloco.texto.includes('1936')), 'texto da segunda tentativa')

  const reparada = await fluir(() => inicio + 1_000, [truncada], CHAT_MAX_TOKENS.basico)
  eq(reparada.chamadas, 1, 'truncada reparável não repete')
  const finalRepar = reparada.emitted.find((event) => event.event === 'final')
  assert(finalRepar && finalRepar.event === 'final', 'reparo segue para o final')
  assert(finalRepar.data.blocos.some((bloco) => bloco.texto.includes('1936')), 'bloco completo permanece')
})

Deno.test('hotfix1 estimativa parcial usa o preço do teto e não o ultrapassa', () => {
  const body = { messages: [{ role: 'system', content: 'oi' }, { role: 'user', content: 'campanha' }] }
  const teto = chatSpendCeilingUsd('basico', body)
  const parcial = chatPartialSpendUsd('basico', body, 1, 900, teto)
  assert(parcial > 0 && parcial < teto, `${parcial} contra ${teto}`)
  eq(chatPartialSpendUsd('basico', body, 1, 900, 0.000001), 0.000001, 'limitada à reserva')
  eq(chatPartialSpendUsd('basico', body, 0, 0, teto), 0, 'sem tentativa enviada e sem texto fica em zero')
})

Deno.test('hotfix1b sem créditos: Q14 e S-15 saem fora_da_base e não reservam', async () => {
  const casos: Array<[string, string, string[], string]> = [
    ['Q14', Q14, [], 'Odebrecht não está na base do atlas.'],
    ['S-15', S15, SELECAO, 'Não encontrei isso na base do atlas.'],
  ]
  for (const [nome, mensagem, entidades, mensagemErro] of casos) {
    const store = bancoDe(MAPA)
    store.setUsed(USER, 20)
    const modelo = cliente()
    const { httpStatus, events } = await pedir(store, mensagem, entidades, modelo.openrouter)
    const erro = erroDe(events)
    eq(modelo.chamadas(), 0, `${nome}: sem modelo`)
    eq(httpStatus, 200, `${nome}: status`)
    eq(erro.code, 'fora_da_base', `${nome}: código`)
    eq(erro.message, mensagemErro, `${nome}: mensagem`)
    const saldo = store.snapshot(USER, CLOCK())
    eq(saldo.reserveCalls, 0, `${nome}: não reserva crédito`)
    eq(saldo.releaseCalls, 0, `${nome}: não devolve`)
    eq(saldo.used, 20, `${nome}: cota intacta`)
    eq(saldo.reserved, 0, `${nome}: sem hold de crédito`)
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, `${nome}: sem hold de orçamento`)
  }
})

Deno.test('hotfix1b oração respondível antes da ligação com ausente vai ao modelo', async () => {
  const mensagem = 'O que a Rockefeller financiou no Brasil? Qual a relação com a Odebrecht?'
  const recorte = MAPA['|rockefeller foundation']
  assert(recorte, 'recorte da fundação')
  const store = createMemoryDb({ clock: CLOCK })
  store.chatContext = async (_ids, query) => {
    const q = (query ?? '').toLowerCase()
    if (q === 'odebrecht' || q === 'familia odebrecht') return vazio()
    if (q.includes('rockefeller')) return JSON.parse(JSON.stringify(recorte)) as ChatContextPayload
    return vazio()
  }
  const modelo = cliente()
  await pedir(store, mensagem, [], modelo.openrouter)
  eq(modelo.chamadas(), 1, 'a primeira oração é respondível')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 1, 'segue e reserva')
})

Deno.test('hotfix1b seleção: quando vai ao modelo; explique uma receita recusa', async () => {
  const casos: Array<[string, string, number]> = [
    ['quando', 'quando começaram as atividades?', 1],
    ['explique', 'explique uma receita de bolo', 0],
  ]
  for (const [nome, mensagem, chamadas] of casos) {
    const store = bancoDe(MAPA)
    const modelo = cliente()
    const { events } = await pedir(store, mensagem, SELECAO, modelo.openrouter)
    eq(modelo.chamadas(), chamadas, `${nome}: chamadas`)
    if (chamadas === 0) {
      const erro = erroDe(events)
      eq(erro.code, 'fora_da_base', `${nome}: código`)
      eq(erro.message, 'Não encontrei isso na base do atlas.', `${nome}: mensagem`)
      eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, `${nome}: não reserva`)
    }
  }
})

Deno.test('hotfix1b JSON truncado irrecuperável repete uma vez dentro do prazo', async () => {
  const irrecuperavel = '{"blocos":[{"tipo":"documentado","texto":"O contrato de 1936","entidades":[,"casa_ms"],"relacoes":["E150"],"fontes":["B01"]},{"tipo":"documentado","texto":"corte'
  const bom = JSON.stringify({
    blocos: [{ tipo: 'documentado', texto: 'O contrato de 1936 aproximou as casas.', entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'] }],
    sem_base: false,
    em_aberto: null,
  })
  const inicio = 1_700_000_000_000
  const store = bancoFixo(campanhaCtx())
  const prepared = await prepareChat({
    userId: USER, body: { mensagem: 'qual a relacao da campanha?', contexto: { entidades: [] }, modelo: 'basico' },
    db: store, clock: CLOCK, inferenceKey: key(),
  })
  if (!prepared.ok) throw new Error(`prepare: ${JSON.stringify(prepared.event)}`)
  const emitted: ChatSseEvent[] = []
  let chamadas = 0
  await streamPrepared({
    prepared, db: store, startedAt: inicio, now: () => inicio + 1_000,
    openrouter: { async *stream() {
      const raw = chamadas === 0 ? irrecuperavel : bom
      chamadas += 1
      yield { delta: raw }
    } },
    signal: new AbortController().signal,
    emit: (event) => emitted.push(event),
  })
  eq(chamadas, 2, 'irrecuperável abre a segunda tentativa')
  const final = emitted.find((event) => event.event === 'final')
  assert(final && final.event === 'final', 'a segunda tentativa fecha')
  assert(final.data.blocos.some((bloco) => bloco.texto.includes('1936')), 'texto da segunda')
})

Deno.test('hotfix1b primeira tentativa sem cost soma a estimativa parcial', async () => {
  const primeira = '{"blocos":[{"tipo":"documentado","texto":"O contrato de 1936","entidades":[,"casa_ms"],"relacoes":["E150"],"fontes":["B01"]},{"tipo":"x"'
  const bom = JSON.stringify({
    blocos: [{ tipo: 'documentado', texto: 'O contrato de 1936 aproximou as casas.', entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'] }],
    sem_base: false,
    em_aberto: null,
  })
  const inicio = 1_700_000_000_000
  const store = bancoFixo(campanhaCtx())
  const prepared = await prepareChat({
    userId: USER, body: { mensagem: 'qual a relacao da campanha?', contexto: { entidades: [] }, modelo: 'basico' },
    db: store, clock: CLOCK, inferenceKey: key(),
  })
  if (!prepared.ok) throw new Error(`prepare: ${JSON.stringify(prepared.event)}`)
  const orcamento = espiar(store)
  let chamadas = 0
  await streamPrepared({
    prepared, db: store, startedAt: inicio, now: () => inicio + 1_000,
    openrouter: { async *stream() {
      chamadas += 1
      if (chamadas === 1) {
        yield { delta: primeira }
        return
      }
      yield { delta: bom, usage: { prompt_tokens: 11, completion_tokens: 20, cost: 0.0002 } }
    } },
    signal: new AbortController().signal,
    emit: () => {},
  })
  const parcial = chatPartialSpendUsd('basico', prepared.requestBody, 1, primeira.length, prepared.estimate)
  eq(chamadas, 2, 'segunda tentativa com custo')
  assert(parcial > 0 && parcial < prepared.estimate, `parcial ${parcial} fora de (0, ${prepared.estimate})`)
  eq(orcamento.commits.length, 1, 'um commit')
  eq(orcamento.commits[0], parcial + 0.0002, 'parcial da primeira mais o cost da segunda')
  eq(store.snapshot(USER, CLOCK()).logs[0]?.custo_usd, parcial + 0.0002, 'log soma os dois')
})
