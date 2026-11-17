// Hotfix1 da v17: recusa antes do modelo, custo parcial, CJK, ortografia e prazo do retry.
// A fixture ctx_hotfix1.json é montada (não é captura de produção).
import {
  apelidarRecorte,
  assessInferenceKey,
  buildSystemPrompt,
  CHAT_MAX_TOKENS,
  CHAT_MODEL_PRICE_USD_PER_TOKEN,
  CHAT_OUTPUT_USD_PER_TOKEN,
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
      repetirCurto: false,
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

const INICIO_1C = 1_700_000_000_000

function docCampanha(texto: string) {
  return { tipo: 'documentado', texto, entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'] }
}

function finalDe(events: ChatSseEvent[]) {
  const event = events.find((item) => item.event === 'final')
  assert(event && event.event === 'final', `sem final: ${events.map((item) => item.event).join(',')}`)
  return event.data
}

async function rodarModelo(opts: {
  modelo?: 'basico' | 'avancado'
  mensagem?: string
  entidades?: string[]
  ctx?: ChatContextPayload
  agora?: number
  store?: MemoryChatDb
  respostas: Array<() => AsyncGenerator<{ delta?: string; usage?: { prompt_tokens: number; completion_tokens: number; cost: number } }>>
}) {
  const modelo = opts.modelo ?? 'avancado'
  const store = opts.store ?? bancoFixo(opts.ctx ?? campanhaCtx())
  if (modelo === 'avancado') store.setPaid(USER, 40)
  const prepared = await prepareChat({
    userId: USER,
    body: { mensagem: opts.mensagem ?? 'qual a relacao da campanha?', contexto: { entidades: opts.entidades ?? [] }, modelo },
    db: store, clock: CLOCK, inferenceKey: key(),
  })
  if (!prepared.ok) throw new Error(`prepare: ${JSON.stringify(prepared.event)}`)
  const orcamento = espiar(store)
  const emitted: ChatSseEvent[] = []
  const corpos: Record<string, unknown>[] = []
  let chamadas = 0
  await streamPrepared({
    prepared, db: store, startedAt: INICIO_1C, now: () => INICIO_1C + (opts.agora ?? 5_000),
    openrouter: { async *stream(input: { body: Record<string, unknown> }) {
      corpos.push(input.body)
      const gerar = opts.respostas[Math.min(chamadas, opts.respostas.length - 1)]
      chamadas += 1
      yield* gerar()
    } },
    signal: new AbortController().signal,
    emit: (event) => emitted.push(event),
    repetirCurto: true,
  })
  return { store, prepared, orcamento, emitted, corpos, chamadas }
}

function gerar(delta: string, cost: number) {
  return async function* () {
    yield { delta, usage: { prompt_tokens: 11, completion_tokens: 20, cost } }
  }
}

Deno.test('hotfix1c cada tentativa entra na soma: cost, noCharge e parse', async () => {
  const primeira = JSON.stringify({ blocos: [docCampanha('O contrato de 1936 aproximou as casas.')], sem_base: false, em_aberto: null })
  const noCharge = await rodarModelo({
    respostas: [
      gerar(primeira, 0.0002),
      async function* () { throw new OpenRouterError('rede', 'sem cobranca', true) },
    ],
  })
  eq(noCharge.chamadas, 2, 'a segunda noCharge chega a abrir')
  eq(noCharge.orcamento.commits.length, 1, 'um commit')
  eq(noCharge.orcamento.commits[0], 0.0002, 'noCharge soma zero')
  eq(noCharge.store.snapshot(USER, CLOCK()).logs[0]?.custo_usd, 0.0002, 'log igual ao cost da primeira')
  eq(finalDe(noCharge.emitted).custo_real, 0.0002, 'custo_real igual')
  assert(finalDe(noCharge.emitted).blocos.some((bloco) => bloco.texto.includes('1936')), 'fica o texto da primeira')

  const melhor = JSON.stringify({
    blocos: [docCampanha('Um.'), docCampanha('Dois.'), docCampanha('O contrato de 1936 fechou.')],
    sem_base: false, em_aberto: null,
  })
  const soma = await rodarModelo({
    respostas: [gerar(primeira, 0.0002), gerar(melhor, 0.0003)],
  })
  eq(soma.chamadas, 2, 'duas tentativas com cost')
  eq(soma.orcamento.commits[0], 0.0002 + 0.0003, 'soma os dois costs')
  eq(soma.store.snapshot(USER, CLOCK()).logs[0]?.custo_usd, 0.0002 + 0.0003, 'log soma')
  eq(finalDe(soma.emitted).custo_real, 0.0002 + 0.0003, 'custo_real soma')
  assert(finalDe(soma.emitted).blocos.some((bloco) => bloco.texto.includes('fechou')), 'a segunda, com mais parágrafos, fica')

  const pior = JSON.stringify({ blocos: [docCampanha('Texto pior sem o ano.')], sem_base: false, em_aberto: null })
  const guarda = await rodarModelo({
    respostas: [gerar(primeira, 0.0002), gerar(pior, 0.0003)],
  })
  eq(guarda.orcamento.commits[0], 0.0002 + 0.0003, 'soma mesmo quando a segunda não melhora')
  eq(finalDe(guarda.emitted).custo_real, 0.0002 + 0.0003, 'custo_real da soma')
  assert(finalDe(guarda.emitted).blocos.some((bloco) => bloco.texto.includes('1936')), 'fica a primeira')
  assert(!finalDe(guarda.emitted).blocos.some((bloco) => bloco.texto.includes('pior')), 'a segunda sai')

  const tres = JSON.stringify({
    blocos: [docCampanha('Um.'), docCampanha('Dois.'), docCampanha('Três.')],
    sem_base: false, em_aberto: null,
  })
  const unica = await rodarModelo({
    respostas: [gerar(tres, 0.0002)],
  })
  eq(unica.chamadas, 1, 'três parágrafos são uma tentativa')
  eq(unica.orcamento.commits[0], 0.0002, 'orçamento igual ao usage.cost')
  eq(unica.store.snapshot(USER, CLOCK()).logs[0]?.custo_usd, 0.0002, 'log igual ao usage.cost')
  eq(finalDe(unica.emitted).custo_real, 0.0002, 'custo_real igual ao usage.cost')

  const parse = await rodarModelo({
    modelo: 'basico', agora: 30_000,
    respostas: [gerar('não é json {', 0.0002)],
  })
  eq(parse.chamadas, 1, 'parse aos 30s não repete')
  eq(erroDe(parse.emitted).code, 'modelo_indisponivel', 'parse inválido')
  eq(parse.orcamento.commits[0], 0.0002, 'commit não troca o cost pela estimativa')
  eq(parse.store.snapshot(USER, CLOCK()).logs[0]?.custo_usd, 0.0002, 'log depois do parse mantém o cost')
})

Deno.test('hotfix1c estimativa parcial do Avançado usa o preço de lista', () => {
  const body = { blob: 'x'.repeat(25000) }
  const parcial = chatPartialSpendUsd('avancado', body, 1, 6000, 1)
  assert(parcial < 0.02, `estimativa ${parcial} passou de 0,02`)
  eq(parcial, 0.003238, 'ceil(bytes/4)×0,0000000699 + ceil(chars/3)×0,0000014')
  eq(chatPartialSpendUsd('avancado', body, 1, 6000, 0.001), 0.001, 'continua limitada à reserva')
})

Deno.test('hotfix1c Q14 é por pedido: coordenada e imperativo vão ao modelo', async () => {
  const recorte = MAPA['|rockefeller foundation']
  assert(recorte, 'recorte da fundação')
  const casos: Array<[string, string, number]> = [
    ['coordenada', 'Qual a relação com a Odebrecht e o que a Rockefeller financiou no Brasil?', 1],
    ['imperativo', 'Explique o que a Rockefeller fez em 1916. Qual a relação da Odebrecht com a Rockefeller?', 1],
    ['Q14', Q14, 0],
  ]
  for (const [nome, mensagem, chamadas] of casos) {
    const store = createMemoryDb({ clock: CLOCK })
    store.chatContext = async (_ids, query) => {
      const q = (query ?? '').toLowerCase()
      if (q === 'odebrecht' || q === 'familia odebrecht') return vazio()
      if (q.includes('rockefeller')) return JSON.parse(JSON.stringify(recorte)) as ChatContextPayload
      return vazio()
    }
    const modelo = cliente()
    const { events } = await pedir(store, mensagem, [], modelo.openrouter)
    eq(modelo.chamadas(), chamadas, `${nome}: chamadas`)
    if (chamadas === 0) eq(erroDe(events).message, 'Odebrecht não está na base do atlas.', `${nome}: recusa`)
  }
})

Deno.test('hotfix1c seleção: vocabulário do atlas vai ao modelo; bolo continua fora', async () => {
  const casos: Array<[string, string, number]> = [
    ['vínculo', 'Qual o vínculo direto?', 1],
    ['financiadores', 'Quais foram os financiadores?', 1],
    ['quando', 'quando começaram as atividades?', 1],
    ['S-15', S15, 0],
    ['bolo', 'explique uma receita de bolo', 0],
  ]
  for (const [nome, mensagem, chamadas] of casos) {
    const store = bancoDe(MAPA)
    const modelo = cliente()
    const { events } = await pedir(store, mensagem, SELECAO, modelo.openrouter)
    eq(modelo.chamadas(), chamadas, `${nome}: chamadas`)
    if (chamadas === 0) eq(erroDe(events).code, 'fora_da_base', `${nome}: recusa`)
  }
})

Deno.test('hotfix1c pauta: gancho com CJK sai depois da resposta e o fato fica', async () => {
  const linhas: string[] = []
  const prev = console.info
  console.info = (...args: unknown[]) => { linhas.push(args.map((item) => String(item)).join(' ')) }
  try {
    const raw = JSON.stringify({
      titulos: ['Campanha 介入 de 1916'],
      pergunta: 'Quem pagou o contrato?',
      blocos: [],
      sem_base: false,
    })
    const r = await rodarModelo({
      modelo: 'basico',
      mensagem: 'sugira um tema de investigação sobre a campanha',
      respostas: [gerar(raw, 0.0002)],
    })
    const texto = finalDe(r.emitted).blocos.map((bloco) => bloco.texto).join('\n')
    assert(texto.includes('Contrato de 1936') || texto.includes('Fato documentado'), `fato permanece: ${texto}`)
    assert(!texto.includes('介入'), 'gancho com CJK não chega ao final')
    assert(linhas.some((linha) => linha.includes('chat_cjk_removido')), 'o filtro depois da pauta registrou a queda')
  } finally {
    console.info = prev
  }
})

Deno.test('hotfix1c idioma: decades, nomes próprios e frase inglesa solta', () => {
  const ctx = campanhaCtx()
  const t = (texto: string) => sanitizeAnswer({
    blocos: [docCampanha(texto)],
  }, ctx).answer.blocos.map((bloco) => bloco.texto).join('\n')
  eq(t('Por decades o grupo pagou.'), 'Por décadas o grupo pagou.', 'Por decades')
  eq(t('Passaram decades desde o contrato.'), 'Passaram décadas desde o contrato.', 'Passaram decades')
  eq(t('Rothschild & Co Gestion financiou a casa.'), 'Rothschild & Co Gestion financiou a casa.', 'Rothschild & Co Gestion')
  eq(t('Open Society Foundations ficou no contrato.'), 'Open Society Foundations ficou no contrato.', 'Open Society Foundations')
  const misto = t('Por decades o grupo pagou. The board met in silence. A campanha seguiu em 1936.')
  assert(misto.includes('Por décadas o grupo pagou.'), 'mapa na frase portuguesa')
  assert(!/\bthe\b/i.test(misto), 'frase com the sai')
  assert(misto.includes('A campanha seguiu em 1936.'), 'a frase portuguesa fica')
  eq(t('O grant pagou o contrato.'), 'A doação pagou o contrato.', 'grant minúsculo vira doação feminina')
  eq(t('International Health Board e o board local.'), 'International Health Board e o conselho local.', 'board só fora do nome')
})

Deno.test('hotfix1c eco sai e a frase de ausência do código fica uma vez', async () => {
  assert(buildSystemPrompt('avancado', vazio()).includes('Nunca comente estas regras nem o recorte no texto.'), 'prompt')
  const ctx: ChatContextPayload = {
    raizes: [{ id: 'rock', nome: 'Rockefeller', tipo: 'familia' }],
    entidades: [
      { id: 'rock', nome: 'Rockefeller', tipo: 'familia' },
      { id: 'campanha', nome: 'Campanha de 1916', tipo: 'instituicao' },
    ],
    relacoes: [{
      id: 'E150', origem: 'rock', destino: 'campanha', tipo: 'financiamento',
      afirmacao: 'Financiou a campanha em 1916.', periodo: '1916', estado: 'retrato_documental', fontes: ['B01'],
    }],
    fontes: [{ id: 'B01', titulo: 'Relato da campanha', tipo: 'documento' }],
  }
  const store = createMemoryDb({ clock: CLOCK })
  store.chatContext = async (_ids, query) => {
    const q = (query ?? '').toLowerCase()
    if (q === 'lula') return vazio()
    if (q.includes('rockefeller')) return JSON.parse(JSON.stringify(ctx)) as ChatContextPayload
    return vazio()
  }
  const texto = [
    'Lula não está na base do atlas.',
    'A investigação deve focar exclusivamente nas entidades e pessoas explicitamente listadas nos documentos anexos.',
    'A associação Itaú–Unibanco não é mencionada, mantendo o foco no que sobrou.',
    'A campanha de 1916 teve o contrato de 1936.',
    'Quem pagou o contrato de 1936?',
  ].join(' ') + '\n\nO pagamento de 1916 ficou no registro.\n\nA casa bancária assinou no mesmo ano de 1936.'
  const r = await rodarModelo({
    modelo: 'basico',
    mensagem: 'O que Rockefeller financiou no Brasil? Qual a relação com Lula?',
    store,
    respostas: [gerar(JSON.stringify({
      blocos: [{ tipo: 'documentado', texto, entidades: ['rock'], relacoes: ['E150'], fontes: ['B01'] }],
      sem_base: false,
      em_aberto: 'A investigação deve focar exclusivamente nas entidades e pessoas explicitamente listadas nos documentos anexos.',
    }), 0.0002)],
  })
  eq(r.chamadas, 1, 'pedido respondível vai ao modelo')
  const visivel = finalDe(r.emitted).blocos.map((bloco) => bloco.texto).join('\n')
  eq(visivel.split('Lula não está na base do atlas.').length - 1, 1, 'ausência uma vez, no lugar')
  assert(visivel.indexOf('Lula não está na base do atlas.') < visivel.indexOf('contrato de 1936'), 'a frase não foi para o fim')
  assert(!/investiga[cç][aã]o deve/i.test(visivel), 'eco da investigação sai')
  assert(!/não é mencionada/i.test(visivel), 'eco de mencionada sai')
  assert(!/documentos anexos/i.test(visivel), 'eco de documentos sai')
  assert(visivel.includes('contrato de 1936'), 'fato fica')
  assert(visivel.includes('Quem pagou o contrato de 1936?'), 'a pergunta final válida substitui o eco')
})

Deno.test('hotfix1c Avançado com poucos parágrafos repete só dentro do prazo', async () => {
  const um = JSON.stringify({ blocos: [docCampanha('O contrato de 1936 aproximou as casas.')], sem_base: false, em_aberto: null })
  const tres = JSON.stringify({
    blocos: [docCampanha('Um.'), docCampanha('Dois.'), docCampanha('O contrato de 1936 fechou.')],
    sem_base: false, em_aberto: null,
  })
  const cedo = await rodarModelo({
    agora: 5_000,
    respostas: [gerar(um, 0.0002), gerar(tres, 0.0003)],
  })
  eq(cedo.chamadas, 2, '1 bloco aos 5s abre a segunda')
  eq(cedo.corpos[1]?.temperature, 0.5, 'temperature 0.5')
  eq(cedo.corpos[1]?.seed, 7, 'seed 7')
  eq(cedo.orcamento.commits[0], 0.0002 + 0.0003, 'custo das duas')
  assert(finalDe(cedo.emitted).blocos.some((bloco) => bloco.texto.includes('fechou')), 'usa a segunda')

  const tarde = await rodarModelo({
    agora: 30_000,
    respostas: [gerar(um, 0.0002), gerar(tres, 0.0003)],
  })
  eq(tarde.chamadas, 1, '1 bloco aos 30s não repete')
  eq(tarde.orcamento.commits[0], 0.0002, 'só o cost da única tentativa')

  const basico = await rodarModelo({
    modelo: 'basico', agora: 5_000,
    respostas: [gerar(um, 0.0002), gerar(tres, 0.0003)],
  })
  eq(basico.chamadas, 2, 'Básico com 1 bloco repete uma vez')
  eq(basico.orcamento.commits[0], 0.0002 + 0.0003, 'Básico curto soma as duas')

  const paragrafos = JSON.stringify({
    blocos: [docCampanha('Um parágrafo do contrato.\n\nDois do grupo.\n\nTrês e o fim de 1936.')],
    sem_base: false, em_aberto: null,
  })
  const cheio = await rodarModelo({
    agora: 5_000,
    respostas: [gerar(paragrafos, 0.0002), gerar(tres, 0.0003)],
  })
  eq(cheio.chamadas, 1, 'um bloco com 3 parágrafos não repete')
  eq(cheio.orcamento.commits[0], 0.0002, 'usage.cost da tentativa única')
})

function sistemaDe(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined
  return messages?.find((item) => item.role === 'system')?.content ?? ''
}

function ctxR3(): ChatContextPayload {
  const raizes = [
    { id: 'walther_ms', nome: 'Walther Moreira Salles', tipo: 'pessoa' },
    { id: 'ibec', nome: 'Instituto Brasileiro (IBEC)', tipo: 'instituicao' },
    { id: 'nelson_rockefeller', nome: 'Nelson Rockefeller', tipo: 'pessoa' },
  ]
  const extras = Array.from({ length: 9 }, (_, i) => ({
    id: `aux_${i}`, nome: `Auxiliar ${i} do registro`, tipo: 'instituicao',
  }))
  return {
    raizes, entidades: [...raizes, ...extras],
    relacoes: [{
      id: 'REL_W', origem: 'walther_ms', destino: 'ibec', tipo: 'cargo',
      afirmacao: 'Walther presidiu o IBEC.', periodo: '1952', estado: 'retrato_documental', fontes: ['FONTE_W'],
    }],
    fontes: [{ id: 'FONTE_W', titulo: 'Relatório do IBEC', tipo: 'documento' }],
  }
}

Deno.test('hotfix1d preço de lista do DeepSeek cabe no teto do Básico', () => {
  eq(CHAT_MODEL_PRICE_USD_PER_TOKEN.basico.prompt, 0.000000036, 'prompt de lista')
  eq(CHAT_MODEL_PRICE_USD_PER_TOKEN.basico.completion, 0.0000005, 'completion de lista')
  assert(CHAT_MODEL_PRICE_USD_PER_TOKEN.basico.completion <= CHAT_OUTPUT_USD_PER_TOKEN.basico, 'saída de lista ≤ teto')
  assert(CHAT_MODEL_PRICE_USD_PER_TOKEN.basico.prompt <= CHAT_OUTPUT_USD_PER_TOKEN.basico, 'entrada de lista ≤ teto')
  eq(CHAT_MAX_TOKENS.basico, 2600, 'max_tokens do Básico')
  eq(CHAT_RETRY_DEADLINE_MS, 25_000, 'prazo de 25s')
})

Deno.test('hotfix1d R3 traduz slug e R13/F14 numa chamada', async () => {
  const ctx = ctxR3()
  const mapa = apelidarRecorte(ctx).idPorNumero
  eq(mapa['13'], 'REL_W', 'relação no apelido 13')
  eq(mapa['14'], 'FONTE_W', 'fonte no apelido 14')
  const bloco = (texto: string) => ({
    tipo: 'documentado', texto,
    entidades: ['walther_ms', 'ibec', 'nelson_rockefeller'],
    relacoes: ['R13'], fontes: ['F14'],
  })
  const cru = JSON.stringify({
    blocos: [
      bloco('Walther Moreira Salles presidiu o IBEC.'),
      bloco('O IBEC recebeu o aporte de Nelson Rockefeller.'),
      bloco('O contrato ligou as duas casas no mesmo ano.'),
      bloco('A diretoria registrou o cargo no relatório.'),
      bloco('O grupo manteve o vínculo no período seguinte.'),
      bloco('O fechamento do caso cita as três partes.'),
    ],
    sem_base: false, em_aberto: null,
  })
  const r = await rodarModelo({ ctx, agora: 5_000, respostas: [gerar(cru, 0.0002), gerar(cru, 0.0003)] })
  eq(r.chamadas, 1, 'slug e rótulo viram id na primeira chamada')
  const texto = finalDe(r.emitted).blocos.map((item) => item.texto).join('\n')
  assert(texto.includes('IBEC'), 'texto do modelo fica')
  const doc = finalDe(r.emitted).blocos.find((item) => item.tipo === 'documentado')
  assert(doc && doc.tipo === 'documentado', 'bloco documentado')
  assert(doc.entidades.includes('walther_ms') && doc.entidades.includes('ibec'), 'entidades reais')
  assert(doc.relacoes.includes('REL_W'), 'R13 virou a relação')
  assert(doc.fontes.includes('FONTE_W'), 'F14 virou a fonte')
  eq(r.orcamento.commits[0], 0.0002, 'uma liquidação')
})

Deno.test('hotfix1d sem id reconhecível repete ou monta o recorte', async () => {
  const semNome = JSON.stringify({
    blocos: [
      { tipo: 'documentado', texto: 'O pagamento ocorreu no ano citado pelo registro.', entidades: ['zzz_sem_nome'], relacoes: ['zzz_sem_nome'], fontes: ['zzz_sem_nome'] },
      { tipo: 'documentado', texto: 'O segundo parágrafo também não cita entidade alguma.', entidades: ['yyy_sem_nome'], relacoes: ['yyy_sem_nome'], fontes: ['yyy_sem_nome'] },
    ],
    sem_base: false, em_aberto: null,
  })
  const cedo = await rodarModelo({
    agora: 5_000,
    respostas: [gerar(semNome, 0.0002), gerar(semNome, 0.0003)],
  })
  eq(cedo.chamadas, 2, 'aos 5s abre uma repetição')
  assert(sistemaDe(cedo.corpos[1]).includes('Cite só os apelidos [n] do recorte nos campos entidades/relacoes/fontes.'), 'lembrete no system')
  eq(cedo.corpos[1]?.temperature, cedo.corpos[0]?.temperature, 'mesmo corpo, sem temperature nova')
  assert(!cedo.emitted.some((event) => event.event === 'error'), 'não recusa')
  assert(finalDe(cedo.emitted).blocos.some((bloco) => bloco.texto.includes('Contrato de 1936')), 'cai no recorte')
  eq(cedo.orcamento.commits[0], 0.0005, 'soma as duas')

  const tarde = await rodarModelo({
    agora: 30_000,
    respostas: [gerar(semNome, 0.0002), gerar(semNome, 0.0009)],
  })
  eq(tarde.chamadas, 1, 'aos 30s não repete')
  assert(!tarde.emitted.some((event) => event.event === 'error'), 'nunca fora_da_base')
  assert(finalDe(tarde.emitted).blocos.some((bloco) => bloco.texto.includes('Contrato de 1936')), 'resposta documental')
  eq(tarde.orcamento.commits[0], 0.0002, 'só a tentativa feita')
})

Deno.test('hotfix1d custo por tentativa, teto de chamadas e JSON ruim devolve a primeira', async () => {
  const um = JSON.stringify({ blocos: [docCampanha('O contrato de 1936 aproximou as casas.')], sem_base: false, em_aberto: null })
  const zero = await rodarModelo({
    agora: 0,
    respostas: [
      gerar(um, 0),
      async function* () { throw new OpenRouterError('rede', 'sem cobranca', true) },
    ],
  })
  eq(zero.chamadas, 2, 'a segunda noCharge abre')
  eq(zero.orcamento.commits[0], 0, 'cost 0 mais noCharge liquida 0')
  assert(finalDe(zero.emitted).blocos.some((bloco) => bloco.texto.includes('1936')), 'fica a primeira')

  const pago = await rodarModelo({
    agora: 0,
    respostas: [
      gerar(um, 0.0002),
      async function* () { throw new OpenRouterError('rede', 'caiu sem texto', false) },
    ],
  })
  const potencial = chatPartialSpendUsd('avancado', pago.corpos[1], 1, 0, pago.prepared.estimate)
  eq(pago.chamadas, 2, 'erro da segunda chega a abrir')
  eq(pago.orcamento.commits[0], Math.min(pago.prepared.estimate, 0.0002 + potencial), 'soma o potencial da tentativa sem texto')
  assert(finalDe(pago.emitted).blocos.some((bloco) => bloco.texto.includes('1936')), 'texto da primeira sobrevive ao erro')

  const ruim = await rodarModelo({
    agora: 0,
    respostas: [gerar(um, 0.0002), gerar('não é json {', 0.0003)],
  })
  eq(ruim.chamadas, 2, 'JSON irrecuperável é a segunda chamada')
  eq(ruim.orcamento.commits[0], 0.0005, 'soma os dois costs')
  assert(finalDe(ruim.emitted).blocos.some((bloco) => bloco.texto.includes('1936')), 'devolve a primeira')
  assert(!finalDe(ruim.emitted).blocos.some((bloco) => bloco.texto.includes('não é json')), 'o lixo sai')

  const teto = await rodarModelo({
    agora: 0,
    respostas: [
      gerar(um, 0.0002),
      async function* () { throw new OpenRouterError('modelo_ocupado', '429', true) },
      async function* () { throw new OpenRouterError('modelo_ocupado', '429', true) },
    ],
  })
  eq(teto.chamadas, 2, 'poucos blocos mais 429 não passa de duas chamadas')
  eq(teto.orcamento.commits[0], 0.0002, '429 noCharge não soma custo')
  assert(teto.orcamento.commits[0] <= teto.prepared.estimate, 'liquidação dentro da reserva')
  assert(finalDe(teto.emitted).blocos.some((bloco) => bloco.texto.includes('1936')), 'fica a resposta válida')

  const instantaneo = await rodarModelo({
    agora: 0,
    respostas: [gerar(um, 0.0002), gerar(JSON.stringify({
      blocos: [docCampanha('Um.'), docCampanha('Dois.'), docCampanha('O contrato de 1936 fechou.')],
      sem_base: false, em_aberto: null,
    }), 0.0003)],
  })
  eq(instantaneo.chamadas, 2, '1 bloco aos 0ms abre a segunda')
})

Deno.test('hotfix1d seleção genérica vai ao modelo; receita continua fora', async () => {
  const casos: Array<[string, string, number]> = [
    ['contrato', 'Explique o contrato detalhadamente', 1],
    ['fatos', 'Quais os principais fatos?', 1],
    ['eles', 'resuma isso sobre eles', 1],
    ['acontecimentos', 'Analise os acontecimentos', 1],
    ['cronologia', 'Faça uma síntese cronológica', 1],
    ['linha', 'Monte a linha do tempo.', 1],
    ['contexto', 'sintetize o contexto', 1],
    ['bolo', 'explique uma receita de bolo', 0],
  ]
  for (const [nome, mensagem, chamadas] of casos) {
    const store = bancoDe(MAPA)
    const modelo = cliente()
    const { events } = await pedir(store, mensagem, SELECAO, modelo.openrouter)
    eq(modelo.chamadas(), chamadas, `${nome}: chamadas`)
    if (chamadas === 0) eq(erroDe(events).message, 'Não encontrei isso na base do atlas.', `${nome}: recusa`)
  }
})

Deno.test('hotfix1d coordenada com quais e imperativo de descrição vão ao modelo', async () => {
  const recorte = MAPA['|rockefeller foundation']
  assert(recorte, 'recorte da fundação')
  const casos = [
    'Qual a relação com a Odebrecht e quais foram as ações da Rockefeller?',
    'Descreva as ações da Rockefeller no Brasil.',
    'Apresente o contrato da Rockefeller e compare os dois registros.',
  ]
  for (const mensagem of casos) {
    const store = createMemoryDb({ clock: CLOCK })
    store.chatContext = async (_ids, query) => {
      const q = (query ?? '').toLowerCase()
      if (q === 'odebrecht' || q === 'familia odebrecht') return vazio()
      if (q.includes('rockefeller')) return JSON.parse(JSON.stringify(recorte)) as ChatContextPayload
      return vazio()
    }
    const modelo = cliente()
    await pedir(store, mensagem, [], modelo.openrouter)
    eq(modelo.chamadas(), 1, mensagem)
  }
})

Deno.test('hotfix1d idioma, ficha, URL, nome e anáfora', () => {
  const ctx = campanhaCtx()
  ctx.fontes.push({ id: 'FICHA', titulo: 'Ficha de filiação sindical', tipo: 'documento' })
  const t = (texto: string) => sanitizeAnswer({
    blocos: [docCampanha(texto)],
  }, ctx).answer.blocos.map((bloco) => bloco.texto).join('\n')
  eq(t('O "funding loan" pagou o contrato.'), 'O "funding loan" pagou o contrato.', 'funding loan entre aspas fica')
  eq(t('O "ownership and management" da casa.'), 'O "ownership and management" da casa.', 'ownership entre aspas fica')
  eq(t('O funding loan pagou o contrato.'), 'O empréstimo de consolidação pagou o contrato.', 'funding loan solto')
  eq(t('O financiamento loan pagou.'), 'O empréstimo pagou.', 'financiamento loan')
  eq(t('O loan pagou o contrato.'), 'O empréstimo pagou o contrato.', 'loan')
  eq(t('Um grant pago fechou o contrato.'), 'Uma doação paga fechou o contrato.', 'um grant pago')
  eq(t('Os grants pagos fecharam o contrato.'), 'As doações pagas fecharam o contrato.', 'grants pagos')
  eq(t('A doação pago ficou no contrato.'), 'A doação paga ficou no contrato.', 'doação pago')
  eq(t('O ownership and management da casa.'), 'O controle e gestão da casa.', 'ownership and management')
  eq(t('O owner do bond e do trust pagou.'), 'O dono do título e do fundo fiduciário pagou.', 'owner bond trust')
  eq(t('Bill and Melinda Gates pagaram o contrato de 1936.'), 'Bill and Melinda Gates pagaram o contrato de 1936.', 'and entre nomes')
  eq(t('O National Science Board pagou o contrato.'), 'O National Science Board pagou o contrato.', 'National Science Board')
  eq(t('Rothschild & Co Gestion, Open Society Foundations e International Health Board ficaram.'), 'Rothschild & Co Gestion, Open Society Foundations e International Health Board ficaram.', 'nomes intactos')
  const url = t('O contrato de 1936 está em https://example.com/about/the/board e segue.')
  assert(url.includes('https://example.com/about/the/board'), 'URL intacta')
  assert(url.includes('contrato de 1936'), 'frase com URL fica')
  eq(t('Os documentos anexos ao contrato registram o pagamento de 1936.'), 'Os documentos anexos ao contrato registram o pagamento de 1936.', 'anexo ao contrato fica')
  const ficha = t('A ficha de compromisso de 1936 ficou. A Ficha de filiação sindical lista o grupo. A ficha do contrato registra o pagamento OP16. O acordo está na ficha da operação, segundo a ficha, e segue.')
  assert(ficha.includes('ficha de compromisso'), 'ficha de compromisso fica')
  assert(ficha.includes('Ficha de filiação sindical'), 'título da fonte fica')
  assert(ficha.includes('o registro de contrato registra'), 'ficha com código vira registro')
  assert(!/OP16|na ficha da opera|segundo a ficha/i.test(ficha), 'código e locução saem')
  assert(!/  |,\s*,/.test(ficha), 'sem buraco')
  const anafora = sanitizeAnswer({
    blocos: [
      { tipo: 'documentado', texto: 'Frase boa inicial. The board met in silence. Essas duas instituições seguiram juntas.', entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'] },
      { tipo: 'documentado', texto: 'O contrato de 1936 ficou. A casa pagou no mesmo ano.', entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'] },
    ],
  }, ctx).answer.blocos.map((bloco) => bloco.texto).join('\n')
  assert(!anafora.includes('Essas duas'), 'anáfora cai')
  assert(!anafora.includes('Frase boa'), 'bloco com menos de duas frases cai')
  assert(anafora.includes('contrato de 1936'), 'o outro bloco fica')
})

Deno.test('hotfix1d pergunta final e fecho sem insinuação', async () => {
  const prompt = buildSystemPrompt('avancado', vazio())
  const basico = buildSystemPrompt('basico', vazio())
  assert(prompt.includes('A pergunta final só liga nomes que o recorte liga; nunca insinue controle, comando ou financiamento entre entidades sem relação no recorte.'), 'frase antiga do prompt')
  assert(prompt.includes('Não insinue ocultação, culpa, conhecimento prévio de fraude nem quem sabia'), 'prompt sem insinuação')
  assert(prompt.includes('Não afirme o que alguém nunca fez.'), 'prompt sem nunca')
  const regras = [
    'A pergunta final pede só um documento ou detalhe que falta sobre uma relação já citada; nunca sugere ocultação, motivo escondido, contrato, lucro ou culpa.',
    'O parágrafo "O que liga tudo" só junta relações já citadas acima; não cria ligação nova entre entidades.',
    'Fique nas entidades da pergunta; não traga outro caso (ex.: imprensa, outra família, outro país) que a pergunta não pediu.',
  ]
  for (const regra of regras) {
    assert(prompt.includes(regra), regra)
    assert(basico.includes(regra), `básico: ${regra}`)
  }
  const fatos = 'O contrato de 1936 ficou registrado.\n\nA casa bancária pagou no mesmo ano.\n\nO que liga tudo: critérios ocultos de repasse entre as casas.'
  const perguntas = [
    'por que a família Marinho nunca abriu os arquivos internos da casa?',
    'quem dentro do grupo de controle da Americanas sabia do tamanho do buraco?',
    'quem mais recebeu o dinheiro do contrato e ainda não apareceu?',
    'critérios ocultos',
    'Se a agência exclusiva de 1855 subordinou o Império à casa Rothschild, quem dentro do governo brasileiro assinou e sustentou esse contrato, e que termos ficaram fora dos registros oficiais?',
    'Se o BTG acusou os parceiros da 3G em 2023, quem dentro do banco decidiu transformar a mentoria de 2012 em peça judicial contra Lemann?',
    'Se a rede Open Society já repassava dinheiro ao Fundo Brasil em 2021 e 2022, quem dentro do governo brasileiro recebeu a estratégia anunciada em 20/08/2025 e quais contratos ela produziu?',
    'Quem pagou o contrato de 1936?',
  ]
  for (const em_aberto of perguntas) {
    const r = await rodarModelo({
      agora: 5_000,
      respostas: [gerar(JSON.stringify({
        blocos: [docCampanha(fatos)],
        sem_base: false,
        em_aberto,
      }), 0.0002)],
    })
    const visivel = finalDe(r.emitted).blocos.map((bloco) => bloco.texto).join('\n')
    const neutra = em_aberto !== 'Quem pagou o contrato de 1936?'
    if (neutra) assert(/Que outros documentos do atlas detalham a relação entre .+ e .+\?/.test(visivel), em_aberto)
    else assert(visivel.includes('Quem pagou o contrato de 1936?'), 'pergunta factual fica')
    assert(!/nunca abriu|sabia do tamanho|quem mais recebeu|critérios ocultos|não apareceu|fora dos registros|quem dentro do|quais contratos|peça judicial/i.test(visivel), em_aberto)
    assert(visivel.includes('contrato de 1936'), 'fato fica')
    assert(visivel.trimEnd().endsWith('?'), 'fecha com pergunta')
  }
})

Deno.test('hotfix1e insinuação no bloco, par sem aresta e nome inteiro', async () => {
  const bloco = await rodarModelo({
    agora: 30_000,
    respostas: [gerar(JSON.stringify({
      blocos: [docCampanha('O contrato de 1936 ficou registrado. Por que nunca abriu os arquivos? A casa pagou no mesmo ano.')],
      sem_base: false,
      em_aberto: null,
    }), 0.0002)],
  })
  const textoBloco = finalDe(bloco.emitted).blocos.map((item) => item.texto).join('\n')
  assert(!/nunca abriu/i.test(textoBloco), 'frase do bloco sai')
  assert(textoBloco.includes('contrato de 1936'), 'fato do bloco fica')
  assert(textoBloco.includes('A casa pagou'), 'frase seguinte fica')

  const solto = campanhaCtx()
  solto.entidades = [
    { id: 'casa_ms', nome: 'Grupo Alfa', tipo: 'instituicao' },
    { id: 'c1', nome: 'Instituição Beta', tipo: 'instituicao' },
    { id: 'b1', nome: 'Casa B', tipo: 'instituicao' },
    { id: 'd1', nome: 'Casa D', tipo: 'instituicao' },
  ]
  solto.relacoes = [
    { id: 'E1', origem: 'casa_ms', destino: 'b1', afirmacao: 'Contrato de 1936.', estado: 'retrato_documental', fontes: ['B01'] },
    { id: 'E2', origem: 'c1', destino: 'd1', afirmacao: 'Outro registro de 1936.', estado: 'retrato_documental', fontes: ['B01'] },
  ]
  const desligado = await rodarModelo({
    ctx: solto,
    agora: 30_000,
    respostas: [gerar(JSON.stringify({
      blocos: [
        { tipo: 'documentado', texto: 'O contrato de 1936 ficou no grupo.', entidades: ['casa_ms'], relacoes: [], fontes: ['B01'] },
        { tipo: 'documentado', texto: 'O grupo aparece de novo no registro.', entidades: ['casa_ms', 'c1'], relacoes: [], fontes: ['B01'] },
      ],
      sem_base: false,
      em_aberto: 'Por que nunca abriu os arquivos?',
    }), 0.0002)],
  })
  const textoSolto = finalDe(desligado.emitted).blocos.map((item) => item.texto).join('\n')
  assert(textoSolto.includes('Que outros documentos do atlas detalham o papel de Grupo Alfa?'), textoSolto)
  assert(!/Instituição Beta|ligam Grupo Alfa/i.test(textoSolto), 'par sem aresta não entra na pergunta')

  const longo = `${'Campanha Internacional '.repeat(20).trim()}`
  const ctxLongo = campanhaCtx()
  ctxLongo.raizes = [{ id: 'campanha', nome: longo, tipo: 'instituicao' }]
  ctxLongo.entidades = [{ id: 'campanha', nome: longo, tipo: 'instituicao' }]
  ctxLongo.relacoes = []
  const nomeLongo = await rodarModelo({
    ctx: ctxLongo,
    agora: 30_000,
    respostas: [gerar(JSON.stringify({
      blocos: [{ tipo: 'documentado', texto: 'O contrato de 1936 ficou registrado no papel citado.', entidades: ['campanha'], relacoes: [], fontes: ['B01'] }],
      sem_base: false,
      em_aberto: 'Por que nunca abriu os arquivos?',
    }), 0.0002)],
  })
  const textoLongo = finalDe(nomeLongo.emitted).blocos.map((item) => item.texto).join('\n')
  assert(textoLongo.includes(longo), 'nome curto inteiro')
  assert(textoLongo.trimEnd().endsWith('?'), 'não corta a pergunta')
  assert(textoLongo.length > 300, 'sem teto de 300 no meio da palavra')
})

Deno.test('hotfix1e mapa idempotente e citação solta sem buraco', () => {
  const ctx = campanhaCtx()
  const t = (texto: string) => sanitizeAnswer({
    blocos: [docCampanha(texto)],
  }, ctx).answer.blocos.map((bloco) => bloco.texto).join('\n')
  const frases = [
    'O "ownership and management" pagou o contrato.',
    'O "funding loan" pagou o contrato.',
    'O funding loan pagou o contrato.',
    'O ownership and management da casa.',
    'Um grant pago fechou o contrato.',
  ]
  for (const frase of frases) {
    const uma = t(frase)
    eq(t(uma), uma, `idempotente: ${frase}`)
  }
  eq(t('O contrato de 1936 consta em F14 e em R13.'), 'O contrato de 1936 consta.', 'F14 e R13 saem sem buraco')
  eq(t('O acordo está em [2] e em E99.'), 'O acordo está.', 'colchete e E saem sem buraco')
  eq(t('O caça F-16 custou R$ 15 milhões em 1936.'), 'O caça F-16 custou R$ 15 milhões em 1936.', 'valor, F-16 e ano ficam')
  const comSigla = campanhaCtx()
  comSigla.fontes[0].titulo = 'Anexo R13 oficial'
  comSigla.entidades.push({ id: 'prog', nome: 'Programa F14', tipo: 'instituicao' })
  const sigla = sanitizeAnswer({
    blocos: [{ tipo: 'documentado', texto: 'O Programa F14 cita o Anexo R13 oficial em 1936.', entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'] }],
  }, comSigla).answer.blocos.map((bloco) => bloco.texto).join('\n')
  assert(sigla.includes('Programa F14') && sigla.includes('Anexo R13') && sigla.includes('1936'), sigla)
})

Deno.test('hotfix1e custo acima da reserva, parcial depois de zero e um bloco longo', async () => {
  const tres = JSON.stringify({
    blocos: [
      docCampanha('O contrato de 1936 aproximou as casas no primeiro registro.'),
      docCampanha('A casa bancária pagou no mesmo ano citado.'),
      docCampanha('O segundo registro confirma o mesmo contrato de 1936.'),
    ],
    sem_base: false,
    em_aberto: null,
  })
  const store = bancoFixo(campanhaCtx())
  store.setPaid(USER, 40)
  const prepared = await prepareChat({
    userId: USER,
    body: { mensagem: 'qual a relacao da campanha?', contexto: { entidades: [] }, modelo: 'avancado' },
    db: store, clock: CLOCK, inferenceKey: key(),
  })
  if (!prepared.ok) throw new Error('prepare')
  prepared.estimate = 0.132960
  const orcamento = espiar(store)
  const info: string[] = []
  const emitted: ChatSseEvent[] = []
  const prev = console.info
  console.info = (msg?: unknown) => { info.push(String(msg)) }
  try {
    await streamPrepared({
      prepared, db: store, startedAt: INICIO_1C, now: () => INICIO_1C + 5_000,
      openrouter: { async *stream() { yield { delta: tres, usage: { prompt_tokens: 11, completion_tokens: 20, cost: 0.133960 } } } },
      signal: new AbortController().signal,
      emit: (event) => emitted.push(event),
      repetirCurto: true,
    })
  } finally {
    console.info = prev
  }
  eq(orcamento.commits[0], 0.132960, 'commit na reserva')
  eq(finalDe(emitted).custo_real, 0.133960, 'custo_real integral')
  eq(store.snapshot(USER, CLOCK()).logs[0]?.custo_usd, 0.133960, 'log com o real')
  const evento = info.map((linha) => { try { return JSON.parse(linha) as { evento?: string; reserva?: number; real?: number } } catch { return null } })
    .find((item) => item?.evento === 'chat_custo_acima_reserva')
  eq(evento?.reserva, 0.132960, 'evento reserva')
  eq(evento?.real, 0.133960, 'evento real')

  const um = JSON.stringify({ blocos: [docCampanha('O contrato de 1936 aproximou as casas.')], sem_base: false, em_aberto: null })
  const depoisDeZero = await rodarModelo({
    agora: 0,
    respostas: [
      gerar(um, 0),
      async function* () { throw new OpenRouterError('rede', 'sem delta', false) },
    ],
  })
  assert(depoisDeZero.orcamento.commits[0] > 0, `parcial depois de cost 0: ${depoisDeZero.orcamento.commits[0]}`)
  eq(depoisDeZero.store.snapshot(USER, CLOCK()).logs[0]?.custo_usd, depoisDeZero.orcamento.commits[0], 'log acompanha a soma')

  const palavras = ['Contrato', ...Array.from({ length: 59 }, () => 'registrado')].join(' ')
  const longo = await rodarModelo({
    agora: 30_000,
    respostas: [gerar(JSON.stringify({
      blocos: [{ tipo: 'documentado', texto: `${palavras}.`, entidades: ['zzz_sem_nome'], relacoes: ['zzz_sem_nome'], fontes: ['zzz_sem_nome'] }],
      sem_base: false, em_aberto: null,
    }), 0.0002), gerar('{}', 0.0009)],
  })
  eq(longo.chamadas, 1, 'um bloco de 60 palavras aos 30s não repete')
  assert(!longo.emitted.some((event) => event.event === 'error'), 'não é fora_da_base')
  assert(finalDe(longo.emitted).blocos.some((bloco) => bloco.texto.includes('Contrato de 1936')), 'cai no recorte')
})

Deno.test('hotfix1e fallback documental não afirma acusação e guarda limite', async () => {
  const semNome = JSON.stringify({
    blocos: [
      { tipo: 'documentado', texto: 'O pagamento ocorreu no ano citado pelo registro.', entidades: ['zzz_sem_nome'], relacoes: ['zzz_sem_nome'], fontes: ['zzz_sem_nome'] },
      { tipo: 'documentado', texto: 'O segundo parágrafo também não cita entidade alguma.', entidades: ['yyy_sem_nome'], relacoes: ['yyy_sem_nome'], fontes: ['yyy_sem_nome'] },
    ],
    sem_base: false, em_aberto: null,
  })
  const acusacao = campanhaCtx()
  acusacao.entidades.push({ id: 'pessoa_viva', nome: 'Pessoa Fictícia', tipo: 'pessoa' })
  acusacao.relacoes = [{
    id: 'E150', origem: 'casa_ms', destino: 'campanha',
    afirmacao: 'Pessoa Fictícia desviou recursos do contrato.',
    limite: 'Não há prova de participação individual; o texto acima é alegação contestada.',
    fontes: ['B01'],
  }]
  const soAcusacao = await rodarModelo({ ctx: acusacao, agora: 30_000, respostas: [gerar(semNome, 0.0002)] })
  eq(erroDe(soAcusacao.emitted).code, 'fora_da_base', 'sem relação documentada recusa')
  assert(!JSON.stringify(soAcusacao.emitted).includes('desviou'), 'acusação não vira fato')

  const misto = campanhaCtx()
  misto.entidades.push({ id: 'pessoa_viva', nome: 'Pessoa Fictícia', tipo: 'pessoa' })
  misto.relacoes = [
    {
      id: 'E150', origem: 'casa_ms', destino: 'campanha',
      afirmacao: 'Pessoa Fictícia desviou recursos do contrato.',
      limite: 'Não há prova de participação individual; o texto acima é alegação contestada.',
      fontes: ['B01'],
    },
    {
      id: 'E151', origem: 'casa_ms', destino: 'campanha',
      afirmacao: 'Contrato de 1936.',
      estado: 'retrato_documental', confianca: 'alta',
      limite: 'Não quantifica a parte.',
      fontes: ['B01'],
    },
  ]
  const comLimite = await rodarModelo({ ctx: misto, agora: 30_000, respostas: [gerar(semNome, 0.0002)] })
  const texto = finalDe(comLimite.emitted).blocos.map((bloco) => bloco.texto).join('\n')
  assert(texto.includes('Contrato de 1936'), texto)
  assert(texto.includes('confiança alta'), texto)
  assert(texto.includes('Não quantifica a parte.'), texto)
  assert(!texto.includes('desviou'), texto)
})
