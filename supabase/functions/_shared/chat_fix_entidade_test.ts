// Comando no início não vira ausente; minúscula entra só se a raiz confirmar.
// Compatível com `deno test` e com o runner Node (chat_core_node_test.mjs).
import {
  assessInferenceKey,
  type ChatContextPayload,
  type ChatDb,
  type ChatSseEvent,
  mensagemForaDaBase,
  nomesProprios,
  prepareChat,
  recuperarContexto,
  runChat,
  saoPauloDay,
} from './chat_core.ts'
import { createMemoryDb, type MemoryChatDb } from './memory_db.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const CLOCK = () => new Date('2026-11-18T12:00:00-03:00')
const FALE_SOROS = 'Fale sobre a relação de soros com o Brasil'

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}
function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}\n actual=${JSON.stringify(actual)}\n expected=${JSON.stringify(expected)}`)
}
function vazio(): ChatContextPayload {
  return { raizes: [], entidades: [], relacoes: [], fontes: [] }
}
function chave(ids: readonly string[], query: string | null): string {
  return `${ids.join(',')}|${query ?? ''}`
}
function key() {
  return assessInferenceKey({ data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false } })
}
function raiz(id: string, nome: string, tipo = 'instituicao'): ChatContextPayload['raizes'][number] {
  return { id, nome, tipo }
}
function recorte(root: ChatContextPayload['raizes'][number], extra: Partial<ChatContextPayload> = {}): ChatContextPayload {
  return {
    raizes: [root],
    entidades: extra.entidades ?? [root],
    relacoes: extra.relacoes ?? [{
      id: `${root.id}_rel`, origem: root.id, destino: root.id, afirmacao: `${root.nome} está no recorte de teste.`, fontes: [`${root.id}_fonte`],
    }],
    fontes: extra.fontes ?? [{ id: `${root.id}_fonte`, titulo: root.nome, tipo: 'documento' }],
  }
}

const SOROS = recorte(raiz('soros', 'Soros · índice familiar', 'familia'), {
  entidades: [
    raiz('soros', 'Soros · índice familiar', 'familia'),
    raiz('george_soros', 'George Soros', 'pessoa'),
  ],
  relacoes: [{ id: 'SOE01', origem: 'soros', destino: 'george_soros', afirmacao: 'O índice familiar aponta a pessoa.', fontes: ['SO05'] }],
  fontes: [{ id: 'SO05', titulo: 'George Soros — fundador', tipo: 'documento' }],
})
const ROCKEFELLER = recorte(raiz('rockefeller', 'Família Rockefeller', 'familia'))
const GEORGE = recorte(raiz('george_soros', 'George Soros', 'pessoa'))
const IPES = recorte(raiz('ipes', 'Instituto de Pesquisas e Estudos Sociais (IPES)', 'instituicao'))
const IBEC = recorte(raiz('ibec', 'IBEC', 'instituicao'))
const SANTA = recorte(raiz('santa_se', 'Santa Sé', 'instituicao'))

function banco(map: Record<string, ChatContextPayload>): { store: MemoryChatDb; calls: string[] } {
  const calls: string[] = []
  const store = createMemoryDb({ clock: CLOCK })
  store.chatContext = async (ids, query) => {
    const key = chave(ids, query)
    calls.push(key)
    const hit = map[key]
    return hit ? JSON.parse(JSON.stringify(hit)) as ChatContextPayload : vazio()
  }
  return { store, calls }
}

async function preparar(store: ChatDb, mensagem: string, entidades: string[] = []) {
  return prepareChat({
    userId: USER,
    body: { mensagem, contexto: { entidades }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: key(),
  })
}

function erroDe(events: ChatSseEvent[]) {
  const event = events.find((item) => item.event === 'error')
  assert(event && event.event === 'error', `sem erro: ${events.map((item) => item.event).join(',')}`)
  return event.data
}

Deno.test('comando e pergunta no início não viram nome próprio', () => {
  const casos: Array<[string, string[]]> = [
    ['Fale sobre Soros', ['soros']],
    ['Fala sobre Soros', ['soros']],
    ['Me diga quem foi Rockefeller', ['rockefeller']],
    ['Diga quem foi Rockefeller', ['rockefeller']],
    ['Explique o IPES', ['ipes']],
    ['Conte sobre o IBEC', ['ibec']],
    ['Me conte quem foi Soros', ['soros']],
    ['Quem é George Soros', ['george soros']],
    ['Quem foi Rockefeller', ['rockefeller']],
    ['Qual a relação da Santa Sé com o Brasil?', ['santa se']],
    ['Quais os elos de Soros?', ['soros']],
    ['O que foi o IBEC?', ['ibec']],
    ['Como Rockefeller atuou?', ['rockefeller']],
    ['Liste os atos do IPES', ['ipes']],
    ['Mostre o IBEC', ['ibec']],
    ['Resuma o IPES', ['ipes']],
    ['Descreva o IBEC', ['ibec']],
    ['Compare Soros e Rockefeller', ['soros', 'rockefeller']],
    ['Soros, Fale sobre o IPES', ['soros', 'ipes']],
    ['FALE SOBRE SOROS', ['soros']],
    ['ME DIGA QUEM FOI ROCKEFELLER NO BRASIL', ['rockefeller']],
  ]
  for (const [frase, esperado] of casos) {
    eq(JSON.stringify(nomesProprios(frase)), JSON.stringify(esperado), frase)
  }
  eq(JSON.stringify(nomesProprios('Me passa uma receita de bolo')), JSON.stringify([]), 'receita continua sem nome')
  const alta = 'QUAL A RELAÇÃO DA ODEBRECHT COM A FUNDAÇÃO ROCKEFELLER?'
  const mista = 'Qual a relação da Odebrecht com a Fundação Rockefeller?'
  eq(JSON.stringify(nomesProprios(alta)), JSON.stringify(nomesProprios(mista)), 'maiúsculas usam a mesma heurística')
  eq(JSON.stringify(nomesProprios(alta)), JSON.stringify(['odebrecht', 'rockefeller foundation']), alta)
})

Deno.test('Fale sobre soros não recusa e resolve a raiz sem chamada extra', async () => {
  const q = 'fale sobre a relacao de soros com o brasil'
  const { store, calls } = banco({ [`|${q}`]: SOROS, 'soros|': SOROS, '|soros': SOROS })
  const got = await recuperarContexto(store, FALE_SOROS, [], false)
  eq(got.ausentes.join('|'), '', 'Fale não entra em ausentes')
  assert(got.nomeados.includes('soros'), `nomeados: ${got.nomeados.join(',')}`)
  eq(got.context.raizes.map((item) => item.id).join(','), 'soros', 'raiz soros')
  assert(!calls.includes('|soros'), `caso comum não rebusca o nome: ${calls.join(' || ')}`)
  assert(got.chamadas <= 8, `teto ${got.chamadas}`)
  const prepared = await preparar(store, FALE_SOROS)
  assert(prepared.ok, `prepare recusou: ${JSON.stringify(prepared)}`)
  if (prepared.ok) eq(prepared.ausentes.join('|'), '', 'prepare sem ausente')
})

Deno.test('soros minúsculo ausente do texto busca a raiz e não vira ausente', async () => {
  const { store, calls } = banco({ '|soros': SOROS, 'soros|': SOROS })
  const got = await recuperarContexto(store, FALE_SOROS, [], false)
  assert(calls.includes('|soros'), `buscou a raiz: ${calls.join(' || ')}`)
  assert(got.nomeados.includes('soros'), 'nomeados')
  eq(got.ausentes.join('|'), '', 'soros confirmado não é ausente')
  eq(got.context.raizes[0]?.id, 'soros', 'recorte da raiz')
  assert(got.chamadas <= 8, `teto ${got.chamadas}`)
})

Deno.test('minúsculas, siglas, Santa Sé e maiúsculas resolvem; token solto não é ausente', async () => {
  const casos: Array<[string, Record<string, ChatContextPayload>, string]> = [
    ['me diga quem foi rockefeller no brasil', { '|rockefeller': ROCKEFELLER, 'rockefeller|': ROCKEFELLER }, 'rockefeller'],
    ['Explique o IPES', { '|explique o ipes': IPES, '|ipes': IPES, 'ipes|': IPES }, 'ipes'],
    ['O que foi o IBEC?', { '|o que foi o ibec?': IBEC, '|ibec': IBEC, 'ibec|': IBEC }, 'ibec'],
    ['Qual a relação da Santa Sé com o Brasil?', { '|qual a relacao da santa se com o brasil?': SANTA, '|santa se': SANTA, 'santa_se|': SANTA }, 'santa_se'],
    ['quem é george soros', { '|george soros': GEORGE, 'george_soros|': GEORGE }, 'george_soros'],
    ['ME DIGA QUEM FOI ROCKEFELLER NO BRASIL', { '|rockefeller': ROCKEFELLER, 'rockefeller|': ROCKEFELLER }, 'rockefeller'],
  ]
  for (const [mensagem, map, id] of casos) {
    const { store } = banco(map)
    const got = await recuperarContexto(store, mensagem, [], false)
    assert(got.nomeados.includes(id), `${mensagem} → ${got.nomeados.join(',')}`)
    assert(!got.ausentes.some((nome) => nome.length > 40), `${mensagem} ausente gigante: ${got.ausentes.join('|')}`)
    assert(!got.ausentes.some((nome) => /^(fale|fala|diga|explique|conte|liste|mostre|resuma|descreva|compare|quem|qual|como)$/i.test(nome)), `${mensagem}: ${got.ausentes.join('|')}`)
    const prepared = await preparar(store, mensagem)
    assert(prepared.ok, `${mensagem} recusou ${JSON.stringify(prepared)}`)
    assert(got.chamadas <= 8, `${mensagem} teto ${got.chamadas}`)
  }

  const solto = await recuperarContexto(banco({}).store, 'Fale sobre a relação de xyzzy com o Brasil', [], false)
  eq(solto.ausentes.join('|'), '', 'xyzzy minúsculo não entra em ausentes')
})

Deno.test('Odebrecht capitalizada continua fora da base antes do crédito', async () => {
  const frases = [
    'Fale sobre a Odebrecht no Brasil',
    'Qual a relação da Odebrecht com o Brasil?',
  ]
  for (const mensagem of frases) {
    const { store } = banco({})
    const got = await recuperarContexto(store, mensagem, [], false)
    eq(got.ausentes.join('|'), 'Odebrecht', mensagem)
    const prepared = await preparar(store, mensagem)
    assert(!prepared.ok, mensagem)
    if (!prepared.ok && prepared.event.event === 'error') {
      eq(prepared.event.data.code, 'fora_da_base', mensagem)
      eq(prepared.event.data.message, mensagemForaDaBase(['Odebrecht']), mensagem)
    }
    const saldo = store.snapshot(USER, CLOCK())
    eq(saldo.reserveCalls, 0, `${mensagem}: reserveCredits`)
    eq(saldo.commitCalls, 0, `${mensagem}: commit`)
    eq(saldo.used, 0, `${mensagem}: débito`)
  }
})

Deno.test('receita continua fora da base sem débito', async () => {
  const mensagem = 'me passa uma receita de bolo de cenoura'
  const { store } = banco({})
  let modelo = 0
  const { events } = await runChat({
    userId: USER,
    body: { mensagem, contexto: { entidades: [] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: key(),
    openrouter: { async *stream() { modelo += 1; yield { delta: '{"blocos":[]}' } } },
  })
  const erro = erroDe(events)
  eq(modelo, 0, 'não chama o modelo')
  eq(erro.code, 'fora_da_base', 'código')
  assert(!/Fale|Bolo|Cenoura|xyzzy/i.test(erro.message ?? ''), erro.message ?? '')
  const saldo = store.snapshot(USER, CLOCK())
  eq(saldo.commitCalls, 0, 'sem commit')
  eq(saldo.used, 0, 'sem débito')
  eq(saldo.reserved, 0, 'sem hold')

  const selecao = banco({ 'sfa|': ROCKEFELLER })
  let modeloSelecao = 0
  const recusa = await runChat({
    userId: USER,
    body: { mensagem, contexto: { entidades: ['sfa'] }, modelo: 'basico' },
    db: selecao.store,
    clock: CLOCK,
    inferenceKey: key(),
    openrouter: { async *stream() { modeloSelecao += 1; yield { delta: '{"blocos":[]}' } } },
  })
  eq(modeloSelecao, 0, 'seleção externa não chama o modelo')
  eq(erroDe(recusa.events).code, 'fora_da_base', 'seleção')
  eq(selecao.store.snapshot(USER, CLOCK()).reserveCalls, 0, 'seleção sem reserveCredits')
})

Deno.test('falha da ponte depois da reserva libera crédito e orçamento sem débito', async () => {
  const mensagem = 'qual a relação de soros com rockefeller'
  const both: ChatContextPayload = {
    raizes: [
      raiz('soros', 'Soros · índice familiar', 'familia'),
      raiz('rockefeller', 'Família Rockefeller', 'familia'),
    ],
    entidades: [
      raiz('soros', 'Soros · índice familiar', 'familia'),
      raiz('rockefeller', 'Família Rockefeller', 'familia'),
    ],
    relacoes: [
      { id: 's_rel', origem: 'soros', destino: 'george', afirmacao: 'Índice familiar.', fontes: ['s_f'] },
      { id: 'r_rel', origem: 'rockefeller', destino: 'rf', afirmacao: 'Família no recorte.', fontes: ['r_f'] },
    ],
    fontes: [
      { id: 's_f', titulo: 'Soros', tipo: 'documento' },
      { id: 'r_f', titulo: 'Rockefeller', tipo: 'documento' },
    ],
  }
  const store = createMemoryDb({ clock: CLOCK })
  let solturasOrcamento = 0
  const releaseBudget = store.releaseBudget.bind(store)
  store.releaseBudget = async (pedidoId) => {
    solturasOrcamento += 1
    return releaseBudget(pedidoId)
  }
  store.chatContext = async (ids) => {
    if (ids.length === 1) throw new Error('ponte indisponível')
    return JSON.parse(JSON.stringify(both)) as ChatContextPayload
  }
  const prepared = await preparar(store, mensagem)
  assert(!prepared.ok, 'não segue ao stream')
  if (!prepared.ok && prepared.event.event === 'error') {
    eq(prepared.event.data.code, 'rede', 'erro genérico')
    eq(prepared.event.data.message, 'Falha ao consultar a base.', 'sem detalhe interno')
    assert(!/ponte|indisponível/i.test(prepared.event.data.message), prepared.event.data.message)
  }
  const saldo = store.snapshot(USER, CLOCK())
  eq(saldo.reserveCalls, 1, 'reserveCredits')
  eq(saldo.releaseCalls, 1, 'releaseReserve')
  eq(solturasOrcamento, 1, 'releaseBudget')
  eq(saldo.commitCalls, 0, 'sem commit')
  eq(saldo.used, 0, 'sem débito')
  eq(saldo.reserved, 0, 'sem hold de crédito')
  eq(store.budgetOf(saoPauloDay(CLOCK())).reservado, 0, 'sem hold de orçamento')
})

Deno.test('reserva gravada antes da exceção devolve o crédito sem commit', async () => {
  const mensagem = 'Fale sobre a relação de soros com o Brasil'
  const outro = '22222222-2222-4222-8222-222222222222'
  const pedidoOutro = '99999999-9999-4999-8999-999999999999'
  const casos: Array<{ modelo: 'basico' | 'avancado'; pago: number }> = [
    { modelo: 'basico', pago: 5 },
    { modelo: 'avancado', pago: 20 },
  ]
  for (const caso of casos) {
    const store = createMemoryDb({ clock: CLOCK })
    store.setPaid(USER, caso.pago)
    store.setPaid(outro, 11)
    await store.reserveCredits(outro, 'basico', pedidoOutro, CLOCK())
    store.chatContext = async (ids, query) => {
      const q = `${ids.join(',')} ${query ?? ''}`
      if (q.includes('soros')) return JSON.parse(JSON.stringify(SOROS)) as ChatContextPayload
      return vazio()
    }
    const reserve = store.reserveCredits.bind(store)
    store.reserveCredits = async (userId, modelo, pedidoId, now) => {
      await reserve(userId, modelo, pedidoId, now)
      throw new Error('conexao caiu depois da reserva')
    }
    const prepared = await prepareChat({
      userId: USER,
      body: { mensagem, contexto: { entidades: [] }, modelo: caso.modelo },
      db: store,
      clock: CLOCK,
      inferenceKey: key(),
    })
    assert(!prepared.ok, caso.modelo)
    if (!prepared.ok && prepared.event.event === 'error') {
      eq(prepared.event.data.code, 'rede', caso.modelo)
      eq(prepared.event.data.message, 'Falha ao consultar a base.', caso.modelo)
      assert(!/conexao|reserva/i.test(prepared.event.data.message), prepared.event.data.message)
    }
    const saldo = store.snapshot(USER, CLOCK())
    eq(saldo.reserved, 0, `${caso.modelo}: reserved`)
    eq(saldo.used, 0, `${caso.modelo}: used`)
    eq(saldo.commitCalls, 0, `${caso.modelo}: commit`)
    eq(saldo.paid, caso.pago, `${caso.modelo}: saldo pago`)
    eq(saldo.releaseCalls, 1, `${caso.modelo}: uma liberação`)
    eq(store.snapshot(outro, CLOCK()).reserved, 1, `${caso.modelo}: outra reserva intacta`)
    eq(store.snapshot(outro, CLOCK()).paid, 11, `${caso.modelo}: saldo do outro`)
  }

  const antes = createMemoryDb({ clock: CLOCK })
  antes.setPaid(USER, 5)
  await antes.reserveCredits(outro, 'basico', pedidoOutro, CLOCK())
  antes.chatContext = async () => JSON.parse(JSON.stringify(SOROS)) as ChatContextPayload
  antes.reserveCredits = async () => {
    throw new Error('conexao caiu antes da reserva')
  }
  const vazioDeCredito = await prepareChat({
    userId: USER,
    body: { mensagem, contexto: { entidades: [] }, modelo: 'basico' },
    db: antes,
    clock: CLOCK,
    inferenceKey: key(),
  })
  assert(!vazioDeCredito.ok, 'exceção antes da reserva')
  if (!vazioDeCredito.ok && vazioDeCredito.event.event === 'error') {
    eq(vazioDeCredito.event.data.code, 'rede', 'noop')
    assert(!/conexao/i.test(vazioDeCredito.event.data.message), vazioDeCredito.event.data.message)
  }
  const saldoAntes = antes.snapshot(USER, CLOCK())
  eq(saldoAntes.reserved, 0, 'sem reserva própria')
  eq(saldoAntes.used, 0, 'sem débito')
  eq(saldoAntes.commitCalls, 0, 'sem commit')
  eq(saldoAntes.paid, 5, 'pago intacto no noop')
  eq(antes.snapshot(outro, CLOCK()).reserved, 1, 'noop não solta a outra reserva')
})

Deno.test('maiúsculas não recusam palavra comum que a caixa mista deixa passar', async () => {
  const cia = recorte(raiz('cia', 'CIA', 'instituicao'))
  const temas = [
    'bens', 'fins', 'marketing', 'política', 'petróleo', 'educação', 'saúde', 'economia',
    'ditadura', 'militares', 'imprensa', 'bancos', 'igreja', 'golpe de 1964', 'EUA', 'CIA',
  ]
  for (const tema of temas) {
    const mista = `Qual a relação de Soros com a ${tema} no Brasil?`
    const alta = mista.toLocaleUpperCase('pt-BR')
    const abrir = () => {
      const store = createMemoryDb({ clock: CLOCK })
      store.chatContext = async (ids, query) => {
        const q = query ?? ''
        if (ids.includes('cia') || q === 'cia') return JSON.parse(JSON.stringify(cia)) as ChatContextPayload
        if (ids.includes('rockefeller') || q.includes('rockefeller')) return JSON.parse(JSON.stringify(ROCKEFELLER)) as ChatContextPayload
        if (ids.includes('soros') || q.includes('soros')) return JSON.parse(JSON.stringify(SOROS)) as ChatContextPayload
        return vazio()
      }
      return store
    }
    const storeMista = abrir()
    const storeAlta = abrir()
    const gotMista = await recuperarContexto(storeMista, mista, [], false)
    const gotAlta = await recuperarContexto(storeAlta, alta, [], false)
    eq(gotMista.ausentes.join('|'), '', `mista ${tema}: ${gotMista.ausentes.join('|')}`)
    eq(gotAlta.ausentes.join('|'), '', `maiúsculas ${tema}: ${gotAlta.ausentes.join('|')}`)
    const prepMista = await preparar(storeMista, mista)
    const prepAlta = await preparar(storeAlta, alta)
    assert(prepMista.ok, `mista recusou ${tema}: ${JSON.stringify(prepMista)}`)
    assert(prepAlta.ok, `maiúsculas recusou ${tema} e a mista passou: ${JSON.stringify(prepAlta)}`)
    eq(storeMista.snapshot(USER, CLOCK()).reserveCalls, 1, `mista ${tema}: reserve`)
    eq(storeAlta.snapshot(USER, CLOCK()).reserveCalls, 1, `maiúsculas ${tema}: reserve`)
  }
})

Deno.test('pauta divide o teto de 8 chamadas com a recuperação', async () => {
  const mensagem = 'Sugira pautas sobre Soros, Rockefeller e morgan no petróleo'
  const familia = (id: string, nome: string): ChatContextPayload => ({
    raizes: [raiz(id, nome, 'familia')],
    entidades: [raiz(id, nome, 'familia'), raiz(`${id}_fnd`, `${nome} Foundation`, 'fundacao')],
    relacoes: [{ id: `${id}_r`, origem: id, destino: `${id}_fnd`, afirmacao: 'Vínculo familiar.', tipo: 'fundacao', fontes: [`${id}_s`] }],
    fontes: [{ id: `${id}_s`, titulo: nome, tipo: 'documento' }],
  })
  const soros = familia('soros', 'Soros')
  const rockefeller = familia('rockefeller', 'Família Rockefeller')
  const morgan = familia('morgan', 'Morgan')
  const junto: ChatContextPayload = {
    raizes: [soros.raizes[0], rockefeller.raizes[0], morgan.raizes[0]],
    entidades: [...soros.entidades, ...rockefeller.entidades, ...morgan.entidades],
    relacoes: [soros.relacoes[0]],
    fontes: [soros.fontes[0]],
  }
  const calls: string[] = []
  const store = createMemoryDb({ clock: CLOCK })
  store.chatContext = async (ids, query) => {
    calls.push(`${ids.join(',')}|${query ?? ''}`)
    if (ids.length) return vazio()
    const q = query || ''
    if (q.includes('soros') && q.includes('rockefeller') && q.includes('morgan')) return JSON.parse(JSON.stringify(junto)) as ChatContextPayload
    if (q === 'soros') return JSON.parse(JSON.stringify(soros)) as ChatContextPayload
    if (q === 'rockefeller') return JSON.parse(JSON.stringify(rockefeller)) as ChatContextPayload
    if (q === 'morgan') return JSON.parse(JSON.stringify(morgan)) as ChatContextPayload
    return vazio()
  }
  const prepared = await preparar(store, mensagem)
  assert(prepared.ok, `prepare recusou: ${JSON.stringify(prepared)}`)
  assert(calls.length <= 8, `teto da requisição ${calls.length}: ${calls.join(' || ')}`)
  assert(calls.length >= 8, `o caso precisa encostar no teto: ${calls.length}: ${calls.join(' || ')}`)
  assert(!calls.some((call) => call.includes('rothschild')), `expansão passou do saldo: ${calls.join(' || ')}`)
})

function respostaDocumentada(texto: string, entidade: string, relacao: string, fonte: string): string {
  return JSON.stringify({
    blocos: [{ tipo: 'documentado', texto, entidades: [entidade], relacoes: [relacao], fontes: [fonte] }],
    entidades: [entidade],
    fontes: [fonte],
    avisos: [],
    sem_base: false,
  })
}

Deno.test('Fale sobre soros em caixa mista e em maiúsculas responde', async () => {
  const frases = [FALE_SOROS, 'FALE SOBRE A RELAÇÃO DE SOROS COM O BRASIL']
  for (const mensagem of frases) {
    const store = createMemoryDb({ clock: CLOCK })
    store.setPaid(USER, 4)
    store.chatContext = async (ids, query) => {
      const q = `${ids.join(',')} ${query ?? ''}`
      if (q.includes('soros')) return JSON.parse(JSON.stringify(SOROS)) as ChatContextPayload
      return vazio()
    }
    const got = await recuperarContexto(store, mensagem, [], false)
    eq(got.ausentes.join('|'), '', `${mensagem}: ${got.ausentes.join('|')}`)
    let modelo = 0
    const { events } = await runChat({
      userId: USER,
      body: { mensagem, contexto: { entidades: [] }, modelo: 'basico' },
      db: store,
      clock: CLOCK,
      inferenceKey: key(),
      openrouter: { async *stream() {
        modelo += 1
        yield { delta: respostaDocumentada('Soros aparece no recorte documental.', 'soros', 'SOE01', 'SO05') }
        yield { usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0.0001 } }
      } },
    })
    assert(modelo >= 1, `${mensagem}: modelo`)
    const final = events.find((item) => item.event === 'final')
    assert(final && final.event === 'final', `${mensagem}: sem resposta ${events.map((item) => item.event).join(',')}`)
    assert(final.data.blocos.some((bloco) => bloco.texto.includes('Soros aparece')), `${mensagem}: ${final.data.blocos.map((bloco) => bloco.texto).join(' | ')}`)
    assert(!events.some((item) => item.event === 'error' && /não está na base/i.test(item.data.message)), mensagem)
    const saldo = store.snapshot(USER, CLOCK())
    eq(saldo.commitCalls, 1, `${mensagem}: commit`)
    eq(saldo.used, 1, `${mensagem}: débito com resposta`)
    eq(saldo.reserved, 0, `${mensagem}: hold`)
    eq(saldo.releaseCalls, 0, `${mensagem}: liberação`)
    eq(saldo.paid, 4, `${mensagem}: pago`)
  }
})

Deno.test('maiúsculas não geram ausente; Odebrecht em maiúsculas não debita sem resposta', async () => {
  const fundacao = recorte(raiz('rf', 'Rockefeller Foundation', 'fundacao'))
  const mista = 'Qual a relação da Odebrecht com a Fundação Rockefeller?'
  const alta = 'QUAL A RELAÇÃO DA ODEBRECHT COM A FUNDAÇÃO ROCKEFELLER?'
  const contextoFundacao = async (ids: readonly string[], query: string | null) => {
    const q = query || ''
    if (!ids.length && (q.includes('rockefeller') || q.includes('fundacao'))) return JSON.parse(JSON.stringify(fundacao)) as ChatContextPayload
    return vazio()
  }

  const storeMista = createMemoryDb({ clock: CLOCK })
  storeMista.chatContext = contextoFundacao
  const gotMista = await recuperarContexto(storeMista, mista, [], false)
  eq(gotMista.ausentes.join('|'), 'Odebrecht', mista)
  const preparedMista = await preparar(storeMista, mista)
  assert(preparedMista.ok, `${mista}: segue com o mais próximo da base (Fundação Rockefeller)`)
  if (preparedMista.ok) {
    eq(preparedMista.ausentes.join('|'), 'Odebrecht', `${mista}: preserva ausente`)
    assert(preparedMista.context.raizes.some((r) => r.id === 'rf'), `${mista}: preserva Fundação Rockefeller`)
  }

  const storeAlta = createMemoryDb({ clock: CLOCK })
  storeAlta.setPaid(USER, 4)
  storeAlta.chatContext = contextoFundacao
  const gotAlta = await recuperarContexto(storeAlta, alta, [], false)
  eq(gotAlta.ausentes.join('|'), '', `${alta}: ${gotAlta.ausentes.join('|')}`)
  let modeloAlta = 0
  const altaChat = await runChat({
    userId: USER,
    body: { mensagem: alta, contexto: { entidades: [] }, modelo: 'basico' },
    db: storeAlta,
    clock: CLOCK,
    inferenceKey: key(),
    openrouter: { async *stream() {
      modeloAlta += 1
      yield { delta: respostaDocumentada('A Fundação Rockefeller aparece no recorte documental.', 'rf', 'rf_rel', 'rf_fonte') }
      yield { usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0.0001 } }
    } },
  })
  assert(modeloAlta >= 1, 'maiúsculas com recorte da fundação chama o modelo')
  const finalAlta = altaChat.events.find((item) => item.event === 'final')
  assert(finalAlta && finalAlta.event === 'final', `sem resposta: ${altaChat.events.map((item) => item.event).join(',')}`)
  assert(finalAlta.data.blocos.some((bloco) => bloco.texto.includes('Fundação Rockefeller')), finalAlta.data.blocos.map((bloco) => bloco.texto).join(' | '))
  const saldoAlta = storeAlta.snapshot(USER, CLOCK())
  eq(saldoAlta.commitCalls, 1, 'maiúsculas: commit junto da resposta')
  eq(saldoAlta.used, 1, 'maiúsculas: débito com resposta')
  eq(saldoAlta.reserved, 0, 'maiúsculas: hold')
  eq(saldoAlta.releaseCalls, 0, 'maiúsculas: sem devolução depois da resposta')
  eq(saldoAlta.paid, 4, 'maiúsculas: pago')

  const soAlta = 'FALE SOBRE A ODEBRECHT NO BRASIL'
  const storeSo = banco({}).store
  storeSo.setPaid(USER, 4)
  const gotSo = await recuperarContexto(storeSo, soAlta, [], false)
  eq(gotSo.ausentes.join('|'), '', `${soAlta}: ${gotSo.ausentes.join('|')}`)
  let modeloSo = 0
  const soChat = await runChat({
    userId: USER,
    body: { mensagem: soAlta, contexto: { entidades: [] }, modelo: 'basico' },
    db: storeSo,
    clock: CLOCK,
    inferenceKey: key(),
    openrouter: { async *stream() { modeloSo += 1; yield { delta: '{}' } } },
  })
  eq(modeloSo, 0, 'maiúsculas sem recorte não chama o modelo')
  const erroSo = erroDe(soChat.events)
  eq(erroSo.code, 'fora_da_base', soAlta)
  assert(!/Odebrecht não está/i.test(erroSo.message), erroSo.message)
  const saldoSo = storeSo.snapshot(USER, CLOCK())
  eq(saldoSo.reserveCalls, 1, 'maiúsculas vazias: reservou')
  eq(saldoSo.releaseCalls, 1, 'maiúsculas vazias: liberou')
  eq(saldoSo.commitCalls, 0, 'maiúsculas vazias: sem commit')
  eq(saldoSo.used, 0, 'maiúsculas vazias: sem débito')
  eq(saldoSo.reserved, 0, 'maiúsculas vazias: sem hold')
  eq(saldoSo.paid, 4, 'maiúsculas vazias: pago')

  const segue: Array<[string, ChatContextPayload, string]> = [
    ['ME DIGA QUEM FOI ROCKEFELLER NO BRASIL', ROCKEFELLER, 'rockefeller'],
    ['QUEM FOI O IPES?', IPES, 'ipes'],
    ['EXPLIQUE O IBEC NO BRASIL', IBEC, 'ibec'],
    ['QUAL O PAPEL DOS ROCKEFELLER NA SAÚDE DO BRASIL?', ROCKEFELLER, 'rockefeller'],
  ]
  for (const [mensagem, ctx, id] of segue) {
    const store = createMemoryDb({ clock: CLOCK })
    store.chatContext = async (ids, query) => {
      const q = `${ids.join(',')} ${query ?? ''}`
      if (q.includes(id)) return JSON.parse(JSON.stringify(ctx)) as ChatContextPayload
      return vazio()
    }
    const got = await recuperarContexto(store, mensagem, [], false)
    eq(got.ausentes.join('|'), '', `${mensagem}: ${got.ausentes.join('|')}`)
    assert(got.nomeados.includes(id), `${mensagem} → ${got.nomeados.join(',')}`)
    const prepared = await preparar(store, mensagem)
    assert(prepared.ok, `${mensagem} recusou ${JSON.stringify(prepared)}`)
    if (prepared.ok) eq(prepared.ausentes.join('|'), '', mensagem)
    eq(store.snapshot(USER, CLOCK()).reserveCalls, 1, `${mensagem}: reservou crédito`)
  }
})

Deno.test('maiúsculas com outra frase em minúsculas não geram ausente', async () => {
  const temas = ['BENS', 'FINS', 'MARKETING', 'PETRÓLEO']
  for (const tema of temas) {
    const alta = `QUAL A RELAÇÃO DE SOROS COM ${tema} NO BRASIL?`
    for (const mensagem of [`${alta} obrigado.`, `obrigado. ${alta}`]) {
      const store = createMemoryDb({ clock: CLOCK })
      store.chatContext = async (ids, query) => {
        const q = `${ids.join(',')} ${query ?? ''}`
        if (q.includes('soros')) return JSON.parse(JSON.stringify(SOROS)) as ChatContextPayload
        return vazio()
      }
      const got = await recuperarContexto(store, mensagem, [], false)
      eq(got.ausentes.join('|'), '', `${mensagem}: ${got.ausentes.join('|')}`)
      const prepared = await preparar(store, mensagem)
      assert(prepared.ok, `${mensagem} recusou: ${JSON.stringify(prepared)}`)
      if (prepared.ok) eq(prepared.ausentes.join('|'), '', mensagem)
      eq(store.snapshot(USER, CLOCK()).reserveCalls, 1, `${mensagem}: reserve`)
    }
  }
})

Deno.test('Fale sobre soros e FALE SOBRE SOROS seguem ao modelo sem ausentes', async () => {
  for (const mensagem of ['Fale sobre soros', 'FALE SOBRE SOROS']) {
    const store = createMemoryDb({ clock: CLOCK })
    store.setPaid(USER, 4)
    store.chatContext = async (ids, query) => {
      const q = `${ids.join(',')} ${query ?? ''}`
      if (q.includes('soros')) return JSON.parse(JSON.stringify(SOROS)) as ChatContextPayload
      return vazio()
    }
    const got = await recuperarContexto(store, mensagem, [], false)
    eq(got.ausentes.join('|'), '', `${mensagem}: ${got.ausentes.join('|')}`)
    let modelo = 0
    const { events } = await runChat({
      userId: USER,
      body: { mensagem, contexto: { entidades: [] }, modelo: 'basico' },
      db: store,
      clock: CLOCK,
      inferenceKey: key(),
      openrouter: { async *stream() {
        modelo += 1
        yield { delta: respostaDocumentada('Soros aparece no recorte documental.', 'soros', 'SOE01', 'SO05') }
        yield { usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0.0001 } }
      } },
    })
    assert(modelo >= 1, `${mensagem}: modelo`)
    const final = events.find((item) => item.event === 'final')
    assert(final && final.event === 'final', `${mensagem}: sem resposta ${events.map((item) => item.event).join(',')}`)
    assert(final.data.blocos.some((bloco) => bloco.texto.includes('Soros aparece')), `${mensagem}: ${final.data.blocos.map((bloco) => bloco.texto).join(' | ')}`)
    assert(!events.some((item) => item.event === 'error' && /não está na base/i.test(item.data.message)), mensagem)
  }
})

Deno.test('Odebrecht em caixa mista com frase em maiúsculas recusa antes do crédito', async () => {
  const mensagem = 'Fale sobre a Odebrecht no Brasil. OBRIGADO'
  const { store } = banco({})
  const got = await recuperarContexto(store, mensagem, [], false)
  eq(got.ausentes.join('|'), 'Odebrecht', mensagem)
  const prepared = await preparar(store, mensagem)
  assert(!prepared.ok, mensagem)
  if (!prepared.ok && prepared.event.event === 'error') {
    eq(prepared.event.data.code, 'fora_da_base', mensagem)
    eq(prepared.event.data.message, mensagemForaDaBase(['Odebrecht']), mensagem)
  }
  const saldo = store.snapshot(USER, CLOCK())
  eq(saldo.reserveCalls, 0, `${mensagem}: reserveCredits`)
  eq(saldo.commitCalls, 0, `${mensagem}: commit`)
  eq(saldo.used, 0, `${mensagem}: débito`)
})
