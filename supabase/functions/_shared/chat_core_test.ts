import {
  CHAT_COST_ESTIMATE_USD,
  chatSpendCeilingUsd,
  CHAT_LEASE_HOLD_MS,
  CHAT_MODEL_TIMEOUT_MS,
  CHAT_ERROR_STATUS,
  assessInferenceKey,
  boundContextJson,
  buildSystemPrompt,
  type ChatBloco,
  type ChatContextPayload,
  fallbackSemLigacao,
  GENERIC_CONTEXT_TOKENS,
  onlyGenericRootMatch,
  fraseLacunaFaltante,
  perguntaDeLigacao,
  modelRequestBody,
  loadInferenceKeyAssessment,
  type KeyAssessment,
  CHAT_DAILY_BUDGET_USD,
  proveProviderSpend,
  quoteTokenCeilingUsd,
  resolveDailyBudgetUsd,
  worstCatalogRates,
  CHAT_MAX_TOKENS,
  CHAT_TEMPERATURE,
  MODEL_SLUGS,
  OpenRouterError,
  chatErrorMessage,
  exceedsBudget,
  isAllowedOrigin,
  redactSecrets,
  prepareChat,
  runChat,
  sanitizeAnswer,
  streamPrepared,
  saoPauloDay,
  userIdFromAuthorization,
  validateChatBody,
  type ChatDb,
  type ChatFinal,
  type ChatMeta,
  type ChatSseEvent,
  type Modelo,
  type Reservation,
  type OpenRouterChunk,
  type OpenRouterClient,
} from './chat_core.ts'
import { createMemoryDb, type MemoryChatDb } from './memory_db.ts'
import { createFetchOpenRouter, parseOpenRouterBlock } from './openrouter_stream.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const CLOCK = () => new Date('2026-11-05T15:00:00-03:00')
const QUESTION = 'Quais as conexões documentadas de Mauá e suas fontes?'

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n actual=${JSON.stringify(actual)}\n expected=${JSON.stringify(expected)}`)
  }
}

function request(over: Record<string, unknown> = {}) {
  return {
    mensagem: QUESTION,
    contexto: { entidades: ['maua'] },
    modelo: 'basico',
    user_id: OTHER,
    ...over,
  }
}

function answerJson(over: Record<string, unknown> = {}) {
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
    entidades: ['maua'],
    relacoes: ['r1'],
    fontes: ['S1'],
    avisos: [],
    sem_base: false,
    sugestoes: ['Ver a fonte de Mauá'],
    ...over,
  })
}

function scripted(chunks: OpenRouterChunk[] | ((signal: AbortSignal) => AsyncGenerator<OpenRouterChunk>)): {
  client: OpenRouterClient
  calls: Record<string, unknown>[]
} {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    client: {
      async *stream(input) {
        calls.push(input.body)
        if (typeof chunks === 'function') {
          yield* chunks(input.signal)
          return
        }
        for (const chunk of chunks) yield chunk
      },
    },
  }
}

function db(): MemoryChatDb {
  return createMemoryDb({ clock: CLOCK })
}

async function chat(opts: {
  database?: ChatDb
  body?: unknown
  openrouter: OpenRouterClient
  signal?: AbortSignal
  isUserAbort?: () => boolean
  retryDelayMs?: number
  onEvent?: (event: ChatSseEvent) => void
  budgetUsd?: number
  userId?: string | null
  clock?: () => Date
  inferenceKey?: KeyAssessment
  /** Testes antigos não são sobre resposta curta. false mantém uma chamada; a produção omite o campo e repete. */
  repetirCurto?: boolean
}) {
  return await runChat({
    userId: opts.userId === undefined ? USER : opts.userId,
    body: opts.body ?? request(),
    db: opts.database ?? db(),
    openrouter: opts.openrouter,
    signal: opts.signal,
    isUserAbort: opts.isUserAbort,
    retryDelayMs: opts.retryDelayMs,
    clock: opts.clock ?? CLOCK,
    budgetUsd: opts.budgetUsd,
    inferenceKey: opts.inferenceKey,
    onEvent: opts.onEvent,
    repetirCurto: opts.repetirCurto ?? false,
  })
}

function acceptedKey(remaining = 2.5): KeyAssessment {
  return assessInferenceKey({
    data: {
      limit: 3,
      limit_reset: 'daily',
      limit_remaining: remaining,
      include_byok_in_limit: false,
    },
  })
}

function events(result: { events: ChatSseEvent[] }, name: ChatSseEvent['event']) {
  return result.events.filter((event) => event.event === name)
}

function finalOf(result: { events: ChatSseEvent[] }): ChatFinal {
  const finals = events(result, 'final')
  assert(finals.length === 1, 'um final')
  return finals[0].data as ChatFinal
}

Deno.test('slugs e teto', () => {
  eq(MODEL_SLUGS.basico, 'deepseek/deepseek-v4.1-flash-1017', 'slug basico')
  eq(MODEL_SLUGS.avancado, 'z-ai/glm-5.3', 'slug avancado')
  eq(CHAT_DAILY_BUDGET_USD, 3, 'teto default')
  eq(CHAT_MAX_TOKENS.basico, 2600, 'max_tokens basico (hotfix1: acima do máximo observado 2194)')
  eq(CHAT_MAX_TOKENS.avancado, 6000, 'max_tokens avancado (R2)')
  eq(CHAT_COST_ESTIMATE_USD.basico, 0.001444, 'preço de saída = 2600 tokens a US$ 0,0005/900')
  eq(CHAT_COST_ESTIMATE_USD.avancado, 0.013333, 'preço de saída = 6000 tokens')
  assert(CHAT_LEASE_HOLD_MS > CHAT_MODEL_TIMEOUT_MS, 'o lease cobre o aborto')
  const qwen = proveProviderSpend({
    pricing: { prompt: '0.00000003', completion: '0.00000013', input_cache_write: '0.000000038', overrides: [{ min_prompt_tokens: 32000, prompt: '0.0000001' }] },
    tokenizer: 'Qwen',
  })
  eq(qwen.ok, false, 'preço por token não autoriza')
  eq(qwen.reason, 'tokenizer_sem_teto', 'Qwen sem prova de tokens')
  eq(proveProviderSpend({ pricing: null }).reason, 'preco_ausente', 'sem preço')
  eq(proveProviderSpend({ pricing: { prompt: '0.1', completion: '0.2', sobretaxa: '1' } }).reason, 'componente_desconhecido', 'campo novo')
  eq(proveProviderSpend({ pricing: { prompt: '0.0000000699', completion: '0.0000014' }, tokenizer: 'Other' }).reason, 'tokenizer_sem_teto', 'GLM')
  const unicode = 'é'.repeat(1) + '😀'
  assert(unicode.length < new TextEncoder().encode(unicode).length, 'Unicode não é 1 token por caractere')
  eq(proveProviderSpend({ pricing: { prompt: '1', completion: '1' }, tokenizer: unicode }).reason, 'tokenizer_sem_teto', 'texto não vira teto')
  const prompt = '你'.repeat(10000) + 'é'.repeat(2000)
  const envelope = 'x'.repeat(1090)
  eq(prompt.length, 12000, 'unidades UTF-16')
  eq(new TextEncoder().encode(prompt).length, 34000, 'bytes UTF-8 do texto')
  eq(new TextEncoder().encode(envelope).length, 1090, 'envelope')
  const serialized = new TextEncoder().encode(prompt).length + new TextEncoder().encode(envelope).length
  eq(serialized, 35090, 'texto mais envelope')
  const rates = worstCatalogRates({
    prompt: '0.00000003',
    completion: '0.00000013',
    input_cache_read: '0.000000006',
    input_cache_write: '0.000000038',
    overrides: [
      { min_prompt_tokens: 32000, prompt: '0.0000001', completion: '0.0000004', input_cache_write: '0.000000125' },
      { min_prompt_tokens: 256000, prompt: '0.0000002', completion: '0.0000008', input_cache_read: '0.00000004', input_cache_write: '0.00000025' },
    ],
  })
  assert(rates, 'tarifas')
  const byBytes = quoteTokenCeilingUsd(rates, serialized, 900)
  const byChars = quoteTokenCeilingUsd(rates, prompt.length, 900)
  assert(byBytes > byChars, 'bytes e envelope custam mais que a contagem UTF-16')
  eq(proveProviderSpend({ pricing: { prompt: '0.00000003', completion: '0.00000013' }, tokenizer: 'Qwen' }).ok, false, 'cota ilustrada não autoriza')
  eq(resolveDailyBudgetUsd(undefined), 3, 'ausente fica em 3')
  eq(resolveDailyBudgetUsd('100'), 3, 'config acima de 3 desce para 3')
  eq(resolveDailyBudgetUsd('1.5'), 1.5, 'config menor permanece')
  eq(resolveDailyBudgetUsd('0'), null, 'zero falha fechado')
  eq(resolveDailyBudgetUsd('nao'), null, 'texto falha fechado')
  assert(exceedsBudget(3, 0.0005, 3), 'gasto no teto')
  assert(!exceedsBudget(2.9995, 0.0005, 3), 'soma igual ao teto ainda passa')
  assert(exceedsBudget(2.9996, 0.0005, 3), 'estimativa estoura o teto')
  eq(saoPauloDay(new Date('2026-11-05T02:30:00Z')), '2026-11-04', 'madrugada UTC ainda é o dia anterior em SP')
  eq(saoPauloDay(new Date('2026-11-05T03:00:00Z')), '2026-11-05', '03:00 UTC é meia-noite em SP')
})

Deno.test('CORS e redação', () => {
  assert(isAllowedOrigin('https://aion.hernandesnogueira.com.br'), 'origem de produção')
  assert(isAllowedOrigin('http://localhost:5173'), 'localhost')
  assert(isAllowedOrigin('http://127.0.0.1:8787'), '127.0.0.1')
  assert(isAllowedOrigin('https://localhost:8443'), 'https local')
  assert(!isAllowedOrigin('https://evil.example'), 'origem estranha')
  assert(!isAllowedOrigin('http://localhost.evil.com'), 'sufixo falso')
  assert(!isAllowedOrigin('http://aion.hernandesnogueira.com.br.evil.com'), 'host parecido')
  assert(!isAllowedOrigin(null), 'sem origem')
  const redacted = redactSecrets('postgres://chat_fn.ref:segredo@host:6543/postgres sk-or-abc Bearer abc.def.ghi')
  assert(!redacted.includes('segredo'), 'dsn mascarada')
  assert(!redacted.includes('sk-or-abc'), 'chave mascarada')
  assert(!redacted.includes('abc.def'), 'bearer mascarado')
})

Deno.test('T1 ok com chave limitada', async () => {
  const store = db()
  const model = scripted([
    { delta: answerJson() },
    { usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.02 } },
  ])
  const key = acceptedKey()
  assert(key.ok, 'chave de teste')
  const result = await chat({ database: store, openrouter: model.client, inferenceKey: key, repetirCurto: false })
  eq(result.httpStatus, 200, 'chama')
  eq(model.calls.length, 1, 'uma chamada paga')
  const body = model.calls[0] as { max_tokens?: number; model?: string }
  eq(body.max_tokens, CHAT_MAX_TOKENS.basico, 'max_tokens do Básico')
  eq(body.model, 'deepseek/deepseek-v4.1-flash-1017', 'slug')
  const final = finalOf(result)
  eq(final.custo_real, 0.02, 'custo informado, sem cortar')
  eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.02, 'grava o custo real')
  eq(store.snapshot(USER, CLOCK()).used, 1, 'debita depois da resposta')
  const again = scripted([{ delta: answerJson() }, { usage: { cost: 0.0001 } }])
  const second = await chat({ database: store, openrouter: again.client, inferenceKey: key, repetirCurto: false })
  eq(second.httpStatus, 200, 'lease solto depois da primeira')
  eq(again.calls.length, 1, 'segunda chamada após a liberação')
})

Deno.test('T2 sem_base', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})

Deno.test('A2 prepareChat tenta a consulta limpa uma vez após contexto vazio', async () => {
  const examples = [
    ['Quem é o Barão de Mauá?', 'quem e o barao de maua?', 'barao maua'],
    ['Fale sobre o Mauá?', 'fale sobre o maua?', 'maua'],
    ['Conte-me: a relação de Mauá com a paraense.', 'conte-me: a relacao de maua com a paraense.', 'maua paraense'],
    [
      'que quem qual quais o a os as um uma de da do das dos e em no na nos nas entre sobre fale falar me conte relacao relacoes ligacao ligacoes com para por foi era e eh sao quando onde como porque historia Mauá?',
      'que quem qual quais o a os as um uma de da do das dos e em no na nos nas entre sobre fale falar me conte relacao relacoes ligacao ligacoes com para por foi era e eh sao quando onde como porque historia maua?',
      'maua',
    ],
  ]
  for (const [mensagem, raw, cleaned] of examples) {
    const store = db()
    const lookup = store.chatContext.bind(store)
    const queries: (string | null)[] = []
    store.chatContext = async (ids, query) => {
      eq(ids.length, 0, 'sem ids nas duas consultas')
      queries.push(query)
      return await lookup([], query === cleaned ? 'maua' : null)
    }
    const result = await prepareChat({
      userId: USER, body: request({ mensagem, contexto: { entidades: [] } }),
      db: store, clock: CLOCK, inferenceKey: acceptedKey(),
    })
    assert(result.ok, 'recupera o contexto na segunda consulta')
    eq(queries[0], raw, 'normaliza a pergunta inteira')
    eq(queries[1], cleaned, 'limpa só palavras inteiras uma vez')
    assert(!queries.slice(2).includes(cleaned), 'não repete a consulta limpa')
    assert(queries.length <= 8, 'teto de chamadas')
    eq(result.context.raizes?.[0]?.id, 'maua', 'usa o contexto recuperado')
    eq(result.mensagem, mensagem, 'mensagem original preservada')
    eq(store.reserveCalls, 1, 'uma reserva de crédito')
    eq(store.releaseCalls, 0, 'reserva mantida para o stream')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, result.estimate, 'reserva do teto da entrada completa')
  }
})

Deno.test('A2 ruído continua fora_da_base após uma única tentativa extra', async () => {
  const examples = [
    ['Qual a previsão do tempo amanhã?', 'qual a previsao do tempo amanha?', 'previsao tempo amanha'],
    ['O que é o?', 'o que e o?', ''],
  ]
  for (const [mensagem, raw, cleaned] of examples) {
    const store = db()
    const lookup = store.chatContext.bind(store)
    const queries: (string | null)[] = []
    store.chatContext = async (ids, query) => {
      queries.push(query)
      return await lookup(ids, query)
    }
    const result = await prepareChat({
      userId: USER, body: request({ mensagem, contexto: { entidades: [] } }),
      db: store, clock: CLOCK, inferenceKey: acceptedKey(),
    })
    assert(!result.ok, 'ruído recusado')
    eq((result.event.data as { code: string }).code, 'fora_da_base', 'código preservado')
    eq(JSON.stringify(queries), JSON.stringify([raw, cleaned]), 'duas consultas no máximo')
    eq(store.releaseCalls, 1, 'devolve crédito')
    eq(store.snapshot(USER).reserved, 0, 'sem crédito reservado')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'devolve orçamento')
  }
})

Deno.test('A2 com seleção ainda busca o texto e não limpa pergunta curta', async () => {
  const vazio = async (): Promise<ChatContextPayload> => ({ raizes: [], entidades: [], relacoes: [], fontes: [] })
  for (const [mensagem, primeira] of [['Mauá', 'maua'], ['Quem é Mauá?', 'quem e maua?']] as const) {
    const store = db()
    const queries: (string | null)[] = []
    store.chatContext = async (_ids, query) => {
      queries.push(query)
      return await vazio()
    }
    const result = await prepareChat({
      userId: USER, body: request({ mensagem, contexto: { entidades: [] } }),
      db: store, clock: CLOCK, inferenceKey: acceptedKey(),
    })
    assert(!result.ok, 'contexto continua vazio')
    eq((result.event.data as { code: string }).code, 'fora_da_base', 'código preservado')
    eq(queries[0], primeira, 'consulta o texto')
    assert(!queries.includes(''), 'pergunta curta não dispara a limpeza')
    assert(queries.length <= 8, 'teto de chamadas')
    eq(store.releaseCalls, 1, 'devolve crédito')
  }
  const store = db()
  const queries: (string | null)[] = []
  const idCalls: string[] = []
  store.chatContext = async (ids, query) => {
    idCalls.push(ids.join(','))
    queries.push(query)
    return { raizes: [], entidades: [], relacoes: [], fontes: [] }
  }
  const result = await prepareChat({
    userId: USER, body: request({ mensagem: 'Quem é o Barão de Mauá?', contexto: { entidades: ['ausente'] } }),
    db: store, clock: CLOCK, inferenceKey: acceptedKey(),
  })
  assert(!result.ok, 'seleção vazia e texto vazio continuam fora')
  eq((result.event.data as { code: string }).code, 'fora_da_base', 'código preservado')
  eq(queries[0], 'quem e o barao de maua?', 'seleção não apaga o texto')
  assert(queries.includes('barao maua'), 'limpa uma vez quando o texto longo volta vazio')
  assert(idCalls.includes('ausente'), 'também consulta a seleção')
  assert(queries.length <= 8, 'teto de chamadas')
  eq(store.releaseCalls, 1, 'devolve crédito')
})

Deno.test('A2 não repete consulta quando a primeira já tem contexto', async () => {
  for (const entityIds of [[], ['maua']]) {
    const store = db()
    const lookup = store.chatContext.bind(store)
    const queries: (string | null)[] = []
    store.chatContext = async (ids, query) => {
      queries.push(query)
      return await lookup(ids, query)
    }
    const result = await prepareChat({
      userId: USER,
      body: request({ mensagem: 'Quem é o Barão de Mauá?', contexto: { entidades: entityIds } }),
      db: store, clock: CLOCK, inferenceKey: acceptedKey(),
    })
    assert(result.ok, 'contexto encontrado')
    assert(queries[0]?.includes('barao'), 'a primeira consulta usa o texto')
    assert(!queries.includes('barao maua'), 'não limpa quando a primeira já achou')
    assert(queries.length <= 8, 'teto de chamadas')
  }
})

Deno.test('A2 falha da consulta acontece antes da reserva de crédito', async () => {
  for (const failAt of [1, 2]) {
    const store = db()
    const lookup = store.chatContext.bind(store)
    let calls = 0
    store.chatContext = async () => {
      calls++
      if (calls === failAt) throw new Error('banco indisponível')
      return await lookup([], null)
    }
    const result = await prepareChat({
      userId: USER,
      body: request({ mensagem: 'Quem é o Barão de Mauá?', contexto: { entidades: [] } }),
      db: store, clock: CLOCK, inferenceKey: acceptedKey(),
    })
    assert(!result.ok, 'falha controlada')
    eq((result.event.data as { code: string }).code, 'rede', 'erro de consulta preservado')
    eq(calls, failAt, 'nenhuma tentativa após a exceção')
    eq(store.reserveCalls, 0, 'não reserva crédito')
    eq(store.releaseCalls, 0, 'não há reserva para devolver')
    eq(store.snapshot(USER).reserved, 0, 'sem crédito reservado')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'sem orçamento')
  }
})

Deno.test('T3 ids_invalidos', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})

Deno.test('T4 sem_creditos', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})

Deno.test('T5 cota', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})

Deno.test('T6 orcamento_esgotado', async () => {
  const store = db()
  store.addSpend(3, CLOCK())
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client, inferenceKey: acceptedKey() })
  eq(result.httpStatus, 503, 'http')
  eq((result.events[0].data as { code: string }).code, 'orcamento_esgotado', 'code distinto')
  assert((result.events[0].data as { code: string }).code !== 'modelo_indisponivel', 'não é modelo')
  eq(model.calls.length, 0, 'sem OpenRouter')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'nem reserva')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'sem débito')

  const near = db()
  near.addSpend(3 - CHAT_COST_ESTIMATE_USD.basico / 2, CLOCK())
  const nearModel = scripted([])
  const nearResult = await chat({ database: near, openrouter: nearModel.client, inferenceKey: acceptedKey() })
  eq((nearResult.events[0].data as { code: string }).code, 'orcamento_esgotado', 'estimativa estoura')
  eq(nearModel.calls.length, 0, 'bloqueio antes do modelo')
})

Deno.test('T7 rate_limit', async () => {
  const store = db()
  store.seedRate(USER, 10, CLOCK())
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 429, 'http')
  eq((result.events[0].data as { code: string }).code, 'rate_limit', 'code')
  const rate = result.events[0].data as { message: string; retry_after_s?: number }
  assert(typeof rate.retry_after_s === 'number', 'retry')
  assert(rate.message.includes(`Tente em ${rate.retry_after_s}s`), 'mensagem com os segundos')
  eq(model.calls.length, 0, 'sem OpenRouter')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'sem reserva')

  const day = db()
  day.seedRate(USER, 200, new Date(CLOCK().getTime() - 120_000))
  const dayModel = scripted([])
  const dayResult = await chat({ database: day, openrouter: dayModel.client })
  eq((dayResult.events[0].data as { code: string }).code, 'rate_limit', 'teto diário')
  eq(dayModel.calls.length, 0, 'sem modelo no teto diário')
})

Deno.test('T8 abort', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})

Deno.test('T9 erro_modelo', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})

// Substitui fetch só durante o teste: nenhum servidor, segredo ou acesso à rede.
async function withOpenRouterResponses(
  responses: Response[],
  run: (client: OpenRouterClient, bodies: string[], signals: AbortSignal[]) => Promise<void>,
) {
  const originalFetch = globalThis.fetch
  const bodies: string[] = []
  const signals: AbortSignal[] = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(String(init?.body))
    assert(init?.signal, 'sinal enviado ao provedor')
    signals.push(init.signal)
    const response = responses.shift()
    assert(response, 'sem chamadas além das respostas previstas')
    return response
  }
  try {
    await run(createFetchOpenRouter({ apiKey: 'fixture-key', url: 'https://openrouter.test/chat' }), bodies, signals)
  } finally {
    globalThis.fetch = originalFetch
  }
}

function upstreamSse(...chunks: unknown[]): Response {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''))
}

Deno.test('SPEC2 429 seguido de sucesso repete o pedido com um débito e um log', async () => {
  const store = db()
  let budgetReservations = 0
  const reserveBudget = store.reserveBudget.bind(store)
  store.reserveBudget = (...args) => {
    budgetReservations++
    return reserveBudget(...args)
  }
  await withOpenRouterResponses([
    Response.json({ error: { code: 429, message: 'Provider returned error' } }, { status: 429 }),
    upstreamSse({ choices: [{ delta: { content: answerJson() } }], usage: { cost: 0.0002 } }),
  ], async (client, bodies, signals) => {
    const result = await chat({ database: store, openrouter: client, inferenceKey: acceptedKey(), retryDelayMs: 0 })
    eq(result.httpStatus, 200, 'sucesso após retry')
    eq(finalOf(result).gratis_restantes, 19, 'um crédito grátis debitado')
    eq(terminals(result).length, 1, 'um único terminal')
    eq(events(result, 'meta').length, 1, 'um meta')
    eq(bodies.length, 2, 'exatamente duas tentativas')
    eq(bodies[0], bodies[1], 'mesmo corpo no retry')
    eq(signals[0], signals[1], 'mesmo sinal e prazo nas duas tentativas')
    eq(budgetReservations, 1, 'uma única reserva de orçamento')
    const state = store.snapshot(USER, CLOCK())
    eq(state.reserveCalls, 1, 'uma única reserva de crédito')
    eq(state.commitCalls, 1, 'um commit de crédito')
    eq(state.used, 1, 'um débito')
    eq(state.reserved, 0, 'sem reserva de crédito pendente')
    eq(state.logs.length, 1, 'um único log')
    eq(state.logs[0].status, 'ok', 'log final de sucesso')
    eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.0002, 'liquida só a resposta final')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'sem reserva de orçamento pendente')
  })
})

Deno.test('SPEC2 dois 429 devolvem modelo_ocupado e liberam créditos e orçamento', async () => {
  eq(CHAT_ERROR_STATUS.modelo_ocupado, 503, 'status do novo código')
  for (const modelo of ['basico', 'avancado']) {
    const store = db()
    store.setPaid(USER, 20)
    await withOpenRouterResponses([
      Response.json({ error: { code: 429 } }, { status: 429 }),
      upstreamSse({ error: { code: 429, message: 'Provider returned error' } }),
    ], async (client, bodies) => {
      const result = await chat({ database: store, body: request({ modelo }), openrouter: client, inferenceKey: acceptedKey(), retryDelayMs: 0 })
      eq(result.httpStatus, 503, 'erro antes de abrir o stream')
      const terminal = terminals(result)
      eq(terminal.length, 1, 'um único terminal')
      assert(terminal[0].event === 'error', 'terminal de erro')
      eq(terminal[0].data.code, 'modelo_ocupado', 'novo código')
      eq(terminal[0].data.message, 'Muitas perguntas agora, tente em alguns segundos.', 'mensagem exata')
      eq(bodies.length, 2, 'sem terceira tentativa')
      const state = store.snapshot(USER, CLOCK())
      eq(state.reserveCalls, 1, 'mesmo pedido reservado uma vez')
      eq(state.commitCalls, 0, 'não debita')
      eq(state.releaseCalls, 1, 'libera uma vez')
      eq(state.used, 0, 'nenhum crédito grátis gasto')
      eq(state.reserved, 0, 'nenhum crédito grátis reservado')
      eq(state.paid, 20, 'saldo pago devolvido')
      eq(state.logs.length, 1, 'um único log')
      eq(state.logs[0].status, 'modelo_ocupado', 'status persistido')
      eq(state.logs[0].custo_usd, chatSpendCeilingUsd(modelo as Modelo, JSON.parse(bodies[0])), 'SSE aceito sem custo conserva teto')
      eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, chatSpendCeilingUsd(modelo as Modelo, JSON.parse(bodies[0])), 'não presume custo zero no SSE')
      eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'orçamento liberado')
      assert(await store.acquirePaidLease('after-retry', CHAT_LEASE_HOLD_MS, CLOCK()), 'lease liberado')
      await store.releasePaidLease('after-retry')
    })
  }
})

Deno.test('SPEC2 429 no stream após delta não repete e preserva a liquidação existente', async () => {
  const store = db()
  await withOpenRouterResponses([
    upstreamSse(
      { choices: [{ delta: { content: '{"blocos":[' } }], usage: { cost: 0.0001 } },
      { error: { code: '429', message: 'Provider returned error' } },
    ),
  ], async (client, bodies) => {
    const result = await chat({ database: store, openrouter: client, inferenceKey: acceptedKey(), retryDelayMs: 0 })
    eq(bodies.length, 1, 'nenhum retry depois de delta')
    eq(result.httpStatus, 200, 'stream já iniciado')
    eq(events(result, 'delta').length, 1, 'delta original enviado uma vez')
    const terminal = terminals(result)
    eq(terminal.length, 1, 'um terminal')
    assert(terminal[0].event === 'error', 'termina em erro')
    eq(terminal[0].data.code, 'modelo_ocupado', '429 textual também reconhecido')
    eq(store.snapshot(USER, CLOCK()).commitCalls, 0, 'crédito não debitado')
    eq(store.snapshot(USER, CLOCK()).releaseCalls, 1, 'crédito devolvido')
    eq(store.snapshot(USER, CLOCK()).reserved, 0, 'sem crédito preso')
    eq(store.logs.length, 1, 'um log')
    eq(store.logs[0].status, 'modelo_ocupado', 'status correto')
    eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.0001, 'custo já gerado mantido')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'reserva liquidada')
  })
})

Deno.test('SPEC2 aborto durante backoff cancela a espera e libera as reservas', async () => {
  const store = db()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const model = scripted(async function* () {
    timer = setTimeout(() => controller.abort('client'), 0)
    throw new OpenRouterError('modelo_ocupado', 'http 429')
  })
  try {
    const result = await chat({ database: store, openrouter: model.client, inferenceKey: acceptedKey(), signal: controller.signal, retryDelayMs: 1000 })
    eq(model.calls.length, 1, 'não repete após aborto no backoff')
    const terminal = terminals(result)
    eq(terminal.length, 1, 'um terminal')
    assert(terminal[0].event === 'error', 'termina em erro')
    eq(terminal[0].data.code, 'abortado', 'aborto do usuário')
    const state = store.snapshot(USER, CLOCK())
    eq(state.commitCalls, 0, 'não debita')
    eq(state.releaseCalls, 1, 'devolve uma vez')
    eq(state.used, 0, 'sem gasto de crédito')
    eq(state.reserved, 0, 'sem crédito reservado')
    eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0, 'sem custo gerado')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'sem orçamento preso')
    assert(await store.acquirePaidLease('after-abort', CHAT_LEASE_HOLD_MS, CLOCK()), 'lease liberado no aborto')
    await store.releasePaidLease('after-abort')
  } finally {
    clearTimeout(timer)
  }
})

Deno.test('SPEC2 timeout durante backoff mantém o prazo único e não vira aborto do usuário', async () => {
  const store = db()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const model = scripted(async function* () {
    timer = setTimeout(() => controller.abort('timeout'), 0)
    throw new OpenRouterError('modelo_ocupado', 'http 429')
  })
  try {
    const result = await chat({ database: store, openrouter: model.client, inferenceKey: acceptedKey(), signal: controller.signal, isUserAbort: () => false })
    eq(model.calls.length, 1, 'timeout cancela o backoff padrão antes do retry')
    const terminal = terminals(result)
    eq(terminal.length, 1, 'um terminal')
    assert(terminal[0].event === 'error', 'erro terminal')
    eq(terminal[0].data.code, 'rede', 'mantém a classificação existente de timeout')
    eq(store.snapshot(USER, CLOCK()).releaseCalls, 1, 'crédito liberado')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'orçamento liberado')
  } finally {
    clearTimeout(timer)
  }
})

Deno.test('SPEC2 402, 403 e outros erros nunca são repetidos', async () => {
  for (const [status, error, expected] of [
    [402, {}, 'limite_chave'],
    [403, { metadata: { limit_source: 'openrouter_guardrail_budget' } }, 'limite_chave'],
    [403, {}, 'rede'],
    [400, {}, 'modelo_indisponivel'],
    [500, {}, 'rede'],
    [200, { code: 500 }, 'modelo_indisponivel'],
  ] as const) {
    const response = status === 200 ? upstreamSse({ error }) : Response.json({ error }, { status })
    await withOpenRouterResponses([response], async (client, bodies) => {
      const store = db()
      const result = await chat({ database: store, openrouter: client, inferenceKey: acceptedKey(), retryDelayMs: 0 })
      eq(bodies.length, 1, `não repete ${status}`)
      const terminal = terminals(result)
      eq(terminal.length, 1, 'um terminal')
      assert(terminal[0].event === 'error', 'erro terminal')
      eq(terminal[0].data.code, expected, 'classificação existente preservada')
      eq(store.snapshot(USER, CLOCK()).releaseCalls, 1, 'crédito liberado')
      eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'orçamento liberado')
    })
  }
})

Deno.test('validação e parser', async () => {
  const store = db()
  const model = scripted([])
  const long = await chat({
    database: store,
    openrouter: model.client,
    body: request({ mensagem: 'a'.repeat(2001) }),
  })
  eq((long.events[0].data as { code: string }).code, 'pedido_invalido', 'mensagem longa')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'nem mede taxa')
  const many = await chat({
    database: store,
    openrouter: model.client,
    body: request({ contexto: { entidades: ['maua', 'a', 'b', 'c'] } }),
  })
  eq((many.events[0].data as { code: string }).code, 'pedido_invalido', '4 ids')
  eq(model.calls.length, 0, 'sem modelo')
  const anon = await chat({ database: store, openrouter: model.client, userId: null })
  eq((anon.events[0].data as { code: string }).code, 'sem_login', 'sem sub')
  const parsed = validateChatBody(request())
  assert(parsed.ok, 'pedido válido')
  const block = parseOpenRouterBlock('data: {"choices":[{"delta":{"content":"oi"}}]}\n')
  assert(block && 'chunk' in block && block.chunk.delta === 'oi', 'delta sse')
  const done = parseOpenRouterBlock('data: [DONE]')
  assert(done && 'done' in done, 'done')
})

function b64url(text: string): string {
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function b64urlBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

Deno.test('JWT só do header', async () => {
  const secret = 'fixture-hmac-ux3c'
  const issuer = 'https://fixture.supabase.co/auth/v1'
  const check = { jwtSecret: secret, issuer, audience: 'authenticated' }
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const live = {
    sub: USER,
    role: 'authenticated',
    aud: 'authenticated',
    iss: issuer,
    exp: Math.floor(Date.now() / 1000) + 600,
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signHs = async (claims: Record<string, unknown>) => {
    const body = b64url(JSON.stringify(claims))
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`))
    return `${header}.${body}.${b64urlBytes(new Uint8Array(sig))}`
  }
  const token = await signHs(live)
  eq(await userIdFromAuthorization(`Bearer ${token}`, check), USER, 'sub verificado')
  eq(await userIdFromAuthorization(`Bearer ${token}`, { ...check, jwtSecret: 'outra-fixture' }), null, 'assinatura errada')
  eq(await userIdFromAuthorization(`Bearer ${token}`, { issuer, audience: 'authenticated' }), null, 'HS256 sem segredo')
  eq(await userIdFromAuthorization(`Bearer ${token}`, { ...check, issuer: null }), null, 'sem emissor')
  eq(await userIdFromAuthorization(null, check), null, 'sem header')
  const none = `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(live))}.x`
  eq(await userIdFromAuthorization(`Bearer ${none}`, check), null, 'alg none')
  eq(await userIdFromAuthorization(`Bearer ${await signHs({ ...live, exp: Math.floor(Date.now() / 1000) - 120 })}`, check), null, 'expirado')
  const { exp: _drop, ...withoutExp } = live
  eq(await userIdFromAuthorization(`Bearer ${await signHs(withoutExp)}`, check), null, 'exp ausente')
  eq(await userIdFromAuthorization(`Bearer ${await signHs({ ...live, iss: 'https://outro.supabase.co/auth/v1' })}`, check), null, 'emissor errado')
  eq(await userIdFromAuthorization(`Bearer ${await signHs({ ...live, aud: 'anon' })}`, check), null, 'audiência errada')
  eq(await userIdFromAuthorization(`Bearer ${await signHs({ ...live, nbf: Math.floor(Date.now() / 1000) + 600 })}`, check), null, 'nbf futuro')
  const rs = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(live))}.sig`
  eq(await userIdFromAuthorization(`Bearer ${rs}`, check), null, 'RS256 não verificado')
  eq(await userIdFromAuthorization(`Bearer ${await signHs({ ...live, user_metadata: { sub: OTHER, role: 'service_role' } })}`, check), USER, 'ignora user_metadata')
  eq(await userIdFromAuthorization(`Bearer ${await signHs({ ...live, role: 'service_role' })}`, check), null, 'service_role recusado')

  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const esHeader = b64url(JSON.stringify({ alg: 'ES256', kid: 'kid-fixture', typ: 'JWT' }))
  const esBody = b64url(JSON.stringify({ ...live, user_metadata: { sub: OTHER } }))
  const esSig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(`${esHeader}.${esBody}`),
  ))
  const esToken = `${esHeader}.${esBody}.${b64urlBytes(esSig)}`
  const jwks = { keys: [{ ...publicJwk, alg: 'ES256', kid: 'kid-fixture' }] }
  eq(await userIdFromAuthorization(`Bearer ${esToken}`, { jwks, issuer, audience: 'authenticated' }), USER, 'ES256')
  eq(await userIdFromAuthorization(`Bearer ${esToken}`, { issuer, audience: 'authenticated' }), null, 'ES256 sem JWKS falha fechado')
  const wrong = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const wrongJwk = await crypto.subtle.exportKey('jwk', wrong.publicKey)
  eq(await userIdFromAuthorization(`Bearer ${esToken}`, { jwks: { keys: [{ ...wrongJwk, alg: 'ES256', kid: 'kid-fixture' }] }, issuer, audience: 'authenticated' }), null, 'ES256 chave errada')
})

function terminals(result: { events: ChatSseEvent[] }) {
  return result.events.filter((event) => event.event === 'final' || event.event === 'error')
}

function failLog(store: MemoryChatDb): MemoryChatDb {
  store.insertLog = () => Promise.reject(new Error(`log indisponível ${QUESTION}`))
  return store
}

Deno.test('R1 dois pedidos na mesma conversa', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})

Deno.test('R2 uma chamada paga por vez', async () => {
  const store = db()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const model = scripted(async function* () {
    yield { delta: answerJson().slice(0, 20) }
    await gate
    yield { delta: answerJson().slice(20) }
    yield { usage: { cost: 0.0002 } }
  })
  const key = acceptedKey()
  const first = chat({ database: store, openrouter: model.client, inferenceKey: key })
  const second = chat({ database: store, openrouter: model.client, inferenceKey: key })
  const early = await Promise.race([
    first,
    second,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lease não separou as chamadas')), 2000)),
  ])
  eq((early.events[0].data as { code: string }).code, 'ocupado', 'a outra não entra')
  eq(model.calls.length, 1, 'só uma chegou ao provedor')
  const message = (early.events[0].data as { message: string }).message
  assert(!message.includes('US$'), 'não anuncia um teto em dólares')
  assert(!message.includes('sk-or-'), 'sem chave')
  release?.()
  const both = await Promise.all([first, second])
  eq(both.filter((item) => item.httpStatus === 200).length, 1, 'uma termina')
  const third = scripted([{ delta: answerJson() }, { usage: { cost: 0.0001 } }])
  const after = await chat({ database: store, openrouter: third.client, inferenceKey: key })
  eq(after.httpStatus, 200, 'depois da liberação outra chamada passa')
})

Deno.test('R3 log e commit não deixam stream sem terminal', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})

Deno.test('A1 erro depois de gerar liquida o orçamento e devolve o crédito', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})

Deno.test('A4 release de crédito e de orçamento não se bloqueiam', async () => {
  const store = db()
  const model = scripted([])
  const result = await chat({ database: store, openrouter: model.client })
  eq(result.httpStatus, 503, 'não chama')
  eq((result.events[0].data as { code: string }).code, 'chave_recusada', 'sem chave válida')
  eq(model.calls.length, 0, 'provedor não é chamado')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não debita')
  eq(store.snapshot(USER, CLOCK()).reserveCalls, 0, 'não reserva')
})


Deno.test('custo acima da reserva é gravado inteiro', async () => {
  const store = db()
  const day = saoPauloDay(CLOCK())
  const held = await store.reserveBudget('pedido-estouro', 0.0005, 3, CLOCK())
  assert(held.ok, 'reserva cabe')
  await store.commitBudget('pedido-estouro', 0.02)
  eq(store.budgetOf(day).gasto, 0.02, 'não corta o custo informado')
  eq(store.budgetOf(day).reservado, 0, 'reserva baixada')
})

Deno.test('duas reservas grandes não passam juntas de 3', async () => {
  const store = db()
  const [a, b] = await Promise.all([
    store.reserveBudget('a', 2, 100, CLOCK()),
    store.reserveBudget('b', 2, 100, CLOCK()),
  ])
  eq([a, b].filter((item) => item.ok).length, 1, 'só uma autorização')
})

Deno.test('chave nativa inválida não chama o provedor', async () => {
  const cases: unknown[] = [
    null,
    { data: { limit: null, limit_reset: 'daily', limit_remaining: 3, include_byok_in_limit: false } },
    { data: { limit: 11, limit_reset: 'daily', limit_remaining: 9, include_byok_in_limit: false } },
    { data: { limit: 50.01, limit_reset: 'monthly', limit_remaining: 3, include_byok_in_limit: false } },
    { data: { limit: 5, limit_reset: 'weekly', limit_remaining: 3, include_byok_in_limit: false } },
    { data: { limit: 5, limit_reset: null, limit_remaining: 3, include_byok_in_limit: false } },
    { data: { limit: 3, limit_reset: 'daily', limit_remaining: 3, include_byok_in_limit: true } },
    { data: { limit: 3, limit_remaining: 3 } },
    { data: { limit: 3, limit_reset: 'daily', limit_remaining: 0, include_byok_in_limit: false } },
  ]
  for (const payload of cases) {
    const key = assessInferenceKey(payload)
    assert(!key.ok, 'fecha')
    const model = scripted([{ delta: answerJson() }])
    const result = await chat({ openrouter: model.client, inferenceKey: key })
    eq(model.calls.length, 0, 'sem chamada')
    const code = (result.events[0].data as { code: string }).code
    assert(code === 'chave_recusada' || code === 'limite_chave', code)
    const message = (result.events[0].data as { message: string }).message
    assert(!message.includes('US$'), 'sem valor de teto')
    assert(!message.includes('sk-or-'), 'sem segredo')
  }
  const exhausted = acceptedKey(0)
  assert(!exhausted.ok && exhausted.reason === 'esgotada', 'restante zero')
  const low = acceptedKey(0.0001)
  assert(low.ok, 'restante positivo ainda é metadado válido')
  const model = scripted([{ delta: answerJson() }])
  const blocked = await chat({ openrouter: model.client, inferenceKey: low })
  eq(model.calls.length, 0, 'abaixo da reserva não chama')
  eq((blocked.events[0].data as { code: string }).code, 'limite_chave', 'chave esgotada para esta reserva')
})

Deno.test('GUARD1: diária até US$ 10 e mensal até US$ 50', () => {
  const key = (limit: number | null, limit_reset: string | null) =>
    assessInferenceKey({ data: { limit, limit_reset, limit_remaining: 1, include_byok_in_limit: false } })
  const reason = (k: KeyAssessment) => (k.ok ? 'ok' : k.reason)
  eq(reason(key(50, 'monthly')), 'ok', '50 mensal passa')
  eq(reason(key(50.01, 'monthly')), 'acima', '50.01 mensal falha')
  eq(reason(key(null, 'monthly')), 'ilimitada', 'null falha')
  eq(reason(key(10, 'daily')), 'ok', '10 diário passa')
  eq(reason(key(11, 'daily')), 'acima', '11 diário falha')
  eq(reason(key(5, 'weekly')), 'janela', 'weekly 5 falha')
  eq(reason(key(5, null)), 'janela', 'janela nula falha')
  const effective = (limit_usd: number, reset_interval: string) => assessInferenceKey({ data: {
    limit: 5, limit_reset: 'monthly', limit_remaining: 1, include_byok_in_limit: false,
    effective_budget: { limit_usd, reset_interval, include_byok: false },
  } })
  eq(reason(effective(50, 'monthly')), 'ok', 'effective mensal 50 passa')
  eq(reason(effective(51, 'monthly')), 'acima', 'effective mensal 51 falha')
  eq(reason(effective(5, 'weekly')), 'janela', 'effective weekly falha')
})

Deno.test('lease não vence no meio do aborto', async () => {
  const store = db()
  const start = CLOCK()
  assert(await store.acquirePaidLease('pedido-1', CHAT_LEASE_HOLD_MS, start), 'pega')
  assert(!(await store.acquirePaidLease('pedido-2', CHAT_LEASE_HOLD_MS, new Date(start.getTime() + CHAT_MODEL_TIMEOUT_MS))), 'ainda dentro do aborto')
  assert(await store.acquirePaidLease('pedido-2', CHAT_LEASE_HOLD_MS, new Date(start.getTime() + CHAT_LEASE_HOLD_MS)), 'só depois do prazo inteiro')
  await store.releasePaidLease('pedido-2')
  assert(await store.acquirePaidLease('pedido-3', CHAT_LEASE_HOLD_MS, start), 'release devolve')
})

Deno.test('402 e 403 de limite não vazam a chave', async () => {
  const secret = 'sk-or-v1-fixture-secret'
  const mock = Deno.serve({ port: 0, hostname: '127.0.0.1' }, async (req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/key')) {
      return Response.json({
        data: { limit: 3, limit_reset: 'daily', limit_remaining: 2, include_byok_in_limit: false, label: secret },
      })
    }
    const payload = await req.json().catch(() => ({}))
    const status = payload && (payload as { want403?: boolean }).want403 ? 403 : 402
    return Response.json({
      error: { message: secret, metadata: { limit_source: status === 403 ? 'openrouter_guardrail_budget' : 'openrouter_key_limit' } },
    }, { status })
  })
  try {
    const addr = mock.addr
    if (!('port' in addr)) throw new Error('mock sem porta')
    const client = createFetchOpenRouter({ apiKey: secret, url: `http://127.0.0.1:${addr.port}/v1/chat/completions` })
    const read = async (body: Record<string, unknown>) => {
      let caught = ''
      let kind = ''
      try {
        for await (const _chunk of client.stream({ body, signal: new AbortController().signal })) {
          void _chunk
        }
      } catch (err) {
        caught = err instanceof Error ? err.message : String(err)
        kind = err instanceof OpenRouterError ? err.kind : ''
      }
      return { caught, kind }
    }
    const denied = await read({ model: 'qwen/qwen3.7-flash' })
    eq(denied.caught, 'http 402', 'mensagem curta')
    eq(denied.kind, 'limite_chave', '402 é limite')
    assert(!denied.caught.includes(secret), 'o corpo não volta')
    const guard = await read({ want403: true })
    eq(guard.caught, 'http 403', '403 curto')
    eq(guard.kind, 'limite_chave', '403 de limite')
    assert(!chatErrorMessage('limite_chave').includes('US$'), 'texto público sem teto')
    const key = await loadInferenceKeyAssessment({ apiKey: secret, url: `http://127.0.0.1:${addr.port}/api/v1/key` })
    assert(key.ok, 'o GET da chave aceita o limite diário')
  } finally {
    await mock.shutdown()
  }
})

Deno.test('recorte grande é reduzido antes do envio', () => {
  const context = {
    raizes: [],
    entidades: [],
    relacoes: [],
    fontes: [{ id: 's', titulo: '你'.repeat(20000) }],
  }
  const bound = boundContextJson(context)
  assert(bound.length <= 16000, 'não manda o texto inteiro')
  assert(!bound.includes('你你你'), 'o miolo não segue')
})

Deno.test('recorte grande mantém raízes ao encolher listas', () => {
  const context = {
    raizes: [{ id: 'walther_ms', nome: 'Walther', tipo: 'pessoa' }],
    entidades: Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, nome: `N${i}`, tipo: 'pessoa' })),
    relacoes: Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, tipo: 'ligacao', origem: 'walther_ms', destino: `e${i}` })),
    fontes: Array.from({ length: 40 }, (_, i) => ({
      id: `B${i}`,
      titulo: 't'.repeat(400),
      evidencias: [{ excerpt_text: 'x'.repeat(800) }],
    })),
  }
  const bound = boundContextJson(context)
  assert(bound.length <= 16000, 'cabe no teto')
  assert(bound.includes('walther_ms'), 'mantém a raiz')
  assert(!bound.includes('excerpt_text'), 'remove evidências pesadas')
  const parsed = JSON.parse(bound)
  assert(!parsed.truncado, 'não cai no stub se ainda há recorte útil')
})

Deno.test('pedido ao modelo desliga reasoning para não esgotar max_tokens', () => {
  const body = modelRequestBody('basico', 'sistema curto', 'pergunta')
  eq(body.model, MODEL_SLUGS.basico, 'slug básico')
  eq(body.max_tokens, CHAT_MAX_TOKENS.basico, 'teto de saída')
  const reasoning = body.reasoning as { effort?: string }
  eq(reasoning?.effort, 'none', 'effort none')
})


Deno.test('SPEC3 recorte real Rockefeller cabe sem stub e mantém raízes', async () => {
  const context: ChatContextPayload = JSON.parse(await Deno.readTextFile(
    new URL('../chat/fixtures/ctx_rockefeller_golpe64.json', import.meta.url),
  ))
  const original = JSON.stringify(context)
  const bound = boundContextJson(context)
  const parsed = JSON.parse(bound)
  assert(bound.length <= 16000, `recorte real: ${bound.length} caracteres`)
  console.log(`SPEC3 fixture Rockefeller: ${original.length} -> ${bound.length} chars`)
  assert(!parsed.truncado, 'não cai no stub')
  eq(JSON.stringify(parsed.raizes), JSON.stringify(context.raizes), 'mantém raízes completas')
  assert(parsed.entidades.length > 0 && parsed.relacoes.length > 0, 'mantém documentação útil')
  assert(parsed.casos.length < context.casos!.length, 'reduz também casos')
  eq(JSON.stringify(context), original, 'não modifica o contexto original')
})

Deno.test('SPEC3 preserva caminhos, intermediários, relações e fontes ao reduzir', async () => {
  const context: ChatContextPayload = JSON.parse(await Deno.readTextFile(
    new URL('../chat/fixtures/ctx_rockefeller_golpe64.json', import.meta.url),
  ))
  context.raizes.push({ id: 'david_r', nome: 'David Rockefeller' }, { id: 'golpe64', nome: 'Golpe de 1964' })
  context.ligacoes_entre_raizes = [
    { de: 'david_r', para: 'golpe64', via: 'ipes', relacoes: ['PR4-E017', 'E219'] },
    { de: 'david_r', para: 'golpe64', via: 'ipes', relacoes: ['PR4-E018', 'E219'] },
  ]
  // Deliberately put required items at the end, beyond every ordinary slice.
  context.entidades.push({ id: 'ipes', nome: 'IPES', nota: 'n'.repeat(10000) })
  for (const [id, origem, destino] of [
    ['PR4-E017', 'ipes', 'david_r'], ['PR4-E018', 'ipes', 'david_r'], ['E219', 'ipes', 'golpe64'],
  ]) {
    context.relacoes.push({ id, origem, destino, fontes: ['bridge_source'], afirmacao: 'a'.repeat(10000), limite: 'l'.repeat(10000) })
  }
  context.fontes.push({ id: 'bridge_source', titulo: 't'.repeat(10000), url: 'https://fixture.example/path' })
  const original = JSON.stringify(context)
  const bound = boundContextJson(context)
  const parsed: ChatContextPayload = JSON.parse(bound)
  assert(bound.length <= 16000, `com caminhos: ${bound.length} caracteres`)
  console.log(`SPEC3 synthetic paths: ${original.length} -> ${bound.length} chars; paths=${parsed.ligacoes_entre_raizes?.length}`)
  assert(!('truncado' in parsed), 'sem stub')
  eq(JSON.stringify(parsed.raizes), JSON.stringify(context.raizes), 'preserva três raízes')
  eq(JSON.stringify(parsed.ligacoes_entre_raizes), JSON.stringify(context.ligacoes_entre_raizes), 'preserva todos os caminhos')
  assert(parsed.entidades.some((e) => e.id === 'ipes'), 'mantém intermediário')
  for (const id of ['PR4-E017', 'PR4-E018', 'E219']) {
    const relation = parsed.relacoes.find((r) => r.id === id)
    assert(relation, `mantém ${id}`)
    assert(relation.afirmacao!.length <= 300, 'encurta afirmação')
    assert(relation.limite!.length <= 300, 'encurta limitações')
  }
  assert(parsed.fontes.some((s) => s.id === 'bridge_source'), 'mantém fonte citada')
  eq(parsed.fontes.find((s) => s.id === 'bridge_source')?.url, 'https://fixture.example/path', 'URL não é cortada')
  eq(JSON.stringify(context), original, 'sem mutação')
})

Deno.test('SPEC3 casos e notas muito longos ainda preservam recorte com raízes', () => {
  const context: ChatContextPayload = {
    raizes: [{ id: 'rockefeller', nome: 'Rockefeller' }],
    entidades: [{ id: 'rockefeller', nome: 'Rockefeller', nota: 'n'.repeat(50000) }],
    relacoes: [{ id: 'r1', afirmacao: 'a'.repeat(50000) }], fontes: [],
    casos: Array.from({ length: 3 }, () => ({ conclusao: 'c'.repeat(50000), mecanismo: 'm'.repeat(50000) })),
  }
  const bound = boundContextJson(context)
  const parsed = JSON.parse(bound)
  assert(bound.length <= 16000 && !parsed.truncado, 'cabe sem stub')
  eq(parsed.raizes[0].id, 'rockefeller', 'mantém raiz')
  eq(parsed.casos.length, 0, 'pode remover todos os casos')
})

Deno.test('SPEC3 prompt distingue temas documentados, ausência de ligação e caminho indireto', () => {
  const context: ChatContextPayload = { raizes: [], entidades: [], relacoes: [], fontes: [] }
  for (const modelo of ['basico', 'avancado'] as const) {
    const prompt = buildSystemPrompt(modelo, context)
    assert(prompt.includes('só quando o recorte não sustenta nenhum dos temas'), 'sem_base limitado à falta de temas')
    // R2: sem frase de lacuna; a resposta conta os caminhos documentados e marca a tese.
    assert(prompt.includes('O que liga tudo:'), 'veredito no último parágrafo')
    assert(prompt.includes('pontes_entre_raizes'), 'caminhos entre temas')
    assert(/caminho por intermediário|intermediário não é ligação direta/i.test(prompt), 'não transforma contato em prova direta')
    assert(prompt.includes('TRAVA LEGAL') || /crime|ilícit/.test(prompt), 'trava legal')
  }
})

// Minimal synthetic fixture: the two themes have independent documentary edges.
function semLigacaoContext(): ChatContextPayload {
  return {
    raizes: [
      { id: 'golpe64', nome: 'Golpe de 1964 · evento', tipo: 'evento' },
      { id: 'heitor_lyra', nome: 'Heitor Lyra · diplomata', tipo: 'pessoa' },
    ],
    entidades: [
      { id: 'ipes', nome: 'IPES', tipo: 'instituicao' },
      { id: 'papacy', nome: 'Santa Sé', tipo: 'instituicao' },
    ],
    relacoes: [
      { id: 'heitor_primeira', origem: 'heitor_lyra', destino: 'papacy',
        afirmacao: 'Heitor Lyra foi embaixador junto à Santa Sé.', fontes: ['H1', 'ausente'], estado: 'historico' },
      { id: 'golpe_primeira', origem: 'ipes', destino: 'golpe64',
        afirmacao: 'O IPES aparece na documentação do golpe de 1964.', fontes: ['G1'] },
      { id: 'heitor_segunda', origem: 'heitor_lyra', destino: 'papacy',
        afirmacao: 'Esta relação tem prioridade menor.', fontes: ['H1'] },
    ],
    fontes: [
      { id: 'H1', titulo: 'Registro diplomático', url: 'https://fixture.test/heitor', localizador: 'p. 1' },
      { id: 'G1', titulo: 'Registro do IPES' },
    ],
    ligacoes_entre_raizes: [],
  }
}

const SEM_LIGACAO_AVISO = 'Resposta montada direto da base: a ligação pedida não está documentada.'
const SEM_COBRANCA_AVISO = 'Sem cobrança: a ligação pedida não está documentada.'
const RELEASE_FALHOU_AVISO = 'Esta resposta não é cobrada, mas a devolução da reserva falhou; o saldo pode aparecer reduzido até a correção.'

function assertReleaseFailureLog(args: unknown[], pedidoId: string, _modelo: Modelo, kind: 'free' | 'paid') {
  eq(args.length, 1, 'um JSON estruturado')
  const row = JSON.parse(String(args[0]))
  eq(row.evento, 'chat_release_failed', 'evento estável')
  eq(row.pedido_id, pedidoId, 'correlacionador do servidor')
  eq(row.kind, kind, 'classificação da reserva')
  eq(Object.keys(row).sort().join(','), 'evento,kind,pedido_id', 'só campos permitidos')
}

Deno.test('SPEC4 fallback de dois temas gera três blocos com citações válidas', () => {
  const context = semLigacaoContext()
  const original = JSON.stringify(context)
  const answer = fallbackSemLigacao(context)
  assert(answer, 'fallback disponível')
  eq(answer.sem_base, false, 'tem base para os temas')
  eq(answer.blocos.length, 3, 'dois temas e a lacuna')
  const [golpe, heitor, lacuna] = answer.blocos
  assert(golpe.tipo === 'documentado' && heitor.tipo === 'documentado' && lacuna.tipo === 'documentado', 'só blocos documentados')
  eq(golpe.texto, 'Golpe de 1964: O IPES aparece na documentação do golpe de 1964.', 'ordem das raízes e nome sem sufixo')
  eq(JSON.stringify(golpe.entidades), JSON.stringify(['golpe64', 'ipes']), 'cita raiz e outro extremo, mesmo sendo destino')
  eq(JSON.stringify(golpe.relacoes), JSON.stringify(['golpe_primeira']), 'primeira relação que toca a raiz')
  eq(heitor.texto, 'Heitor Lyra: Heitor Lyra foi embaixador junto à Santa Sé.', 'não usa relação de menor prioridade')
  eq(JSON.stringify(heitor.entidades), JSON.stringify(['heitor_lyra', 'papacy']), 'cita raiz na origem e outro extremo')
  eq(JSON.stringify(heitor.relacoes), JSON.stringify(['heitor_primeira']), 'cita a primeira relação de Heitor')
  eq(JSON.stringify(heitor.fontes), JSON.stringify(['H1']), 'só fontes presentes no recorte')
  eq(lacuna.texto, 'O atlas não documenta ligação direta entre Golpe de 1964 e Heitor Lyra.', 'lacuna explícita')
  eq(JSON.stringify([lacuna.entidades, lacuna.relacoes, lacuna.fontes]), '[[],[],[]]', 'lacuna sem citações')
  for (const bloco of answer.blocos) {
    assert(bloco.tipo === 'documentado', 'documentado')
    assert(bloco.entidades.every((id) => [...context.raizes, ...context.entidades].some((e) => e.id === id)), 'entidades válidas')
    assert(bloco.relacoes.every((id) => context.relacoes.some((r) => r.id === id)), 'relações válidas')
    assert(bloco.fontes.every((id) => context.fontes.some((f) => f.id === id)), 'fontes válidas')
  }
  eq(answer.fontes_detalhe.H1.url, 'https://fixture.test/heitor', 'detalhes pelo saneamento normal')
  eq(answer.fontes_detalhe.H1.localizador, 'p. 1', 'localizador preservado')
  assert(answer.avisos.some((a) => a.tipo === 'estado' && a.relacao === 'heitor_primeira'), 'aviso de estado preservado')
  assert(answer.avisos.some((a) => a.tipo === 'outro' && a.texto === SEM_LIGACAO_AVISO), 'aviso do fallback')
  eq(JSON.stringify(context), original, 'função pura, sem mutar contexto')
})

Deno.test('SPEC4 fallback aceita ligação ausente, nota e três nomes sem HTML', () => {
  const context = semLigacaoContext()
  delete context.ligacoes_entre_raizes
  context.raizes[0].nome = '<b>Golpe de 1964</b> · evento'
  context.relacoes[0].afirmacao = `<b>${'a'.repeat(450)}</b>`
  context.raizes.push({ id: 'arquivo', nome: 'Arquivo · acervo', tipo: 'instituicao' })
  context.entidades.push({ id: 'arquivo', nota: '<p>Nota documental do arquivo.</p>' })
  const answer = fallbackSemLigacao(context)
  assert(answer, 'usa nota de raiz sem relação')
  eq(answer.blocos.length, 4, 'três temas e a lacuna')
  eq(answer.blocos[1].texto, `Heitor Lyra: ${'a'.repeat(400)}`, 'afirmação limitada a 400 caracteres sem tags')
  eq(answer.blocos[2].texto, 'Arquivo: Nota documental do arquivo.', 'nota sem HTML')
  eq(answer.blocos[3].texto, 'O atlas não documenta ligação direta entre Golpe de 1964, Heitor Lyra e Arquivo.', 'lista de três nomes sem sufixos')
  assert(answer.blocos.every((b) => !/[<>]/.test(b.texto)), 'texto simples')
})

Deno.test('SPEC4 fallback retorna null sem dois temas aproveitáveis ou com ligação', () => {
  for (const count of [0, 1]) {
    const context = semLigacaoContext()
    context.raizes = context.raizes.slice(0, count)
    eq(fallbackSemLigacao(context), null, `${count} raiz não ativa fallback`)
  }
  const linked = semLigacaoContext()
  linked.ligacoes_entre_raizes = [{ de: 'golpe64', para: 'heitor_lyra', via: null, relacoes: ['ligacao'] }]
  eq(fallbackSemLigacao(linked), null, 'não contradiz ligação documentada')
  const missing = semLigacaoContext()
  missing.relacoes = missing.relacoes.filter((r) => r.origem !== 'heitor_lyra')
  eq(fallbackSemLigacao(missing), null, 'raiz sem relação nem nota é pulada')
  const unsourced = semLigacaoContext()
  unsourced.fontes = unsourced.fontes.filter((f) => f.id !== 'H1')
  eq(fallbackSemLigacao(unsourced), null, 'saneamento continua recusando pessoa sem fonte')
})

const GS009 = 'O Oswaldo Aranha era parente dos Egydio de Souza Aranha do Itaú?'
async function streamSemLigacao(context: ChatContextPayload, raw: string, opts: { store?: MemoryChatDb; modelo?: Modelo; mensagem?: string; repetirCurto?: boolean } = {}) {
  const store = opts.store ?? db()
  store.chatContext = async () => context
  const prepared = await prepareChat({ userId: USER, body: request({ modelo: opts.modelo ?? 'basico', mensagem: opts.mensagem ?? GS009, contexto: { entidades: [] } }), db: store, clock: CLOCK, inferenceKey: acceptedKey() })
  assert(prepared.ok, 'pedido preparado com reservas')
  const model = scripted([{ delta: raw }, { usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.0002 } }])
  const emitted: ChatSseEvent[] = []
  const httpStatus = await streamPrepared({
    prepared, db: store, openrouter: model.client,
    signal: new AbortController().signal, emit: (event) => emitted.push(event),
    repetirCurto: opts.repetirCurto ?? false,
  })
  return { store, model, result: { httpStatus, events: emitted } }
}

Deno.test('F1c(a): sem_base:true com documentado válido responde, cobra e loga sem_base_ignorado', async () => {
  const store = db()
  const info: string[] = []
  const orig = console.info
  console.info = (msg: string) => info.push(msg)
  try {
    const model = scripted([{ delta: answerJson({ sem_base: true }) }, { usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.0002 } }])
    const result = await chat({ database: store, openrouter: model.client, inferenceKey: acceptedKey(), repetirCurto: false })
    eq(result.httpStatus, 200, 'http')
    const final = finalOf(result)
    eq(final.blocos.length, 2, 'resposta do modelo mantida')
    eq(final.gratis_restantes, 19, 'um crédito debitado')
    eq(final.custo_real, 0.0002, 'custo real cobrado')
    const state = store.snapshot(USER, CLOCK())
    eq(state.used, 1, 'débito')
    eq(state.releaseCalls, 0, 'não libera')
    eq(state.logs[0].status, 'ok_sem_base_ignorado', 'contador no log existente')
    eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.0002, 'orçamento liquidado')
    const ev = JSON.parse(info.find((m) => m.includes('sem_base_ignorado')) ?? '{}')
    eq(JSON.stringify(Object.keys(ev)), JSON.stringify(['evento']), 'log estruturado sem dado do usuário')
  } finally {
    console.info = orig
  }
  for (const blocos of [
    [{ tipo: 'documentado', texto: 'Sem fonte do recorte.', entidades: ['xx_fora'], relacoes: [], fontes: ['F_FORA'] }],
    [],
  ]) {
    const st = db()
    const model = scripted([{ delta: answerJson({ sem_base: true, blocos }) }])
    const result = await chat({ database: st, openrouter: model.client, inferenceKey: acceptedKey(), repetirCurto: false })
    eq((events(result, 'error')[0]?.data as { code?: string })?.code, 'fora_da_base', `fora_da_base com ${blocos.length} bloco(s) inválido(s)`)
    eq(st.snapshot(USER, CLOCK()).used, 0, 'sem débito')
  }
})

Deno.test('F1c(b): a pergunta estrutural fecha o último bloco sem chave nova; em_aberto do modelo não entra; sem_base com blocos vazios segue fora_da_base', async () => {
  const pergunta = 'O que o recorte ainda deixa em aberto?'
  const fim = 'A leitura não cria fato novo.\n\nQue documento do atlas detalharia o papel de Mauá?'
  for (const over of [{ em_aberto: pergunta }, {}, { em_aberto: null }] as const) {
    const model = scripted([{ delta: answerJson(over) }])
    const final = finalOf(await chat({ database: db(), openrouter: model.client, inferenceKey: acceptedKey() }))
    eq(final.blocos.length, 2, 'blocos mantidos')
    eq(final.blocos[1].texto, fim, 'texto do último bloco')
    assert(!('em_aberto' in final) && final.blocos.every((b) => !('em_aberto' in b)), 'contrato UX3a sem chave extra')
  }
  const st = db()
  const vazio = scripted([{ delta: answerJson({ sem_base: true, blocos: [], em_aberto: pergunta }) }])
  const result = await chat({ database: st, openrouter: vazio.client, inferenceKey: acceptedKey() })
  eq((events(result, 'error')[0]?.data as { code?: string })?.code, 'fora_da_base', 'em_aberto não salva resposta vazia')
  eq(st.snapshot(USER, CLOCK()).used, 0, 'sem débito')
})

Deno.test('F1d: nenhum id válido vira fora_da_base sem débito; 1 id cobra; sem_ligacao segue no fallback', async () => {
  const recusa = [
    { tipo: 'documentado', texto: 'O recorte não aborda o sentido da vida.', entidades: [], relacoes: [], fontes: [] },
    { tipo: 'inferencia', texto: 'Não é possível inferir isso dos dados.', base: [], justificativa: 'Sem base no recorte.' },
  ]
  const st = db()
  const result = await chat({ database: st, openrouter: scripted([{ delta: answerJson({ blocos: recusa }) }]).client, inferenceKey: acceptedKey() })
  eq((events(result, 'error')[0]?.data as { code?: string })?.code, 'fora_da_base', 'GS-012: recusa sem id')
  eq(st.snapshot(USER, CLOCK()).used, 0, 'sem débito')
  eq(st.snapshot(USER, CLOCK()).logs[0].status, 'fora_da_base', 'log fora_da_base')
  const umId = [{ ...recusa[0], texto: 'A relação r1 está no recorte.', relacoes: ['r1'] }]
  const st2 = db()
  const final = finalOf(await chat({ database: st2, openrouter: scripted([{ delta: answerJson({ blocos: umId }) }]).client, inferenceKey: acceptedKey() }))
  eq(final.blocos.length, 1, 'resposta com 1 id mantida')
  eq(st2.snapshot(USER, CLOCK()).used, 1, 'cobrada')
  const lacuna = [{ tipo: 'documentado', texto: 'O atlas não documenta ligação direta.', entidades: [], relacoes: [], fontes: [] }]
  // R2: o fallback canônico foi desligado; sem id válido vira fora_da_base sem débito.
  const { store, result: sl } = await streamSemLigacao(semLigacaoContext(), answerJson({ blocos: lacuna }))
  eq((events(sl, 'error')[0]?.data as { code?: string })?.code, 'fora_da_base', 'sem_ligacao: fora_da_base')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'sem débito')
})

Deno.test('F1e: frase canônica de lacuna entre raízes; não duplica; não entra com ligação afirmada', async () => {
  const doc = (texto: string) => ({ tipo: 'documentado', texto, entidades: ['heitor_lyra'], relacoes: ['heitor_primeira'], fontes: ['H1'] })
  const canonica = 'O atlas não documenta ligação direta entre Golpe de 1964 e Heitor Lyra.'
  const { store, result } = await streamSemLigacao(semLigacaoContext(), answerJson({ blocos: [doc('O atlas não documenta parentesco entre Heitor Lyra e o golpe.')] }))
  const final = finalOf(result)
  // R2: a frase canônica de lacuna não é mais acrescentada (pedido do Hernandes).
  eq(final.blocos.length, 1, 'GS-009: sem bloco de lacuna')
  assert(!final.blocos.some((b: ChatBloco) => b.texto === canonica), 'frase canônica fora da UI')
  eq(store.snapshot(USER, CLOCK()).used, 1, 'cobrança inalterada')
  const { result: dup } = await streamSemLigacao(semLigacaoContext(), answerJson({ blocos: [doc('O atlas nao documenta ligacao direta entre os dois.')] }))
  eq(finalOf(dup).blocos.length, 1, 'frase já presente: não duplica')
  const ctx = semLigacaoContext()
  const lacunas = [{ de: 'heitor_lyra', para: 'papacy', marcador: 'sem ligação direta documentada' as const }]
  eq(fraseLacunaFaltante([doc('Heitor Lyra foi embaixador junto à Santa Sé.')] as ChatBloco[], ctx, lacunas), null, 'relação citada liga o par: não acrescenta')
})

Deno.test('F1e(b): frase só em pergunta de ligação; caminho/inferência e GS-001 ficam sem ela', async () => {
  const doc = { tipo: 'documentado', texto: 'Heitor Lyra foi embaixador.', entidades: ['heitor_lyra'], relacoes: ['heitor_primeira'], fontes: ['H1'] }
  const tem = (r: { events: ChatSseEvent[] }) => finalOf(r).blocos.some((b: ChatBloco) => b.texto.includes('não documenta ligação direta'))
  for (const q of ['Os Rockefeller participaram do golpe de 1964 no Brasil?', 'Por qual caminho indireto o Heitor Lyra chega ao golpe de 1964?',
    'O Walther Moreira Sales e o Heitor Lyra eram do IPES?']) {
    eq(tem((await streamSemLigacao(semLigacaoContext(), answerJson({ blocos: [doc] }), { mensagem: q })).result), false, `sem frase: ${q}`)
  }
  eq(tem((await streamSemLigacao(semLigacaoContext(), answerJson({ blocos: [doc] }))).result), false, 'R2: GS-009 também sem a frase')
  eq(perguntaDeLigacao('Qual a relação entre Heitor Lyra e o golpe?'), true, 'relação')
  eq(perguntaDeLigacao('Há vínculo ou conexão entre eles?'), true, 'vínculo/conexão')
})

// R2: fallback sem_ligacao desligado (o caminho não é mais alcançável); coberto por chat_r2_test.ts 'sem conteúdo vira fora_da_base'.
Deno.test.ignore('SPEC4 streamPrepared sem_base em dois temas sem ligação termina ok sem débito e libera reserva grátis', async () => {
  const store = db()
  store.setUsed(USER, 4)
  store.setPaid(USER, 32)
  const before = store.snapshot(USER, CLOCK())
  const { model, result } = await streamSemLigacao(semLigacaoContext(), answerJson({ sem_base: true, blocos: [] }), { store })
  eq(result.httpStatus, 200, 'sucesso')
  eq(model.calls.length, 1, 'uma chamada ao modelo')
  eq(terminals(result).length, 1, 'um terminal')
  const final = finalOf(result)
  eq(final.blocos.length, 3, 'resposta determinística completa')
  assert(final.blocos.some((b) => b.texto.startsWith('O atlas não documenta ligação')), 'lacuna no final')
  eq(final.gratis_restantes, 16, 'cota após liberar a reserva grátis')
  eq(final.saldo_pago, before.paid, 'saldo pago preservado no final')
  eq(final.custo_real, 0.0002, 'custo real mantido')
  eq(final.fontes_detalhe.H1.titulo, 'Registro diplomático', 'detalhes das fontes presentes')
  assert(final.avisos.some((a) => a.texto === SEM_LIGACAO_AVISO), 'aviso no final')
  assert(final.avisos.some((a) => a.tipo === 'outro' && a.texto === SEM_COBRANCA_AVISO), 'aviso de gratuidade no final')
  const state = store.snapshot(USER, CLOCK())
  eq(state.reserveCalls, 1, 'uma reserva')
  eq(state.commitCalls, 0, 'sem commit de crédito')
  eq(state.releaseCalls, 1, 'libera a reserva uma vez')
  eq(state.used, before.used, 'cota usada preservada')
  eq(state.reserved, before.reserved, 'reservas voltam ao valor anterior')
  eq(state.paid, before.paid, 'saldo pago inalterado')
  eq(state.ledger.filter((r) => r.reason === 'chat_debit').length, 0, 'ledger sem débito')
  eq(state.ledger.filter((r) => r.reason === 'chat_reserve_release').length, 1, 'liberação registrada no ledger')
  eq(state.ledger.reduce((sum, r) => sum + r.delta, 0), 0, 'ledger sem gasto líquido')
  eq(state.logs.length, 1, 'um log')
  eq(state.logs[0].status, 'ok', 'log de sucesso')
  eq(state.logs[0].custo_usd, 0.0002, 'log preserva custo da API')
  eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.0002, 'orçamento liquidado normalmente')
  eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'orçamento sem reserva pendente')
})

// R2: fallback sem_ligacao desligado (o caminho não é mais alcançável); coberto por chat_r2_test.ts 'sem conteúdo vira fora_da_base'.
Deno.test.ignore('CRED1 sem_ligacao no Avançado devolve os oito pagos sem alterar cota grátis', async () => {
  const store = db()
  store.setUsed(USER, 6)
  store.setPaid(USER, 24)
  const before = store.snapshot(USER, CLOCK())
  const { result } = await streamSemLigacao(semLigacaoContext(), answerJson({ sem_base: true, blocos: [] }), { store, modelo: 'avancado' })
  eq(result.httpStatus, 200, 'sucesso')
  eq(terminals(result).length, 1, 'um terminal')
  const final = finalOf(result)
  assert(final.blocos.some((b) => b.texto.startsWith('O atlas não documenta ligação')), 'fallback no final')
  eq(final.gratis_restantes, 14, 'cota grátis preservada no final')
  eq(final.saldo_pago, before.paid, 'oito créditos devolvidos no final')
  const state = store.snapshot(USER, CLOCK())
  eq(state.used, before.used, 'uso grátis inalterado')
  eq(state.reserved, before.reserved, 'reserva grátis inalterada')
  eq(state.paid, before.paid, 'saldo pago restaurado')
  eq(state.commitCalls, 0, 'sem commit')
  eq(state.releaseCalls, 1, 'libera uma vez')
  eq(state.ledger.filter((r) => r.reason === 'chat_debit').length, 0, 'ledger sem débito confirmado')
  eq(state.ledger.find((r) => r.reason === 'chat_reserve')?.delta, -8, 'reserva paga de oito')
  eq(state.ledger.find((r) => r.reason === 'chat_reserve_release')?.delta, 8, 'devolução de oito')
  eq(state.ledger.reduce((sum, r) => sum + r.delta, 0), 0, 'ledger sem gasto líquido')
  eq(state.logs.length, 1, 'log gravado')
  eq(state.logs[0].status, 'ok', 'status de sucesso preservado')
  eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.0002, 'custo real da API mantido')
  eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'budget liquidado')
})

// R2: fallback sem_ligacao desligado (o caminho não é mais alcançável); coberto por chat_r2_test.ts 'sem conteúdo vira fora_da_base'.
Deno.test.ignore('CRED1 sem_ligacao no Básico com cota esgotada também devolve o crédito pago', async () => {
  const store = db()
  store.setUsed(USER, 20)
  store.setPaid(USER, 16)
  const { result } = await streamSemLigacao(semLigacaoContext(), answerJson({ sem_base: true, blocos: [] }), { store })
  const final = finalOf(result)
  eq(final.gratis_restantes, 0, 'não cria cota grátis')
  eq(final.saldo_pago, 16, 'saldo após devolver o pago')
  const state = store.snapshot(USER, CLOCK())
  eq(state.paid, 16, 'nenhum pago gasto')
  eq(state.used, 20, 'cota usada preservada')
  eq(state.reserved, 0, 'nenhuma reserva grátis')
  eq(state.commitCalls, 0, 'sem commit')
  eq(state.releaseCalls, 1, 'libera uma vez')
  eq(state.ledger.find((r) => r.reason === 'chat_reserve')?.delta, -1, 'reserva de um pago')
  eq(state.ledger.find((r) => r.reason === 'chat_reserve_release')?.delta, 1, 'devolve um pago')
  eq(state.ledger.filter((r) => r.reason === 'chat_debit').length, 0, 'sem débito confirmado')
})

// R2: fallback sem_ligacao desligado (o caminho não é mais alcançável); coberto por chat_r2_test.ts 'sem conteúdo vira fora_da_base'.
Deno.test.ignore('CRED1 sem_ligacao retorna os saldos atuais após pedidos concorrentes', async () => {
  for (const { modelo, used } of [
    { modelo: 'basico', used: 4 },
    { modelo: 'avancado', used: 4 },
    { modelo: 'basico', used: 20 },
  ] as const) {
    const store = db()
    store.setUsed(USER, used)
    store.setPaid(USER, 24)
    store.chatContext = async () => semLigacaoContext()
    const model = scripted(async function* () {
      // Outros pedidos alteram as duas cotas depois da reserva deste stream.
      for (const concurrentModelo of ['basico', 'avancado'] as const) {
        const reservation = await store.reserveCredits(USER, concurrentModelo, crypto.randomUUID(), CLOCK())
        assert(reservation.ok, 'reserva concorrente aceita')
        await store.commitCredits(reservation)
      }
      yield { delta: answerJson({ sem_base: true, blocos: [] }) }
      yield { usage: { cost: 0.0002 } }
    })
    const result = await chat({ database: store, body: request({ modelo, contexto: { entidades: [] } }), openrouter: model.client, inferenceKey: acceptedKey() })
    eq(result.httpStatus, 200, 'sucesso')
    eq(terminals(result).length, 1, 'um terminal')
    const final = finalOf(result)
    eq(final.gratis_restantes, used === 20 ? 0 : 15, 'cota atual inclui o pedido concorrente')
    eq(final.saldo_pago, used === 20 ? 15 : 16, 'saldo atual inclui os débitos concorrentes')
    const state = store.snapshot(USER, CLOCK())
    eq(final.gratis_restantes, 20 - state.used - state.reserved, 'final coincide com a cota no banco')
    eq(final.saldo_pago, state.paid, 'final coincide com o saldo pago no banco')
    eq(state.reserved, 0, 'nenhuma reserva grátis pendente')
    eq(state.releaseCalls, 1, 'reserva do stream liberada uma vez')
    eq(state.commitCalls, 2, 'só os pedidos concorrentes são cobrados')
    assert(!state.ledger.some((r) => r.pedidoId === store.reservedPedidos[0] && r.reason === 'chat_debit'), 'sem débito do fallback')
    assert(final.avisos.some((a) => a.texto === SEM_COBRANCA_AVISO), 'liberação confirmada')
  }
})

// R2: fallback sem_ligacao desligado (o caminho não é mais alcançável); coberto por chat_r2_test.ts 'sem conteúdo vira fora_da_base'.
Deno.test.ignore('REL1 ponta a ponta: fallback grátis, documentado + F1e cobra 1, fora_da_base grátis, saldos certos sob concorrência', async () => {
  const doc = { tipo: 'documentado', texto: 'Resposta do modelo.', entidades: ['golpe64', 'ipes'], relacoes: ['golpe_primeira'], fontes: ['G1'] }
  const recusa = [{ tipo: 'documentado', texto: 'Não há base para isso.', entidades: [], relacoes: [], fontes: [] }]
  const run = async (raw: string, ctx = semLigacaoContext(), concorrentes = 0) => {
    const store = db()
    store.setUsed(USER, 4)
    store.setPaid(USER, 24)
    store.chatContext = async () => ctx
    const model = scripted(async function* () {
      for (let i = 0; i < concorrentes; i++) {
        const r = await store.reserveCredits(USER, 'basico', crypto.randomUUID(), CLOCK())
        assert(r.ok, 'reserva concorrente')
        await store.commitCredits(r)
      }
      yield { delta: raw }
      yield { usage: { cost: 0.0002 } }
    })
    const result = await chat({ database: store, body: request({ modelo: 'basico', contexto: { entidades: [] } }), openrouter: model.client, inferenceKey: acceptedKey() })
    return { result, state: store.snapshot(USER, CLOCK()) }
  }
  const fb = await run(answerJson({ sem_base: true, blocos: [] }))
  eq(finalOf(fb.result).blocos.length, 3, '1: fallback sem_ligacao')
  eq(fb.state.used, 4, '1: não cobra')
  eq(fb.state.commitCalls, 0, '1: sem commit')
  const f1e = await run(answerJson({ blocos: [doc] }))
  const final = finalOf(f1e.result)
  eq(final.blocos.at(-1)?.texto.startsWith('O atlas não documenta ligação direta entre'), true, '2: frase da F1e')
  eq(f1e.state.used, 5, '2: cobra 1')
  eq(final.gratis_restantes, 15, '2: saldo do commit')
  const uma = semLigacaoContext()
  uma.raizes = uma.raizes.slice(0, 1)
  const fora = await run(answerJson({ sem_base: true, blocos: [] }), uma)
  eq((events(fora.result, 'error')[0]?.data as { code?: string })?.code, 'fora_da_base', '3: fora_da_base')
  eq(fora.state.used, 4, '3: não cobra')
  for (const [raw, cobra] of [[answerJson({ blocos: recusa }), false], [answerJson({ sem_base: true, blocos: [doc] }), true]] as const) {
    const c = await run(raw, semLigacaoContext(), 2)
    const f = finalOf(c.result)
    eq(c.state.used, 4 + 2 + (cobra ? 1 : 0), `4: ${cobra ? 'F1c(a) cobra' : 'F1d → fallback grátis'} além dos 2 concorrentes`)
    eq(f.gratis_restantes, 20 - c.state.used - c.state.reserved, '4: final coincide com a cota no banco')
    eq(f.saldo_pago, c.state.paid, '4: saldo pago coincide')
    eq(c.state.reserved, 0, '4: sem reserva pendente')
  }
})

// R2: fallback sem_ligacao desligado (o caminho não é mais alcançável); coberto por chat_r2_test.ts 'sem conteúdo vira fora_da_base'.
Deno.test.ignore('CRED1 sem_ligacao com release noop sem saldos preserva o pós-reserva', async () => {
  for (const modelo of ['basico', 'avancado'] as const) {
    const store = db()
    store.setPaid(USER, 24)
    const release = store.releaseReserve.bind(store)
    store.releaseReserve = async (reservation) => {
      await release(reservation)
      return await release(reservation)
    }
    const { result } = await streamSemLigacao(semLigacaoContext(), answerJson({ sem_base: true, blocos: [] }), { store, modelo })
    const final = finalOf(result)
    eq(final.gratis_restantes, modelo === 'basico' ? 19 : 20, 'sem cota atual retornada, mantém o pós-reserva')
    eq(final.saldo_pago, modelo === 'avancado' ? 16 : 24, 'sem saldo atual retornado, mantém o pós-reserva')
    assert(final.avisos.some((a) => a.texto === SEM_COBRANCA_AVISO), 'noop é sucesso')
    assert(!final.avisos.some((a) => a.texto === RELEASE_FALHOU_AVISO), 'noop não é falha')
    const state = store.snapshot(USER, CLOCK())
    eq(state.paid, 24, 'sem devolução duplicada')
    eq(state.reserved, 0, 'reserva liberada')
    eq(state.commitCalls, 0, 'sem cobrança')
    eq(state.ledger.filter((r) => r.reason === 'chat_reserve_release').length, 1, 'uma liberação efetiva')
  }
})

// R2: fallback sem_ligacao desligado (o caminho não é mais alcançável); coberto por chat_r2_test.ts 'sem conteúdo vira fora_da_base'.
Deno.test.ignore('CRED1 falha no release não confirma nem repete a cobrança e mantém budget, final e log', async () => {
  const calls: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { calls.push(args) }
  try {
    for (const modelo of ['basico', 'avancado'] as const) {
      for (const applied of [false, true]) {
        const store = db()
        store.setPaid(USER, 24)
        const release = store.releaseReserve.bind(store)
        let attempts = 0
        store.releaseReserve = async (reservation) => {
          attempts++
          if (applied) await release(reservation)
          throw new Error('falha de teste: detalhe não deve ser logado')
        }
        const before = calls.length
        const { result } = await streamSemLigacao(semLigacaoContext(), answerJson({ sem_base: true, blocos: [] }), { store, modelo })
        eq(attempts, 1, 'liberação não é repetida após falha ambígua')
        eq(result.httpStatus, 200, 'final continua disponível')
        eq(terminals(result).length, 1, 'um terminal')
        const final = finalOf(result)
        assert(final.blocos.some((b) => b.texto.startsWith('O atlas não documenta ligação')), 'resposta preservada')
        assert(final.avisos.some((a) => a.tipo === 'outro' && a.texto === RELEASE_FALHOU_AVISO), 'avisa devolução não confirmada')
        assert(!final.avisos.some((a) => a.texto === SEM_COBRANCA_AVISO), 'não afirma liberação confirmada')
        eq(final.gratis_restantes, modelo === 'basico' ? 19 : 20, 'não anuncia devolução grátis não confirmada')
        eq(final.saldo_pago, modelo === 'avancado' ? 16 : 24, 'não anuncia devolução paga não confirmada')
        const state = store.snapshot(USER, CLOCK())
        eq(state.commitCalls, 0, 'nunca tenta confirmar crédito após falha')
        eq(state.used, 0, 'nenhuma cota consumida')
        eq(state.reserved, modelo === 'basico' && !applied ? 1 : 0, 'estado real da reserva preservado')
        eq(state.paid, modelo === 'avancado' && !applied ? 16 : 24, 'sem cobrança ou devolução duplicada')
        eq(state.ledger.filter((r) => r.reason === 'chat_debit').length, 0, 'sem débito confirmado')
        eq(state.logs.length, 1, 'log não é bloqueado pela falha')
        eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.0002, 'falha de crédito não bloqueia custo da API')
        eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'budget liquidado')
        const logged = calls.slice(before)
        eq(logged.length, 1, 'uma label por falha')
        assertReleaseFailureLog(logged[0], store.reservedPedidos[0], modelo, modelo === 'basico' ? 'free' : 'paid')
      }
    }
  } finally {
    console.error = originalError
  }
  eq(calls.length, 4, 'uma label por falha')
  assert(calls.every((args) => JSON.parse(String(args[0])).evento === 'chat_release_failed'), 'apenas label segura existente, sem detalhe do erro')
  assert(calls.every((args) => !JSON.stringify(args).includes('falha de teste')), 'sem detalhe do erro')
})

// R2: fallback sem_ligacao desligado (o caminho não é mais alcançável); coberto por chat_r2_test.ts 'sem conteúdo vira fora_da_base'.
Deno.test.ignore('CRED1 sem_ligacao com release recusado avisa sem devolver e não cobra', async () => {
  const calls: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { calls.push(args) }
  try {
    for (const modelo of ['basico', 'avancado'] as const) {
      const store = db()
      store.releaseRefuse = true
      store.setPaid(USER, 24)
      const before = calls.length
      const { result } = await streamSemLigacao(semLigacaoContext(), answerJson({ sem_base: true, blocos: [] }), { store, modelo })
      eq(result.httpStatus, 200, 'final continua disponível')
      eq(terminals(result).length, 1, 'um terminal')
      const final = finalOf(result)
      assert(final.blocos.some((b) => b.texto.startsWith('O atlas não documenta ligação')), 'resposta preservada')
      assert(final.avisos.some((a) => a.tipo === 'outro' && a.texto === RELEASE_FALHOU_AVISO), 'aviso honesto exato')
      assert(!final.avisos.some((a) => a.texto === SEM_COBRANCA_AVISO), 'não afirma liberação confirmada')
      eq(final.gratis_restantes, modelo === 'basico' ? 19 : 20, 'saldo grátis pós-reserva')
      eq(final.saldo_pago, modelo === 'avancado' ? 16 : 24, 'saldo pago pós-reserva')
      const state = store.snapshot(USER, CLOCK())
      eq(state.commitCalls, 0, 'sem commitCredits')
      eq(state.releaseCalls, 1, 'uma tentativa de release, sem segunda')
      eq(state.used, 0, 'cota usada intacta')
      eq(state.reserved, modelo === 'basico' ? 1 : 0, 'cota reservada não volta')
      eq(state.paid, modelo === 'avancado' ? 16 : 24, 'saldo pago não volta')
      eq(state.ledger.filter((row) => row.reason === 'chat_debit').length, 0, 'sem débito confirmado')
      eq(state.ledger.filter((row) => row.reason === 'chat_reserve_release').length, 0, 'recusa não grava ledger de liberação')
      eq(state.logs.length, 1, 'log gravado')
      eq(state.logs[0].status, 'ok', 'status do chat preservado')
      const logged = calls.slice(before)
      eq(logged.length, 1, 'um console.error')
      assertReleaseFailureLog(logged[0], store.reservedPedidos[0], modelo, modelo === 'basico' ? 'free' : 'paid')
    }
  } finally {
    console.error = originalError
  }
})

Deno.test('CRED1 fora_da_base com release recusado segue erro sem cobrar', async () => {
  const calls: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { calls.push(args) }
  try {
    for (const modelo of ['basico', 'avancado'] as const) {
      const context = semLigacaoContext()
      context.raizes = context.raizes.slice(0, 1)
      const store = db()
      store.releaseRefuse = true
      store.setPaid(USER, 24)
      const before = calls.length
      const { result } = await streamSemLigacao(context, answerJson({ sem_base: true, blocos: [] }), { store, modelo })
      eq(result.httpStatus, 200, 'stream já aberto')
      const terminal = terminals(result)
      eq(terminal.length, 1, 'um terminal')
      assert(terminal[0].event === 'error', 'terminal de erro')
      eq(terminal[0].data.code, 'fora_da_base', 'código preservado')
      const state = store.snapshot(USER, CLOCK())
      eq(state.commitCalls, 0, 'não cobra')
      eq(state.releaseCalls, 1, 'uma tentativa de release')
      eq(state.reserved, modelo === 'basico' ? 1 : 0, 'reserva grátis presa')
      eq(state.paid, modelo === 'avancado' ? 16 : 24, 'pago não devolvido')
      eq(state.ledger.filter((row) => row.reason === 'chat_reserve_release').length, 0, 'sem ledger de liberação')
      eq(state.logs.length, 1, 'log gravado')
      eq(state.logs[0].status, 'fora_da_base', 'status preservado')
      const logged = calls.slice(before)
      eq(logged.length, 1, 'um console.error')
      assertReleaseFailureLog(logged[0], store.reservedPedidos[0], modelo, modelo === 'basico' ? 'free' : 'paid')
    }
  } finally {
    console.error = originalError
  }
})

// R2: fallback sem_ligacao desligado (o caminho não é mais alcançável); coberto por chat_r2_test.ts 'sem conteúdo vira fora_da_base'.
Deno.test.ignore('SPEC4 streamPrepared com blocos vazios também usa fallback', async () => {
  for (const modelo of ['basico', 'avancado'] as const) {
    const store = db()
    store.setPaid(USER, 24)
    const { result } = await streamSemLigacao(semLigacaoContext(), answerJson({ sem_base: false, blocos: [] }), { store, modelo })
    const final = finalOf(result)
    eq(final.blocos.length, 3, 'fallback mesmo sem flag sem_base')
    eq(final.gratis_restantes, 20, 'cota grátis no final restaurada')
    eq(final.saldo_pago, 24, 'saldo pago no final restaurado')
    eq(store.snapshot(USER, CLOCK()).used, 0, 'não consome grátis')
    eq(store.snapshot(USER, CLOCK()).paid, 24, 'não consome pagos')
    eq(store.snapshot(USER, CLOCK()).reserved, 0, 'reserva liberada')
    eq(store.snapshot(USER, CLOCK()).releaseCalls, 1, 'uma liberação')
    eq(store.snapshot(USER, CLOCK()).commitCalls, 0, 'sem commit')
  }
})

Deno.test('SPEC4 streamPrepared sem_base com uma raiz ou ligação continua fora_da_base', async () => {
  for (const [variant, modelo] of (['basico', 'avancado'] as const).flatMap((modelo) =>
    ['uma raiz', 'com ligação', 'tema sem documentação'].map((variant) => [variant, modelo] as const))) {
    const context = semLigacaoContext()
    if (variant === 'uma raiz') context.raizes = context.raizes.slice(0, 1)
    if (variant === 'com ligação') context.ligacoes_entre_raizes = [{ de: 'golpe64', para: 'heitor_lyra', via: null, relacoes: ['ligacao'] }]
    if (variant === 'tema sem documentação') context.relacoes = context.relacoes.filter((r) => r.origem !== 'heitor_lyra')
    const store = db()
    store.setPaid(USER, 24)
    const { result } = await streamSemLigacao(context, answerJson({ sem_base: true, blocos: [] }), { store, modelo })
    eq(result.httpStatus, 200, `${variant}: stream já aberto`)
    const terminal = terminals(result)
    eq(terminal.length, 1, `${variant}: um terminal`)
    assert(terminal[0].event === 'error', `${variant}: terminal de erro`)
    eq(terminal[0].data.code, 'fora_da_base', `${variant}: código preservado`)
    const state = store.snapshot(USER, CLOCK())
    eq(state.used, 0, `${variant}: não debita`)
    eq(state.commitCalls, 0, `${variant}: sem commit`)
    eq(state.releaseCalls, 1, `${variant}: devolve crédito uma vez`)
    eq(state.reserved, 0, `${variant}: crédito sem reserva pendente`)
    eq(state.paid, 24, `${modelo}: pagos devolvidos`)
    eq(state.ledger.filter((r) => r.reason === 'chat_debit').length, 0, `${modelo}: ledger sem débito confirmado`)
    eq(state.ledger.reduce((sum, r) => sum + r.delta, 0), 0, `${modelo}: ledger sem gasto líquido`)
    eq(state.logs.length, 1, `${variant}: um log`)
    eq(state.logs[0].status, 'fora_da_base', `${variant}: status preservado`)
    eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.0002, `${variant}: mantém custo da geração`)
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, `${variant}: orçamento liquidado`)
  }
})

Deno.test('SPEC4 streamPrepared preserva resposta válida do modelo em dois temas', async () => {
  for (const modelo of ['basico', 'avancado'] as const) {
    const store = db()
    store.setUsed(USER, 4)
    store.setPaid(USER, 24)
    const { result } = await streamSemLigacao(semLigacaoContext(), answerJson({
      entidades: [], fontes: [], avisos: [],
      blocos: [{ tipo: 'documentado', texto: 'Resposta do modelo.', entidades: ['golpe64', 'ipes'], relacoes: ['golpe_primeira'], fontes: ['G1'] }],
    }), { store, modelo, repetirCurto: false })
    const final = finalOf(result)
    eq(final.blocos.length, 1, 'R2: sem fallback e sem frase de lacuna')
    eq(final.blocos[0].texto, 'Resposta do modelo.\n\nQue documento do atlas detalharia a relação entre Golpe de 1964 e IPES?', 'texto preservado e pergunta do código')
    assert(!final.avisos.some((a) => a.texto === SEM_LIGACAO_AVISO), 'sem aviso de fallback')
    const state = store.snapshot(USER, CLOCK())
    eq(state.used, modelo === 'basico' ? 5 : 4, 'Básico consome um grátis; Avançado preserva cota')
    eq(state.paid, modelo === 'avancado' ? 16 : 24, 'Avançado consome oito pagos; Básico preserva saldo')
    eq(state.reserved, 0, 'reserva confirmada')
    eq(state.commitCalls, 1, 'um commit de crédito')
    eq(state.releaseCalls, 0, 'sem liberação')
    eq(state.ledger.filter((r) => r.reason === 'chat_debit').length, 1, 'um débito no ledger')
    eq(final.gratis_restantes, modelo === 'basico' ? 15 : 16, 'cota cobrada no final')
    eq(final.saldo_pago, state.paid, 'saldo cobrado no final')
    eq(state.logs.length, 1, 'um log')
    eq(state.logs[0].status, 'ok', 'log de sucesso')
    eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.0002, 'custo da API preservado')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'budget liquidado')
  }
})

Deno.test('CRED1 resposta documentada no Básico pago cobra um crédito e preserva a cota grátis', async () => {
  const store = db()
  store.setUsed(USER, 20)
  store.setPaid(USER, 16)
  const { result } = await streamSemLigacao(semLigacaoContext(), answerJson({
    entidades: [], fontes: [], avisos: [],
    blocos: [{ tipo: 'documentado', texto: 'Resposta do modelo.', entidades: ['golpe64', 'ipes'], relacoes: ['golpe_primeira'], fontes: ['G1'] }],
  }), { store, modelo: 'basico' })
  const final = finalOf(result)
  eq(final.blocos.length, 1, 'R2: sem fallback e sem frase de lacuna')
  eq(final.blocos[0].texto, 'Resposta do modelo.\n\nQue documento do atlas detalharia a relação entre Golpe de 1964 e IPES?', 'texto preservado e pergunta do código')
  assert(!final.avisos.some((a) => a.texto === SEM_COBRANCA_AVISO), 'resposta cobrada não avisa gratuidade')
  const state = store.snapshot(USER, CLOCK())
  eq(state.used, 20, 'cota grátis intacta')
  eq(state.reserved, 0, 'reserva paga confirmada')
  eq(state.paid, 15, 'um crédito pago debitado')
  eq(state.commitCalls, 1, 'um commit')
  eq(state.releaseCalls, 0, 'sem liberação')
  eq(state.ledger.filter((row) => row.reason === 'chat_debit').length, 1, 'débito confirmado')
  eq(state.ledger.find((row) => row.reason === 'chat_reserve')?.delta, -1, 'reserva de um pago')
  eq(final.gratis_restantes, 0, 'cota grátis esgotada no final')
  eq(final.saldo_pago, 15, 'final com saldo pago decrementado')
  eq(state.logs.length, 1, 'um log')
  eq(state.logs[0].status, 'ok', 'log de sucesso')
})

Deno.test('CRED1 pg releaseReserve retorna saldos atuais, lança em ok false e aceita noop', async () => {
  // O runner offline do Node não resolve npm:postgres. O Deno carrega o adaptador sem abrir conexão.
  if (typeof Deno.version === 'undefined') return
  const { adapt } = await import('./pg_chat_db.ts')
  const reservation: Reservation = {
    ok: true,
    userId: USER,
    kind: 'paid',
    cost: 1,
    day: '2026-11-05',
    pedidoId: '33333333-3333-4333-8333-333333333333',
    modelo: 'basico',
    gratis_restantes: 0,
    pago: 15,
  }
  const fakeSql = (payload: Record<string, unknown>) => {
    const tag = (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([{ result: payload }])
    return tag as never
  }
  let message = ''
  try {
    await adapt(fakeSql({ ok: false, code: 'sem_creditos' })).releaseReserve(reservation)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  eq(message, 'release recusado', 'ok false lança')
  eq(await adapt(fakeSql({ ok: true, noop: true })).releaseReserve(reservation), null, 'noop sem saldos não inventa valores')
  for (const balances of [{ gratis_restantes: 7, pago: 23 }, { gratis_restantes: 999, pago: 0 }]) {
    const released = await adapt(fakeSql({ ok: true, noop: false, ...balances })).releaseReserve(reservation)
    assert(released, 'release retornou saldos')
    eq(released.gratis_restantes, balances.gratis_restantes, 'repassa a cota retornada pelo banco')
    eq(released.pago, balances.pago, 'repassa o saldo pago retornado pelo banco')
  }
})

// LAT-FORA: raiz única casada só por palavra genérica vira fora_da_base antes do modelo.
function raizUnica(id: string, nome: string, tipo = 'empresa'): ChatContextPayload {
  return {
    raizes: [{ id, nome, tipo }],
    entidades: [{ id, nome, tipo, grau: 0 }, { id: 'ipes', nome: 'IPES', tipo: 'organizacao', grau: 1 }],
    relacoes: [{ id: 'PR1-E001', origem: id, destino: 'ipes', tipo: 'contribuiu', afirmacao: 'Contribuição documentada.', fontes: ['PR1-NF22'] }],
    fontes: [{ id: 'PR1-NF22', titulo: 'Fonte' }],
  } as ChatContextPayload
}
const SUL_AMERICA = 'Sul América Companhia Nacional de Seguros de Vida'
const GS012 = 'qual o sentido da vida?'
const norm = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim()

Deno.test('LAT-FORA trava: só raiz única casada por palavra genérica do nome', () => {
  eq([...GENERIC_CONTEXT_TOKENS].sort().join(','), 'anos,sentido,vida', 'lista espelha a 009')
  const gs012 = raizUnica('sul_america_vida', SUL_AMERICA)
  eq(onlyGenericRootMatch(gs012, [], norm(GS012)), true, 'GS-012 curto-circuita')
  eq(onlyGenericRootMatch(gs012, [], norm('O que é a vida?')), true, 'só «vida» também')
  // Casamento por nome: termo distintivo do nome da raiz.
  eq(onlyGenericRootMatch(gs012, [], norm('O que a Sul América Vida documenta?')), false, 'nome não curto-circuita')
  eq(onlyGenericRootMatch(gs012, [], norm('Sul América Seguros')), false, 'nome sem genérico não curto-circuita')
  // Casamento por apelido: a raiz não tem a palavra no nome, ou o termo do apelido não é genérico.
  eq(onlyGenericRootMatch(raizUnica('golpe64', 'Golpe de Estado · 1964', 'evento'), [], norm('o golpe militar')), false, 'apelido golpe militar não curto-circuita')
  eq(onlyGenericRootMatch(raizUnica('rockefeller', 'Rockefeller', 'familia'), [], norm('a família Rockefeller')), false, 'apelido família rockefeller não curto-circuita')
  eq(onlyGenericRootMatch(raizUnica('apelido_x', 'Companhia X Seguradora'), [], norm('a vida')), false, 'genérico fora do nome (apelido possível) não curto-circuita')
  // Duas raízes.
  const duas = raizUnica('sul_america_vida', SUL_AMERICA)
  duas.raizes.push({ id: 'dicasterio_vida_consagrada', nome: 'Dicastério para os Institutos de Vida Consagrada e Sociedades de Vida Apostólica', tipo: 'organizacao' })
  eq(onlyGenericRootMatch(duas, [], norm('vida')), false, 'duas raízes não curto-circuita')
  // Misto genérico + nome / sigla / ano.
  eq(onlyGenericRootMatch(gs012, [], norm('a vida do IBEC')), false, 'genérico + sigla não curto-circuita')
  eq(onlyGenericRootMatch(gs012, [], norm('a vida da Sul América')), false, 'genérico + nome não curto-circuita')
  eq(onlyGenericRootMatch(raizUnica('light_historica', 'Light · período dos anos 1960'), [], norm('nos anos 60')), false, 'genérico + ano não curto-circuita')
  eq(onlyGenericRootMatch(gs012, [], norm('qual o sentido da vida humana?')), false, 'termo não listado: na dúvida, modelo')
  // Ids explícitos, sem consulta, recorte vazio.
  eq(onlyGenericRootMatch(gs012, ['sul_america_vida'], null), false, 'ids explícitos não curto-circuita')
  eq(onlyGenericRootMatch(gs012, [], null), false, 'sem consulta')
  eq(onlyGenericRootMatch({ raizes: [], entidades: [], relacoes: [], fontes: [] }, [], norm(GS012)), false, 'recorte vazio fica com contextIsEmpty')
  const semNome = raizUnica('sul_america_vida', SUL_AMERICA)
  delete semNome.raizes[0].nome
  eq(onlyGenericRootMatch(semNome, [], norm(GS012)), false, 'raiz sem nome: na dúvida, modelo')
})

Deno.test('LAT-FORA GS-012: fora_da_base antes do modelo, sem meta e sem cobrança', async () => {
  const store = db()
  store.setUsed(USER, 4)
  store.setPaid(USER, 24)
  const queries: (string | null)[] = []
  store.chatContext = async (_ids, query) => {
    queries.push(query)
    return raizUnica('sul_america_vida', SUL_AMERICA)
  }
  const model = scripted([{ delta: answerJson({ sem_base: true, blocos: [] }) }])
  const result = await chat({
    database: store, body: request({ mensagem: 'Qual o sentido da vida?', contexto: { entidades: [] } }),
    openrouter: model.client, inferenceKey: acceptedKey(),
  })
  eq((events(result, 'error')[0]?.data as { code?: string })?.code, 'fora_da_base', 'fora_da_base')
  eq(model.calls.length, 0, 'modelo não chamado')
  eq(events(result, 'meta').length, 0, 'sem meta')
  eq(events(result, 'delta').length, 0, 'sem delta')
  eq(JSON.stringify(queries), JSON.stringify(['qual o sentido da vida?']), 'uma consulta ao chat_context')
  const state = store.snapshot(USER, CLOCK())
  eq(state.used, 4, 'grátis não debitado')
  eq(state.paid, 24, 'pago intacto')
  eq(state.reserved, 0, 'reserva devolvida')
  eq(state.commitCalls, 0, 'sem commit')
  eq(state.releaseCalls, 1, 'release único')
  eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'orçamento devolvido')
})

Deno.test('LAT-FORA: nome, apelido, duas raízes e misto seguem para o modelo', async () => {
  const duas = raizUnica('sul_america_vida', SUL_AMERICA)
  duas.raizes.push({ id: 'ipes', nome: 'IPES · Instituto de Pesquisas e Estudos Sociais', tipo: 'organizacao' })
  const casos: Array<[string, string[], ChatContextPayload]> = [
    ['O que a Sul América Vida documenta?', [], raizUnica('sul_america_vida', SUL_AMERICA)],
    ['O golpe militar', [], raizUnica('golpe64', 'Golpe de Estado · 1964', 'evento')],
    ['vida', [], duas],
    ['A vida do IBEC', [], raizUnica('sul_america_vida', SUL_AMERICA)],
    ['Qual o sentido da vida?', ['sul_america_vida'], raizUnica('sul_america_vida', SUL_AMERICA)],
  ]
  for (const [mensagem, entidades, ctx] of casos) {
    const store = db()
    store.chatContext = async () => structuredClone(ctx)
    const result = await prepareChat({
      userId: USER, body: request({ mensagem, contexto: { entidades } }),
      db: store, clock: CLOCK, inferenceKey: acceptedKey(),
    })
    assert(result.ok, `${mensagem}: segue para o modelo`)
    eq(store.releaseCalls, 0, `${mensagem}: reserva mantida`)
  }
})

Deno.test('SEC-01 reserva somente após o contexto completo e cobre Unicode e schema', async () => {
  for (const modelo of ['basico', 'avancado'] as const) {
    const store = db()
    store.setPaid(USER, 24)
    const originalContext = store.chatContext.bind(store)
    const originalReserve = store.reserveBudget.bind(store)
    let contextReady = false
    let held = 0
    store.chatContext = async (...args) => { const ctx = await originalContext(...args); contextReady = true; return ctx }
    store.reserveBudget = async (id, amount, cap, now) => {
      assert(contextReady, 'nenhuma reserva antes do contexto')
      held = amount
      return await originalReserve(id, amount, cap, now)
    }
    const prepared = await prepareChat({ userId: USER, body: request({ modelo, mensagem: '你😀é'.repeat(100) }), db: store, clock: CLOCK, inferenceKey: acceptedKey() })
    assert(prepared.ok, 'cabe no orçamento')
    eq(held, chatSpendCeilingUsd(modelo, prepared.requestBody), 'teto exato reservado')
    const provider = prepared.requestBody.provider as { max_price: { prompt: number; completion: number; request: number } }
    assert(provider.max_price.prompt > 0 && provider.max_price.completion > 0, 'tarifas máximas no pedido efetivo')
    eq(provider.max_price.request, 0, 'nenhuma taxa fixa por requisição')
    assert(held > CHAT_COST_ESTIMATE_USD[modelo], 'inclui entrada e protocolo, além da saída')
    const ascii = modelRequestBody(modelo, 'abc', 'abc')
    const unicode = modelRequestBody(modelo, '你😀é', '你😀é')
    assert(chatSpendCeilingUsd(modelo, unicode) > chatSpendCeilingUsd(modelo, ascii), 'bytes Unicode, não comprimento JS')
    const before = chatSpendCeilingUsd(modelo, ascii)
    ascii.response_format = { schema: 'x'.repeat(10000) }
    assert(chatSpendCeilingUsd(modelo, ascii) > before, 'schema entra no teto')
  }
})

Deno.test('SEC-01 orçamento e chave insuficientes para o teto impedem inferência', async () => {
  for (const denial of ['budget', 'key'] as const) {
    const store = db()
    const model = scripted([])
    const amount = 0.001 // cabe a saída antiga; não cabe o prompt completo
    if (denial === 'budget') store.addSpend(3 - amount, CLOCK())
    const result = await chat({ database: store, openrouter: model.client, inferenceKey: acceptedKey(denial === 'key' ? amount : 2.5) })
    eq((result.events[0].data as { code: string }).code, denial === 'budget' ? 'orcamento_esgotado' : 'limite_chave', 'recusa adequada')
    eq(model.calls.length, 0, 'modelo não chamado')
    eq(store.snapshot(USER).reserved, 0, 'crédito devolvido')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'nenhum orçamento retido')
  }
})

Deno.test('SEC-01 custo ausente, interrupção sem delta e custo real integral', async () => {
  for (const mode of ['success', 'interrupt', 'abort', 'real'] as const) {
    const store = db()
    const controller = new AbortController()
    const model = scripted(async function* () {
      if (mode === 'abort') { controller.abort('client'); throw new DOMException('fixture', 'AbortError') }
      if (mode === 'interrupt') throw new Error('falha sintética antes do primeiro delta')
      yield { delta: answerJson() }
      if (mode === 'real') yield { usage: { cost: 0.5 } }
    })
    const result = await chat({ database: store, openrouter: model.client, inferenceKey: acceptedKey(), signal: controller.signal, repetirCurto: false })
    const ceiling = chatSpendCeilingUsd('basico', model.calls[0])
    eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, mode === 'real' ? Math.min(0.5, ceiling) : ceiling, 'sem custo usa teto; acima da reserva o orçamento fica na reserva')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'reserva liquidada conservadoramente')
    if (mode !== 'interrupt' && mode !== 'abort') eq(finalOf(result).custo_real, mode === 'real' ? 0.5 : ceiling, 'retorno consistente')
  }
})

Deno.test('SEC-01 retry de SSE sem custo conserva teto da tentativa anterior', async () => {
  const store = db()
  await withOpenRouterResponses([
    upstreamSse({ error: { code: 429 } }),
    upstreamSse({ choices: [{ delta: { content: answerJson() } }] }, { usage: { cost: 0.0001 } }),
  ], async (client, bodies) => {
    const result = await chat({ database: store, openrouter: client, inferenceKey: acceptedKey(), retryDelayMs: 0 })
    const previous = Math.ceil(chatSpendCeilingUsd('basico', JSON.parse(bodies[0])) / 2 * 1_000_000) / 1_000_000
    const expected = Math.round((previous + 0.0001) * 1_000_000) / 1_000_000
    eq(bodies.length, 2, 'duas tentativas no máximo')
    eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, expected, 'teto anterior mais custo real final')
    assert(finalOf(result).custo_real >= previous, 'sem apagar a tentativa de custo desconhecido')
  })
})

const GATE_LINHA_PR7 = "Fonte: PR7-NF15 · p. 1: 'As of October 9, 2026'; 'Founder David Rockefeller'; 'João Schmidt, Brazil'; 'Claudio Szajman; PR7-NF16 · lista 'As of October 15, 2026' (página devolveu HTTP 403; não conferida — usar o PDF de 09/10/2026)"

Deno.test('chat factual: localizador e acesso sanitizados; proposta_interna não é citada', async () => {
  const rock = JSON.parse(await Deno.readTextFile(new URL('../chat/fixtures/ctx_rockefeller_golpe64.json', import.meta.url))) as ChatContextPayload
  const interna = JSON.parse(await Deno.readTextFile(new URL('../chat/fixtures/ctx_fonte_interna.json', import.meta.url))) as ChatContextPayload
  const ctx: ChatContextPayload = {
    ...rock,
    fontes: [...rock.fontes, ...interna.fontes],
    relacoes: [...rock.relacoes, ...interna.relacoes],
    entidades: [...rock.entidades, ...interna.entidades],
  }
  const nf16 = ctx.fontes.find(f => f.id === 'PR7-NF16')!
  const nf15 = ctx.fontes.find(f => f.id === 'PR7-NF15')!
  assert(!!(nf16.localizador?.includes('HTTP 403') && nf16.localizador.includes('não conferida')), 'fixture ainda tem a nota do gate')
  const { answer, removed } = sanitizeAnswer({
    blocos: [{
      tipo: 'documentado',
      texto: 'AS/COA mantém David Rockefeller como fundador na lista do CIAC.',
      entidades: ['david_r', 'americas_society'],
      relacoes: ['PR7-E019'],
      fontes: ['PR7-NF15', 'PR7-NF16', 'PR15b-NF12'],
    }],
    fontes: ['PR7-NF15', 'PR7-NF16', 'PR15b-NF12'],
    sem_base: false,
    em_aberto: null,
  }, ctx)
  assert(removed, 'fonte interna é removida da citação')
  assert(answer.fontes.includes('PR7-NF15'), 'fonte conferida permanece')
  assert(!answer.fontes.includes('PR15b-NF12'), 'proposta_interna não aparece nas fontes do factual')
  const packed = JSON.stringify(answer)
  assert(!packed.includes(GATE_LINHA_PR7), 'não reproduz a linha vazada no gate')
  assert(!/HTTP\s*\d|não conferida|usar o PDF|página devolveu|proposta_interna|nota de trabalho/i.test(packed), 'sem nota de processo no factual')
  assert(!/Claudio Szajman;/.test(packed), 'aspas não cortadas no factual')
  const d15 = answer.fontes_detalhe['PR7-NF15']
  assert(!!d15?.localizador, 'localizador conferido segue na UI')
  assert(d15.localizador === "p. 1: 'As of October 9, 2026'; 'Founder David Rockefeller'", 'factual também recorta nomes de terceiros')
  assert(!/João Schmidt|Claudio Szajman/.test(packed), 'nomes de terceiros fora do factual')
  if (answer.fontes.includes('PR7-NF16')) {
    const d16 = answer.fontes_detalhe['PR7-NF16']
    assert(!d16.localizador, 'localizador que era só nota de processo some; fica título/id')
  }
  const prompt = boundContextJson(ctx)
  assert(!/HTTP\s*\d|não conferida|usar o PDF|página devolveu/i.test(prompt), 'contexto do modelo também sai limpo')
  assert(!prompt.includes('PR15b-NF12'), 'proposta_interna não vai ao recorte do modelo')
  assert(!/nota de trabalho/.test(prompt), 'acesso/nota de trabalho não vai ao recorte')
  // acesso com nota de trabalho / HTTP não pode aparecer
  assert(!/"acesso"\s*:\s*"[^"]*(HTTP|não conferida|nota de trabalho)/i.test(prompt), 'acesso com nota de trabalho não é interpolado')
  void nf15
})
