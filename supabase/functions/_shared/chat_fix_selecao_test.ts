// chat-fix-selecao: recuperação pelo texto, apelidos [n], reatribuição e ausentes.
// Compatível com `deno test` e com o runner Node (chat_core_node_test.mjs).
import {
  apelidarRecorte,
  assessInferenceKey,
  boundContextJson,
  buildSystemPrompt,
  type ChatContextPayload,
  type ChatDb,
  type ChatFinal,
  type ChatSseEvent,
  fallbackSemLigacao,
  mensagemForaDaBase,
  nomesProprios,
  ocultarIdsVisiveis,
  perguntaDeLigacao,
  prepareChat,
  recuperarContexto,
  sanearModelo,
  streamPrepared,
} from './chat_core.ts'
import { createMemoryDb, type MemoryChatDb } from './memory_db.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const CLOCK = () => new Date('2026-11-05T15:00:00-03:00')
const SOROS_LULA = 'qual a ligação de Soros e Lula? pq Soros comemorou a vitória de Lula?'
const FIXTURE = JSON.parse(await Deno.readTextFile(
  new URL('../chat/fixtures/ctx_soros_selecao.json', import.meta.url),
)) as Record<string, ChatContextPayload>

// Prompt fixo (sem o JSON) medido em v12, antes das linhas de apelido.
const FIXO_V12 = { basico: 1373, avancado: 1341 }

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n actual=${JSON.stringify(actual)}\n expected=${JSON.stringify(expected)}`)
  }
}

function vazio(): ChatContextPayload {
  return { raizes: [], entidades: [], relacoes: [], fontes: [] }
}

function chave(ids: readonly string[], query: string | null): string {
  return `${ids.join(',')}|${query ?? ''}`
}

function lookupDb(map: Record<string, ChatContextPayload>, calls: string[]): ChatDb {
  return {
    async chatContext(ids: string[], query: string | null) {
      const key = chave(ids, query)
      calls.push(key)
      const hit = map[key]
      return hit ? JSON.parse(JSON.stringify(hit)) as ChatContextPayload : vazio()
    },
  } as ChatDb
}

function memoryFrom(map: Record<string, ChatContextPayload>): { store: MemoryChatDb; calls: string[] } {
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

function acceptedKey() {
  return assessInferenceKey({
    data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false },
  })
}

async function preparar(db: ChatDb, mensagem: string, entidades: string[]) {
  const prepared = await prepareChat({
    userId: USER,
    body: { mensagem, contexto: { entidades }, modelo: 'basico' },
    db,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
  })
  if (!prepared.ok) throw new Error(`prepare falhou: ${JSON.stringify(prepared.event)}`)
  return prepared
}

async function fluir(db: ChatDb, prepared: Awaited<ReturnType<typeof preparar>>, raw: string) {
  const emitted: ChatSseEvent[] = []
  const status = await streamPrepared({
    prepared,
    db,
    openrouter: {
      async *stream() {
        yield { delta: raw }
        yield { usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.0002 } }
      },
    },
    signal: new AbortController().signal,
    emit: (event) => emitted.push(event),
  })
  return { status, emitted }
}

function errorOf(events: ChatSseEvent[]): { code?: string; message?: string } {
  const event = events.find((item) => item.event === 'error')
  assert(event && event.event === 'error', `sem erro: ${events.map((item) => item.event).join(',')}`)
  return event.data as { code?: string; message?: string }
}

function finalOf(events: ChatSseEvent[]): ChatFinal {
  const event = events.find((item) => item.event === 'final')
  assert(event && event.event === 'final', `sem final: ${events.map((item) => item.event).join(',')}`)
  return event.data
}

function raiz(id: string, nome: string, tipo = 'instituicao'): ChatContextPayload['raizes'][number] {
  return { id, nome, tipo }
}

function recorte(roots: ChatContextPayload['raizes'], extra: Partial<ChatContextPayload> = {}): ChatContextPayload {
  return {
    raizes: roots,
    entidades: extra.entidades ?? roots.map((item) => ({ ...item })),
    relacoes: extra.relacoes ?? [],
    fontes: extra.fontes ?? [],
  }
}

function doisTemas(): ChatContextPayload {
  return {
    raizes: [raiz('tema_a', 'Tema Alfa'), raiz('tema_b', 'Tema Beta')],
    entidades: [raiz('tema_a', 'Tema Alfa'), raiz('tema_b', 'Tema Beta')],
    relacoes: [
      { id: 'rel_a', origem: 'tema_a', destino: 'tema_b', afirmacao: 'Alfa está documentado no recorte.', fontes: ['fa'] },
      { id: 'rel_b', origem: 'tema_b', destino: 'tema_a', afirmacao: 'Beta está documentado no recorte.', fontes: ['fb'] },
    ],
    fontes: [{ id: 'fa', titulo: 'Fonte Alfa' }, { id: 'fb', titulo: 'Fonte Beta' }],
  }
}

function proibido(texto: string, palavras: string[]) {
  for (const palavra of palavras) assert(!texto.includes(palavra), `não deveria conter ${palavra}`)
}

Deno.test('1 seleção Soros/Lula ignora febre amarela e aponta Lula ausente', async () => {
  const calls: string[] = []
  const db = lookupDb(FIXTURE, calls)
  const got = await recuperarContexto(db, SOROS_LULA, ['sfa', 'minas1941'], false)
  eq(got.origem === 'selecao', false, 'origem não é a seleção')
  eq(got.context.raizes.map((item) => item.id).join(','), 'soros', 'raiz soros')
  eq(JSON.stringify(got.ausentes), JSON.stringify(['Lula']), 'Lula ausente')
  assert(got.chamadas <= 6, 'teto de chamadas')
  proibido(JSON.stringify(got.context.raizes), ['sfa', 'minas1941', 'Febre', 'febre'])

  const { store } = memoryFrom(FIXTURE)
  const prepared = await preparar(store, SOROS_LULA, ['sfa', 'minas1941'])
  eq(prepared.origem === 'selecao', false, 'prepare não fica na seleção')
  eq(prepared.context.raizes.map((item) => item.id).join(','), 'soros', 'prepare na raiz soros')
  const fluxo = await fluir(store, prepared, JSON.stringify({ blocos: [], sem_base: true }))
  assert(!fluxo.emitted.some((event) => event.event === 'final'), 'sem final de fallback')
  const erro = errorOf(fluxo.emitted)
  eq(erro.code, 'fora_da_base', 'código fora_da_base')
  assert(erro.message?.includes('Lula não está na base do atlas.'), 'mensagem de Lula')
  proibido(JSON.stringify(fluxo.emitted), ['febre', 'Febre', 'vacina', 'AP_E39', 'AP_E41', 'Resposta montada direto da base'])
  eq(store.snapshot(USER, CLOCK()).used, 0, 'não cobra')
  eq(JSON.stringify(Object.keys(prepared.meta).sort()), JSON.stringify([
    'conversa_id', 'custo_estimado', 'gratis_restantes', 'modelo', 'n_entidades', 'n_fontes', 'saldo_pago',
  ]), 'meta sem origem nem apelidos')
})

Deno.test('2 bloco com apelido [n] vira fonte e entidade reais', async () => {
  const { store } = memoryFrom(FIXTURE)
  const prepared = await preparar(store, SOROS_LULA, ['sfa', 'minas1941'])
  const numero = (id: string) => {
    const hit = Object.entries(prepared.apelidos).find(([, real]) => real === id)
    assert(hit, `apelido de ${id}`)
    return hit[0]
  }
  const raw = JSON.stringify({
    sem_base: false,
    blocos: [{
      tipo: 'documentado',
      texto: 'O índice familiar de Soros está no recorte.',
      entidades: [`[${numero('soros')}]`],
      relacoes: [],
      fontes: [`#${numero('SO05')}`],
    }],
  })
  const fluxo = await fluir(store, prepared, raw)
  const final = finalOf(fluxo.emitted)
  const doc = final.blocos.find((bloco) => bloco.tipo === 'documentado' && bloco.fontes.includes('SO05'))
  assert(doc && doc.tipo === 'documentado', 'bloco de Soros')
  assert(doc.entidades.includes('soros'), 'entidade soros')
  assert(doc.fontes.includes('SO05'), 'fonte SO05')
  assert(final.blocos.some((bloco) => bloco.texto.includes('Lula não está na base do atlas.')), 'ausente no final')
  proibido(doc.texto, ['[', 'febre', 'Febre', 'AP_E39'])
  proibido(doc.entidades.join(',') + doc.fontes.join(','), ['[', '#'])
})

Deno.test('3 seleção sem nome próprio mantém a origem selecao', async () => {
  const { store, calls } = memoryFrom(FIXTURE)
  const prepared = await preparar(store, 'o que é isso?', ['sfa', 'minas1941'])
  eq(prepared.origem, 'selecao', 'origem selecao')
  eq(prepared.context.raizes.map((item) => item.id).join(','), 'sfa,minas1941', 'recorte da seleção')
  assert(calls.some((key) => key.startsWith('sfa,minas1941|')), 'consultou a seleção')
  assert(calls[0].startsWith('|'), 'consultou o texto antes')
})

Deno.test('4 perguntaDeLigacao ignora em relação a e mantém relação e ligação', () => {
  eq(perguntaDeLigacao('O que a Fundação Rockefeller fez no Brasil em 1916 em relação à ancilostomíase?'), false, 'em relação à')
  eq(perguntaDeLigacao('Qual foi a posição do IPES em relação ao golpe?'), false, 'em relação ao')
  eq(perguntaDeLigacao('Qual a relação entre X e Y?'), true, 'relação entre')
  eq(perguntaDeLigacao('qual a ligação de Soros e Lula?'), true, 'ligação de')
  eq(perguntaDeLigacao('Existe parentesco entre os dois?'), true, 'parentesco')
  eq(perguntaDeLigacao('Há vínculo entre as casas?'), true, 'vínculo')
})

Deno.test('5 fallbackSemLigacao não roda com seleção nem sem pergunta de ligação', async () => {
  const temas = doisTemas()
  assert(fallbackSemLigacao(temas), 'o recorte sozinho acionaria o fallback')
  const selecao = memoryFrom({ 'tema_a,tema_b|': temas })
  const preparadoSelecao = await preparar(selecao.store, 'qual a ligação entre os dois?', ['tema_a', 'tema_b'])
  eq(preparadoSelecao.origem, 'selecao', 'seleção vence sem nome próprio')
  const fluxoSelecao = await fluir(selecao.store, preparadoSelecao, JSON.stringify({ blocos: [], sem_base: true }))
  eq(errorOf(fluxoSelecao.emitted).code, 'fora_da_base', 'seleção não monta fallback')
  proibido(JSON.stringify(fluxoSelecao.emitted), ['Resposta montada direto da base', 'Tema Alfa'])

  const livre = memoryFrom({ '|descreva os dois registros de 1916 com calma': temas })
  const preparadoLivre = await preparar(livre.store, 'descreva os dois registros de 1916 com calma', [])
  eq(preparadoLivre.origem, 'texto', 'busca textual')
  eq(perguntaDeLigacao(preparadoLivre.mensagem), false, 'não é pergunta de ligação')
  const fluxoLivre = await fluir(livre.store, preparadoLivre, JSON.stringify({ blocos: [], sem_base: true }))
  eq(errorOf(fluxoLivre.emitted).code, 'fora_da_base', 'sem ligação não monta fallback')
  eq(errorOf(fluxoLivre.emitted).message, mensagemForaDaBase([]), 'mensagem clara sem ausentes')
  proibido(JSON.stringify(fluxoLivre.emitted), ['Resposta montada direto da base', 'Tema Alfa'])
})

Deno.test('6 apelidos [n] no prompt e tradução n/#n/campo errado', () => {
  const ctx: ChatContextPayload = {
    raizes: [raiz('zz_alpha', 'Alfa Distinto', 'organizacao')],
    entidades: [raiz('zz_alpha', 'Alfa Distinto', 'organizacao')],
    relacoes: [{ id: 'zz_rel_01', origem: 'zz_alpha', destino: 'zz_alpha', afirmacao: 'O recorte registra o fato.', fontes: ['zz_fonte_01'] }],
    fontes: [{ id: 'zz_fonte_01', titulo: 'Fonte distinta' }],
  }
  const prompt = buildSystemPrompt('basico', ctx)
  assert(prompt.includes('[1]'), 'apelido no prompt')
  assert(prompt.includes('Cite só "[n]".'), 'instrução de apelido')
  assert(prompt.includes('Não ponha ids no texto.'), 'instrução de ids no texto')
  proibido(prompt, ['zz_alpha', 'zz_rel_01', 'zz_fonte_01'])
  const { idPorNumero } = apelidarRecorte(ctx)
  const bruto = {
    blocos: [{
      tipo: 'documentado',
      texto: 'O recorte registra Alfa Distinto.',
      entidades: ['[2]', '#3', '[99]'],
      relacoes: ['1'],
      fontes: [],
    }],
  }
  const { answer } = sanearModelo(bruto, ctx, idPorNumero)
  const doc = answer.blocos[0]
  assert(doc.tipo === 'documentado', 'documentado')
  eq(JSON.stringify(doc.entidades), JSON.stringify(['zz_alpha']), 'entidade no campo certo')
  eq(JSON.stringify(doc.relacoes), JSON.stringify(['zz_rel_01']), 'relação saiu de entidades')
  eq(JSON.stringify(doc.fontes), JSON.stringify(['zz_fonte_01']), 'fonte #n traduzida')
  assert(answer.avisos.some((aviso) => aviso.tipo === 'citacao_removida'), 'apelido inexistente removido')
  proibido(JSON.stringify(doc), ['[99]', '[2]', '#3'])

  const real = sanearModelo({
    blocos: [{ tipo: 'documentado', texto: 'Id real segue aceito.', entidades: ['zz_alpha'], relacoes: ['zz_rel_01'], fontes: ['zz_fonte_01'] }],
  }, ctx, idPorNumero)
  eq(JSON.stringify(real.answer.blocos[0].tipo === 'documentado' && real.answer.blocos[0].fontes), JSON.stringify(['zz_fonte_01']), 'id real aceito')
})

Deno.test('7 reatribuição por nome mantém a relação; texto sem nome é sem_id_valido', async () => {
  const ctx: ChatContextPayload = {
    raizes: [raiz('alpha_org', 'Alpha Org'), raiz('beta_org', 'Beta Org')],
    entidades: [raiz('alpha_org', 'Alpha Org'), raiz('beta_org', 'Beta Org')],
    relacoes: [{ id: 'REL_AB', origem: 'alpha_org', destino: 'beta_org', afirmacao: 'As duas aparecem juntas.', fontes: ['FONTE_AB'] }],
    fontes: [{ id: 'FONTE_AB', titulo: 'Fonte do par' }],
  }
  const mantido = sanearModelo({
    blocos: [{
      tipo: 'documentado',
      texto: 'Alpha Org e Beta Org aparecem juntos no recorte.',
      entidades: ['sync_rf_dnsp_1923'],
      relacoes: ['sync_rf_dnsp_1923'],
      fontes: ['sync_rf_dnsp_1923'],
    }],
  }, ctx, {})
  const doc = mantido.answer.blocos[0]
  assert(doc.tipo === 'documentado', 'bloco mantido')
  assert(doc.relacoes.includes('REL_AB'), 'relação reatribuída')
  assert(doc.fontes.includes('FONTE_AB'), 'fontes da relação')
  assert(doc.entidades.includes('alpha_org') && doc.entidades.includes('beta_org'), 'as duas entidades')
  proibido(JSON.stringify(doc), ['sync_rf_dnsp_1923'])
  assert(mantido.answer.avisos.some((aviso) => aviso.tipo === 'citacao_removida'), 'aviso do id trocado')

  const semNome = sanearModelo({
    blocos: [{
      tipo: 'documentado',
      texto: 'Nada deste parágrafo cita um nome do recorte.',
      entidades: ['sync_rf_dnsp_1923'],
      relacoes: ['sync_rf_dnsp_1923'],
      fontes: ['sync_rf_dnsp_1923'],
    }],
  }, ctx, {})
  const vazioDoc = semNome.answer.blocos[0]
  assert(vazioDoc.tipo === 'documentado', 'bloco sem casar permanece sem ids')
  eq(vazioDoc.entidades.length + vazioDoc.relacoes.length + vazioDoc.fontes.length, 0, 'nenhum id válido')

  const { store } = memoryFrom({ '|descreva este registro de 1916 com calma': ctx })
  const prepared = await preparar(store, 'descreva este registro de 1916 com calma', [])
  const info: string[] = []
  const orig = console.info
  console.info = (msg: string) => info.push(String(msg))
  try {
    const fluxo = await fluir(store, prepared, JSON.stringify({
      sem_base: false,
      blocos: [{
        tipo: 'documentado',
        texto: 'Nada deste parágrafo cita um nome do recorte.',
        entidades: ['sync_rf_dnsp_1923'],
        relacoes: ['sync_rf_dnsp_1923'],
        fontes: ['sync_rf_dnsp_1923'],
      }],
    }))
    eq(errorOf(fluxo.emitted).code, 'fora_da_base', 'sem_id_valido segue fora_da_base')
    assert(info.some((line) => line.includes('sem_id_valido')), 'loga sem_id_valido')
  } finally {
    console.info = orig
  }
})

Deno.test('8 ids crus saem do texto visível e a entidade vira o nome', () => {
  const ctx: ChatContextPayload = {
    raizes: [{ id: 'walther_ms', nome: 'Walther Moreira Salles · banqueiro', tipo: 'pessoa' }],
    entidades: [
      { id: 'walther_ms', nome: 'Walther Moreira Salles · banqueiro', tipo: 'pessoa' },
      raiz('zz_banco', 'Banco Exemplo'),
    ],
    relacoes: [{ id: 'AP_E39', origem: 'walther_ms', destino: 'zz_banco', fontes: ['zz_fonte'], afirmacao: 'Registro documental.' }],
    fontes: [{ id: 'zz_fonte', titulo: 'Fonte exemplo' }],
  }
  const saida = ocultarIdsVisiveis('Segundo AP_E39 e [2], walther_ms financiou.', ctx)
  assert(saida.includes('Walther Moreira Salles'), 'nome no lugar do id')
  proibido(saida, ['AP_E39', '[2]', 'walther_ms'])
  const { answer } = sanearModelo({
    blocos: [{
      tipo: 'documentado',
      texto: 'Segundo AP_E39 e [2], walther_ms financiou.',
      entidades: ['zz_banco'],
      relacoes: [],
      fontes: ['zz_fonte'],
    }],
  }, ctx, {})
  const doc = answer.blocos[0]
  assert(doc.tipo === 'documentado', 'bloco')
  assert(doc.texto.includes('Walther Moreira Salles'), 'texto saneado com o nome')
  proibido(doc.texto, ['AP_E39', '[2]', 'walther_ms'])
})

Deno.test('9 em_aberto fecha o último bloco em parágrafo próprio', async () => {
  const store = createMemoryDb({ clock: CLOCK })
  const prepared = await preparar(store, 'Quais as conexões documentadas de Mauá e suas fontes?', ['maua'])
  const fluxo = await fluir(store, prepared, JSON.stringify({
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
    em_aberto: 'O que o recorte ainda deixa em aberto?',
  }))
  const final = finalOf(fluxo.emitted)
  const ultimo = final.blocos.at(-1)
  assert(ultimo, 'último bloco')
  assert(ultimo.texto.includes('\n\nO que o recorte ainda deixa em aberto?'), 'parágrafo próprio')
  assert(!ultimo.texto.includes('novo. O que'), 'não fica na mesma frase')
})

Deno.test('10 Fundação X troca para foundation só com raiz do tipo fundacao', async () => {
  const familia = recorte([raiz('rockefeller', 'Família Rockefeller', 'familia')])
  const foundation = recorte([raiz('rf', 'Rockefeller Foundation', 'fundacao')])
  const fgv = recorte([raiz('fgv', 'Fundação Getulio Vargas', 'instituicao')])
  const errada = recorte([raiz('getulio_foundation_errada', 'Familia Getulio Vargas', 'familia')])
  const calls: string[] = []
  const rock = await recuperarContexto(lookupDb({
    '|fundacao rockefeller': familia,
    '|rockefeller foundation': foundation,
  }, calls), 'fundacao rockefeller', [], false)
  eq(rock.context.raizes.map((item) => item.id).join(','), 'rf', 'usa rockefeller foundation')
  eq(rock.origem, 'texto', 'origem texto')
  assert(calls.includes('|rockefeller foundation'), 'consultou a forma foundation')

  const getulio = await recuperarContexto(lookupDb({
    '|fundacao getulio vargas': fgv,
    '|getulio foundation vargas': errada,
  }, []), 'Fundação Getulio Vargas', [], false)
  eq(getulio.context.raizes.map((item) => item.id).join(','), 'fgv', 'mantém a fundação original')
  assert(!getulio.context.raizes.some((item) => item.id === 'getulio_foundation_errada'), 'não adota nó sem tipo fundacao')
})

Deno.test('11 extrator de nomes próprios', () => {
  eq(JSON.stringify(nomesProprios('Operação Brother Sam')), JSON.stringify(['brother sam']), 'Brother Sam')
  eq(JSON.stringify(nomesProprios('Soros e Lula')), JSON.stringify(['soros', 'lula']), 'Soros e Lula')
  eq(JSON.stringify(nomesProprios('Jorge Paulo Lemann, a 3G Capital e o BTG Pactual no caso Americanas')), JSON.stringify([
    'jorge paulo lemann', '3g capital', 'btg pactual', 'americanas',
  ]), 'Lemann, 3G, BTG e Americanas')
  eq(JSON.stringify(nomesProprios('Me passa uma receita de bolo')), JSON.stringify([]), 'receita sem nome')
  eq(JSON.stringify(nomesProprios('a família Rothschild')), JSON.stringify(['rothschild']), 'família')
  eq(JSON.stringify(nomesProprios('RIT Capital Partners')), JSON.stringify(['rit capital partners']), 'RIT')
  eq(JSON.stringify(nomesProprios('Rothschild & Co')), JSON.stringify(['rothschild & co']), 'ampersand')
  eq(JSON.stringify(nomesProprios('O Globo')), JSON.stringify(['globo']), 'artigo')
  eq(JSON.stringify(nomesProprios('Lula')), JSON.stringify(['lula']), 'Lula')
})

Deno.test('12 no máximo 6 chamadas chatContext', async () => {
  const texto = recorte([raiz('txt', 'Texto Avulso', 'evento')])
  const rf = recorte([raiz('rf_extra', 'Rockefeller Foundation', 'fundacao')])
  const jpl = recorte([raiz('jpl', 'Jorge Paulo Lemann', 'pessoa')])
  const calls: string[] = []
  const db = lookupDb({
    '|a fundacao rockefeller viu jorge paulo lemann, soros e lula?': texto,
    '|a rockefeller foundation viu jorge paulo lemann, soros e lula?': vazio(),
    '|rockefeller foundation': rf,
    '|jorge paulo lemann': jpl,
    '|soros': recorte([raiz('soros', 'Soros', 'familia')]),
    '|lula': vazio(),
    'rf_extra,jpl|': recorte([raiz('rf_extra', 'Rockefeller Foundation', 'fundacao'), raiz('jpl', 'Jorge Paulo Lemann', 'pessoa')]),
    'sfa|': recorte([raiz('sfa', 'Serviço de Febre Amarela')]),
  }, calls)
  const got = await recuperarContexto(db, 'A Fundação Rockefeller viu Jorge Paulo Lemann, Soros e Lula?', ['sfa'], false)
  assert(got.chamadas <= 6, `chamadas ${got.chamadas}`)
  assert(calls.length <= 6, `db ${calls.length}: ${calls.join(' || ')}`)
  eq(calls.length, got.chamadas, 'contador bate com o banco')
})

Deno.test('nomes corrigem Rothschild, Brother Sam e não trocam Lemann por BTG', async () => {
  const rothQuery = 'qual foi o papel da casa rothschild nos emprestimos do brasil no seculo xix?'
  const erradas = recorte([
    raiz('house_frankfurt', 'Casa Rothschild · Frankfurt · parceria de 1810', 'familia'),
    raiz('sicily_loan_1832', 'Empréstimo da Sicília · 1832', 'evento'),
    raiz('celulose_papel_fluminense', 'Celulose e Papel · Fluminense', 'empresa'),
  ], {
    relacoes: [{ id: 'RUIDO', origem: 'house_frankfurt', destino: 'sicily_loan_1832', fontes: ['F'] }],
    fontes: [{ id: 'F', titulo: 'Ruído' }],
  })
  const roth = recorte([raiz('rothschild', 'Rothschild', 'familia')], {
    relacoes: [
      { id: 'AP_E44', origem: 'rothschild', destino: 'brasil_imp', fontes: ['APF'] },
      { id: 'AP_E47', origem: 'rothschild', destino: 'brasil_imp', fontes: ['APF'] },
    ],
    fontes: [{ id: 'APF', titulo: 'Empréstimo' }],
    entidades: [raiz('rothschild', 'Rothschild', 'familia'), raiz('brasil_imp', 'Brasil Império')],
  })
  const rothCalls: string[] = []
  const rothGot = await recuperarContexto(lookupDb({
    [`|${rothQuery}`]: erradas,
    '|rothschild': roth,
    'rothschild|': roth,
  }, rothCalls), 'Qual foi o papel da casa Rothschild nos empréstimos do Brasil no século XIX?', [], false)
  eq(rothGot.origem, 'nomes', 'origem nomes')
  eq(rothGot.context.raizes.map((item) => item.id).join(','), 'rothschild', 'só rothschild')
  assert(rothGot.context.relacoes.some((rel) => rel.id === 'AP_E44'), 'AP_E44')
  assert(rothGot.context.relacoes.some((rel) => rel.id === 'AP_E47'), 'AP_E47')
  proibido(rothGot.context.raizes.map((item) => item.id).join(','), ['house_frankfurt', 'sicily', 'celulose'])

  const samQuery = 'o que foi a operacao brother sam e qual foi o papel do governo dos eua no golpe de 1964?'
  const samTexto = recorte([
    raiz('golpe64', 'Golpe de Estado · 1964', 'evento'),
    raiz('celulose_papel_fluminense', 'Celulose e Papel · Fluminense', 'empresa'),
    raiz('saudigov', 'Governo da Arábia', 'governo'),
  ])
  const caso = recorte([raiz('caso_op13', 'Brasil 1964 · decisões Brother Sam', 'caso')])
  const junto = recorte([
    raiz('golpe64', 'Golpe de Estado · 1964', 'evento'),
    raiz('caso_op13', 'Brasil 1964 · decisões Brother Sam', 'caso'),
  ], {
    relacoes: [{ id: 'OP13_R01', origem: 'golpe64', destino: 'caso_op13', fontes: ['OPF'] }],
    fontes: [{ id: 'OPF', titulo: 'Brother Sam' }],
  })
  const samGot = await recuperarContexto(lookupDb({
    [`|${samQuery}`]: samTexto,
    '|brother sam': caso,
    'golpe64,caso_op13|': junto,
  }, []), 'O que foi a Operação Brother Sam e qual foi o papel do governo dos eua no golpe de 1964?', [], false)
  eq(samGot.origem, 'nomes', 'brother sam por nome')
  eq(samGot.context.raizes.map((item) => item.id).join(','), 'golpe64,caso_op13', 'golpe e Brother Sam')
  assert(samGot.context.relacoes.some((rel) => rel.id === 'OP13_R01'), 'OP13')

  const lemannQuery = 'qual e a relacao entre jorge paulo lemann, a 3g capital e o btg pactual no caso americanas?'
  const lemann = recorte([
    raiz('jorge_paulo_lehmann', 'Jorge Paulo Lemann', 'pessoa'),
    raiz('capital_3g', '3G Capital', 'empresa'),
    raiz('americanas_br', 'Americanas S.A.', 'empresa'),
  ], {
    relacoes: [{ id: 'LEM_R1', origem: 'jorge_paulo_lehmann', destino: 'americanas_br', fontes: ['LF'], afirmacao: 'Caso Americanas.' }],
    fontes: [{ id: 'LF', titulo: 'Caso' }],
  })
  const btg = recorte([raiz('btg_pactual', 'BTG Pactual', 'empresa')])
  const lemannCalls: string[] = []
  const lemannGot = await recuperarContexto(lookupDb({
    [`|${lemannQuery}`]: lemann,
    '|btg pactual': btg,
    '|jorge paulo lemann': lemann,
    '|3g capital': recorte([raiz('capital_3g', '3G Capital', 'empresa')]),
    '|americanas': recorte([raiz('americanas_br', 'Americanas S.A.', 'empresa')]),
  }, lemannCalls), 'Qual é a relação entre Jorge Paulo Lemann, a 3G Capital e o BTG Pactual no caso Americanas?', [], false)
  eq(lemannGot.context.raizes.map((item) => item.id).join(','), 'jorge_paulo_lehmann,capital_3g,americanas_br', 'não troca Americanas por BTG')
  eq(lemannGot.origem, 'texto', 'conjunto textual permanece')
  assert(lemannGot.context.relacoes.some((rel) => rel.id === 'LEM_R1'), 'relação de Americanas')
  assert(!lemannCalls.some((key) => key.includes('btg_pactual|')), 'não refetch com BTG no lugar')
})

Deno.test('tamanho do system prompt não cresce no sintético nem em Soros', () => {
  const mini: ChatContextPayload = {
    raizes: [
      { id: 'walther_ms', nome: 'Walther Moreira Salles · banqueiro', tipo: 'pessoa' },
      { id: 'soros', nome: 'Soros · índice familiar', tipo: 'familia' },
    ],
    entidades: [
      { id: 'walther_ms', nome: 'Walther Moreira Salles · banqueiro', tipo: 'pessoa' },
      { id: 'soros', nome: 'Soros · índice familiar', tipo: 'familia' },
      { id: 'george_soros', nome: 'George Soros', tipo: 'pessoa' },
    ],
    relacoes: [
      { id: 'AP_E39', origem: 'walther_ms', destino: 'soros', afirmacao: 'Doação documentada no recorte de teste.', fontes: ['SO05'] },
      { id: 'SOE01', origem: 'soros', destino: 'george_soros', afirmacao: 'O índice familiar aponta a pessoa.', fontes: ['SO05'] },
    ],
    fontes: [{ id: 'SO05', titulo: 'George Soros — fundador', tipo: 'documento_primario' }],
  }
  const soros = FIXTURE['|soros']
  for (const [nome, ctx] of [['sintetico', mini], ['soros', soros]] as const) {
    const antes = FIXO_V12.basico + boundContextJson(ctx).length
    const depois = buildSystemPrompt('basico', ctx).length
    const jsonAlias = apelidarRecorte(ctx).json.length
    console.log(`MEDIDA ${nome}: antes=${antes} depois=${depois} json=${boundContextJson(ctx).length} alias=${jsonAlias}`)
    assert(jsonAlias <= 8000, `${nome} alias acima de 8000`)
    assert(depois <= antes, `${nome} prompt cresceu ${antes} -> ${depois}`)
  }
  const vazioCtx = vazio()
  for (const modelo of ['basico', 'avancado'] as const) {
    const prompt = buildSystemPrompt(modelo, vazioCtx)
    const fixo = prompt.length - boundContextJson(vazioCtx).length
    console.log(`MEDIDA fixo ${modelo}: ${fixo}`)
  }
})
