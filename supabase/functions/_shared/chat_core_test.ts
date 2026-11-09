import {
  CHAT_COST_ESTIMATE_USD,
  CHAT_LEASE_HOLD_MS,
  CHAT_MODEL_TIMEOUT_MS,
  CHAT_ERROR_STATUS,
  assessInferenceKey,
  boundContextJson,
  buildSystemPrompt,
  type ChatContextPayload,
  fallbackSemLigacao,
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
  eq(MODEL_SLUGS.basico, 'qwen/qwen3.7-flash', 'slug basico')
  eq(MODEL_SLUGS.avancado, 'z-ai/glm-5.3', 'slug avancado')
  eq(CHAT_DAILY_BUDGET_USD, 3, 'teto default')
  eq(CHAT_MAX_TOKENS.basico, 900, 'max_tokens basico')
  eq(CHAT_MAX_TOKENS.avancado, 1800, 'max_tokens avancado')
  eq(CHAT_COST_ESTIMATE_USD.basico, 0.0005, 'preço de saída = 900 tokens')
  eq(CHAT_COST_ESTIMATE_USD.avancado, 0.004, 'preço de saída = 1800 tokens')
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
  const result = await chat({ database: store, openrouter: model.client, inferenceKey: key })
  eq(result.httpStatus, 200, 'chama')
  eq(model.calls.length, 1, 'uma chamada paga')
  const body = model.calls[0] as { max_tokens?: number; model?: string }
  eq(body.max_tokens, 900, 'max_tokens modesto')
  eq(body.model, 'qwen/qwen3.7-flash', 'slug')
  const final = finalOf(result)
  eq(final.custo_real, 0.02, 'custo informado, sem cortar')
  eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0.02, 'grava o custo real')
  eq(store.snapshot(USER, CLOCK()).used, 1, 'debita depois da resposta')
  const again = scripted([{ delta: answerJson() }, { usage: { cost: 0.0001 } }])
  const second = await chat({ database: store, openrouter: again.client, inferenceKey: key })
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
    eq(JSON.stringify(queries), JSON.stringify([raw, cleaned]), 'normaliza e limpa só palavras inteiras')
    eq(result.context.raizes?.[0]?.id, 'maua', 'usa o contexto recuperado')
    eq(result.mensagem, mensagem, 'mensagem original preservada')
    eq(store.reserveCalls, 1, 'uma reserva de crédito')
    eq(store.releaseCalls, 0, 'reserva mantida para o stream')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, CHAT_COST_ESTIMATE_USD.basico, 'uma reserva de orçamento')
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

Deno.test('A2 não repete consulta com ids explícitos ou até três palavras', async () => {
  const examples = [
    { mensagem: 'Quem é o Barão de Mauá?', ids: ['ausente'], query: null },
    { mensagem: 'Quem é Mauá?', ids: [], query: 'quem e maua?' },
    { mensagem: 'Mauá', ids: [], query: 'maua' },
  ]
  for (const { mensagem, ids, query } of examples) {
    const store = db()
    const lookup = store.chatContext.bind(store)
    let calls = 0
    store.chatContext = async (entityIds, q) => {
      calls++
      eq(JSON.stringify(entityIds), JSON.stringify(ids), 'mantém ids')
      eq(q, query, 'consulta original')
      return await lookup([], null)
    }
    const result = await prepareChat({
      userId: USER, body: request({ mensagem, contexto: { entidades: ids } }),
      db: store, clock: CLOCK, inferenceKey: acceptedKey(),
    })
    assert(!result.ok, 'contexto continua vazio')
    eq((result.event.data as { code: string }).code, 'fora_da_base', 'código preservado')
    eq(calls, 1, 'sem tentativa extra')
    eq(store.releaseCalls, 1, 'devolve crédito')
  }
})

Deno.test('A2 não repete consulta quando a primeira já tem contexto', async () => {
  for (const entityIds of [[], ['maua']]) {
    const store = db()
    const lookup = store.chatContext.bind(store)
    let calls = 0
    store.chatContext = async (ids, query) => {
      calls++
      return await lookup(ids, query)
    }
    const result = await prepareChat({
      userId: USER,
      body: request({ mensagem: 'Quem é o Barão de Mauá?', contexto: { entidades: entityIds } }),
      db: store, clock: CLOCK, inferenceKey: acceptedKey(),
    })
    assert(result.ok, 'contexto encontrado')
    eq(calls, 1, 'consulta única')
  }
})

Deno.test('A2 falha da primeira consulta ou do retry libera as reservas', async () => {
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
    eq(store.releaseCalls, 1, 'devolve crédito uma vez')
    eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'devolve orçamento')
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
  near.addSpend(2.9996, CLOCK())
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
      eq(state.logs[0].custo_usd, 0, 'não registra gasto sem geração')
      eq(store.budgetOf(saoPauloDay(CLOCK())).gasto, 0, 'nenhum gasto')
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
    { data: { limit: 3, limit_reset: 'monthly', limit_remaining: 3, include_byok_in_limit: false } },
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
  assert(bound.length <= 8000, 'não manda o texto inteiro')
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
  assert(bound.length <= 8000, 'cabe no teto')
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
  assert(bound.length <= 8000, `recorte real: ${bound.length} caracteres`)
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
  assert(bound.length <= 8000, `com caminhos: ${bound.length} caracteres`)
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
  assert(bound.length <= 8000 && !parsed.truncado, 'cabe sem stub')
  eq(parsed.raizes[0].id, 'rockefeller', 'mantém raiz')
  eq(parsed.casos.length, 0, 'pode remover todos os casos')
})

Deno.test('SPEC3 prompt distingue temas documentados, ausência de ligação e caminho indireto', () => {
  const context: ChatContextPayload = { raizes: [], entidades: [], relacoes: [], fontes: [] }
  for (const modelo of ['basico', 'avancado'] as const) {
    const prompt = buildSystemPrompt(modelo, context)
    assert(prompt.includes('só quando o recorte não sustenta nenhum dos temas'), 'sem_base limitado à falta de temas')
    assert(prompt.includes('explique o que documenta sobre cada um'), 'resposta útil sobre temas')
    assert(prompt.includes('a ligação direta não está documentada no atlas'), 'explicita lacuna')
    assert(prompt.includes('explique primeiro essa ligação, citando suas relações e fontes'), 'prioriza caminho com fontes')
    assert(prompt.includes('Um caminho por intermediário não prova ligação direta'), 'não transforma contato em prova direta')
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

function assertReleaseFailureLog(args: unknown[], pedidoId: string, modelo: Modelo, kind: 'free' | 'paid') {
  eq(args.length, 2, 'label e pedido, sem o erro cru')
  eq(args[0], 'chat_release_failed', 'label do release')
  const detail = args[1] as { pedido_id?: string; modelo?: string; kind?: string }
  eq(JSON.stringify(Object.keys(detail).sort()), JSON.stringify(['kind', 'modelo', 'pedido_id']), 'só pedido, modelo e kind')
  eq(detail.pedido_id, pedidoId, 'uuid do pedido')
  eq(detail.modelo, modelo, 'modelo sem texto da pergunta')
  eq(detail.kind, kind, 'kind da reserva')
  const text = JSON.stringify(args)
  assert(!text.includes('falha de teste'), 'sem detalhe do erro')
  assert(!text.includes('release recusado'), 'sem mensagem interna')
  assert(!text.includes(QUESTION), 'sem texto da pergunta')
  assert(!text.includes(USER), 'sem usuário')
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

async function streamSemLigacao(context: ChatContextPayload, raw: string, opts: { store?: MemoryChatDb; modelo?: Modelo } = {}) {
  const store = opts.store ?? db()
  store.chatContext = async () => context
  const prepared = await prepareChat({ userId: USER, body: request({ modelo: opts.modelo ?? 'basico' }), db: store, clock: CLOCK, inferenceKey: acceptedKey() })
  assert(prepared.ok, 'pedido preparado com reservas')
  const model = scripted([{ delta: raw }, { usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.0002 } }])
  const emitted: ChatSseEvent[] = []
  const httpStatus = await streamPrepared({
    prepared, db: store, openrouter: model.client,
    signal: new AbortController().signal, emit: (event) => emitted.push(event),
  })
  return { store, model, result: { httpStatus, events: emitted } }
}

Deno.test('SPEC4 streamPrepared sem_base em dois temas sem ligação termina ok sem débito e libera reserva grátis', async () => {
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

Deno.test('CRED1 sem_ligacao no Avançado devolve os oito pagos sem alterar cota grátis', async () => {
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

Deno.test('CRED1 sem_ligacao no Básico com cota esgotada também devolve o crédito pago', async () => {
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

Deno.test('CRED1 falha no release não confirma nem repete a cobrança e mantém budget, final e log', async () => {
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
  assert(calls.every((args) => args[0] === 'chat_release_failed'), 'apenas label segura existente, sem detalhe do erro')
  assert(calls.every((args) => !JSON.stringify(args).includes('falha de teste')), 'sem detalhe do erro')
})

Deno.test('CRED1 sem_ligacao com release recusado avisa sem devolver e não cobra', async () => {
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

Deno.test('SPEC4 streamPrepared com blocos vazios também usa fallback', async () => {
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
    }), { store, modelo })
    const final = finalOf(result)
    eq(final.blocos.length, 1, 'não acrescenta fallback')
    eq(final.blocos[0].texto, 'Resposta do modelo.', 'texto preservado')
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
  eq(final.blocos.length, 1, 'resposta documentada')
  eq(final.blocos[0].texto, 'Resposta do modelo.', 'texto preservado')
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

Deno.test('CRED1 pg releaseReserve lança em ok false e aceita noop', async () => {
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
  await adapt(fakeSql({ ok: true, noop: true })).releaseReserve(reservation)
})
