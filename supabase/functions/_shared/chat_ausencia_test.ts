// Regra de ausência (nunca documentado, sem afirmar inexistência), recorte Brasil (SOE30–32)
// e fallback de busca web atrás de flag desligada por padrão.
// Compatível com `deno test` e com o runner Node (chat_core_node_test.mjs).
import {
  assessInferenceKey,
  buildSystemPrompt,
  type ChatContextPayload,
  type ChatDb,
  type ChatFinal,
  type ChatSseEvent,
  createFetchWebSearch,
  ehConclusaoDeAusencia,
  EXTERNA_NAO_VERIFICADA,
  fallbackSemLigacao,
  fraseInexistencia,
  isWebFallbackEnabled,
  modelRequestBody,
  ordenarRecortePorPergunta,
  perguntaEstrutural,
  prepareChat,
  runChat,
  sanitizeAnswer,
  saoAliasPublicos,
  type WebSearchClient,
} from './chat_core.ts'
import { assertBloco, assertFinal } from './contrato_ux3a_test.ts'
import { createMemoryDb, type MemoryChatDb } from './memory_db.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const CLOCK = () => new Date('2026-11-19T12:00:00-03:00')
const PERGUNTA_SOROS_BRASIL = 'Qual a relação de Soros com o Brasil?'
const FALE_SOROS_BRASIL = 'Fale sobre a relação de soros com o Brasil'

const FIXTURE_R2 = JSON.parse(await Deno.readTextFile(
  new URL('../chat/fixtures/ctx_r2.json', import.meta.url),
)) as Record<string, ChatContextPayload>

const FIXTURE_SOROS_FINANCEIRO = JSON.parse(await Deno.readTextFile(
  new URL('../chat/fixtures/ctx_soros_selecao.json', import.meta.url),
)) as Record<string, ChatContextPayload>

const FIXTURE_HOTFIX1 = JSON.parse(await Deno.readTextFile(
  new URL('../chat/fixtures/ctx_hotfix1.json', import.meta.url),
)) as Record<string, ChatContextPayload>

function assertFinalValido(final: ChatFinal): void {
  assert(typeof final.conversa_id === 'string' && final.conversa_id.length > 0, 'final.conversa_id')
  assert(Array.isArray(final.blocos) && final.blocos.length > 0, 'final.blocos')
  for (const bloco of final.blocos) assertBloco(bloco)
  assert(final.blocos.some((b) => b.tipo === 'documentado'), 'ao menos um bloco documentado')
  assert(Array.isArray(final.entidades), 'final.entidades')
  assert(Array.isArray(final.fontes), 'final.fontes')
  assert(final.fontes_detalhe && typeof final.fontes_detalhe === 'object', 'fontes_detalhe')
  for (const id of final.fontes) {
    const detalhe = final.fontes_detalhe[id]
    assert(detalhe && typeof detalhe.titulo === 'string', `detalhe ${id}`)
  }
  assert(Array.isArray(final.avisos), 'final.avisos')
  assert(typeof final.custo_real === 'number' && final.custo_real >= 0, 'final.custo_real')
  assert(typeof final.gratis_restantes === 'number', 'final.gratis_restantes')
  assert(typeof final.saldo_pago === 'number', 'final.saldo_pago')
}

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

function acceptedKey() {
  return assessInferenceKey({
    data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false },
  })
}

function memoryFrom(map: Record<string, ChatContextPayload>): { store: MemoryChatDb; calls: string[] } {
  const calls: string[] = []
  const store = createMemoryDb({ clock: CLOCK })
  store.chatContext = async (ids, query) => {
    const k = chave(ids, query)
    calls.push(k)
    const hit = map[k] ?? (ids.length === 0 && (query ?? '').includes('soros') ? map['|soros'] : undefined)
    return hit ? JSON.parse(JSON.stringify(hit)) as ChatContextPayload : vazio()
  }
  return { store, calls }
}

function finalOf(events: ChatSseEvent[]): ChatFinal {
  const event = events.find((item) => item.event === 'final')
  assert(event && event.event === 'final', `sem final: ${events.map((item) => item.event).join(',')}`)
  return event.data
}

function relacoesNoPrompt(prepared: Extract<Awaited<ReturnType<typeof prepareChat>>, { ok: true }>): string[] {
  const messages = prepared.requestBody.messages as Array<{ content: string }>
  const texto = messages[0].content
  const json = texto.slice(texto.lastIndexOf('\n') + 1)
  const parsed = JSON.parse(json) as { relacoes?: Array<{ id?: string }> }
  return (parsed.relacoes ?? []).map((rel) => {
    const numero = String(rel.id ?? '').replace(/\D/g, '')
    return prepared.apelidos[numero] || String(rel.id ?? '')
  })
}

function entidadesNoPrompt(prepared: Extract<Awaited<ReturnType<typeof prepareChat>>, { ok: true }>): string[] {
  const messages = prepared.requestBody.messages as Array<{ content: string }>
  const texto = messages[0].content
  const json = texto.slice(texto.lastIndexOf('\n') + 1)
  const parsed = JSON.parse(json) as { entidades?: Array<{ id?: string }> }
  return (parsed.entidades ?? []).map((ent) => {
    const numero = String(ent.id ?? '').replace(/\D/g, '')
    return prepared.apelidos[numero] || String(ent.id ?? '')
  })
}

function fontesNoPrompt(prepared: Extract<Awaited<ReturnType<typeof prepareChat>>, { ok: true }>): string[] {
  const messages = prepared.requestBody.messages as Array<{ content: string }>
  const texto = messages[0].content
  const json = texto.slice(texto.lastIndexOf('\n') + 1)
  const parsed = JSON.parse(json) as { fontes?: Array<{ id?: string }> }
  return (parsed.fontes ?? []).map((f) => {
    const numero = String(f.id ?? '').replace(/\D/g, '')
    return prepared.apelidos[numero] || String(f.id ?? '')
  })
}

Deno.test('1 conclusão de ausência nunca sai como bloco documentado', async () => {
  const ctx = FIXTURE_SOROS_FINANCEIRO['|soros']
  const entradas = [
    'Lula não está na base do atlas.',
    'A base ainda não cobre a relação de Soros com o Brasil.',
    'O atlas não documenta ligação direta entre Soros e o Brasil.',
    'Não há registro na base sobre atuação direta nesse ponto.',
  ]
  for (const texto of entradas) {
    assert(ehConclusaoDeAusencia(texto), `deveria detectar conclusão de ausência: ${texto}`)
    const { answer } = sanitizeAnswer({
      blocos: [{
        tipo: 'documentado',
        texto,
        entidades: ['soros'],
        relacoes: ['SOE01'],
        fontes: ['SO05'],
      }],
      sem_base: false,
    }, ctx)
    assert(answer.blocos.length === 1, `bloco preservado para: ${texto}`)
    assert(answer.blocos[0].tipo !== 'documentado', `não pode ser documentado: ${texto}`)
    eq(answer.blocos[0].tipo, 'inferencia', `convertido para inferencia: ${texto}`)
    assertBloco(answer.blocos[0])
  }

  // avisoAusente empurrado pelo pós-processamento (ex.: Lula ausente em Soros/Lula) também não sai como documentado.
  const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  const { events } = await runChat({
    userId: USER,
    body: {
      mensagem: 'qual a ligação de Soros e Lula? pq Soros comemorou a vitória de Lula?',
      contexto: { entidades: [] },
      modelo: 'basico',
    },
    db: store,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    openrouter: {
      async *stream() {
        yield {
          delta: JSON.stringify({
            blocos: [{
              tipo: 'documentado',
              texto: 'George Soros fundou a Open Society Foundations e a Soros Fund Management.',
              entidades: ['soros', 'george_soros', 'osf', 'sfm'],
              relacoes: ['SOE01', 'SOE02', 'SOE03'],
              fontes: ['SO05', 'SO07'],
            }],
            sem_base: false,
            em_aberto: null,
          }),
        }
        yield { usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0.0001 } }
      },
    },
  })
  const final = finalOf(events)
  assertFinal(final)
  const blocoAusente = final.blocos.find((b) => b.texto.includes('Lula não está na base do atlas.'))
  assert(blocoAusente, 'bloco de ausente presente')
  assert(blocoAusente.tipo !== 'documentado', 'avisoAusente nunca é documentado')
  eq(blocoAusente.tipo, 'inferencia', 'avisoAusente usa tipo inferencia')

  // fallbackSemLigacao também não rotula a frase de lacuna como documentado.
  const doisTemas: ChatContextPayload = {
    raizes: [{ id: 'a', nome: 'Tema A' }, { id: 'b', nome: 'Tema B' }],
    entidades: [{ id: 'a', nome: 'Tema A' }, { id: 'b', nome: 'Tema B' }],
    relacoes: [
      { id: 'r1', origem: 'a', destino: 'a', afirmacao: 'Fato A documentado.', fontes: ['f1'] },
      { id: 'r2', origem: 'b', destino: 'b', afirmacao: 'Fato B documentado.', fontes: ['f2'] },
    ],
    fontes: [{ id: 'f1', titulo: 'Fonte 1' }, { id: 'f2', titulo: 'Fonte 2' }],
  }
  const fb = fallbackSemLigacao(doisTemas)
  assert(fb, 'fallback gerado')
  const blocoLacuna = fb.blocos.find((b) => b.texto.includes('não documenta ligação direta'))
  assert(blocoLacuna && blocoLacuna.tipo !== 'documentado', 'lacuna do fallback não é documentado')
})

Deno.test('2a pergunta Soros com o Brasil conserva Fundo Brasil, SOE30–32, SOE48 e SO09/SO10 quando a base tem', async () => {
  for (const pergunta of [PERGUNTA_SOROS_BRASIL, FALE_SOROS_BRASIL]) {
    const { store } = memoryFrom(FIXTURE_R2)
    const prepared = await prepareChat({
      userId: USER,
      body: { mensagem: pergunta, contexto: { entidades: [] }, modelo: 'basico' },
      db: store,
      clock: CLOCK,
      inferenceKey: acceptedKey(),
    })
    assert(prepared.ok, `prepare falhou em ${pergunta}`)
    const rels = relacoesNoPrompt(prepared)
    const ents = entidadesNoPrompt(prepared)
    const fontes = fontesNoPrompt(prepared)
    for (const relId of ['SOE30', 'SOE31', 'SOE32', 'SOE48']) {
      assert(rels.includes(relId), `${pergunta}: faltou relação ${relId} em ${rels.join(',')}`)
    }
    for (const entId of ['fundobrasil', 'osi_fundo_br', 'osf_latam_2025', 'caso_op17', 'caso_op18', 'pedro_abramovay']) {
      assert(ents.includes(entId), `${pergunta}: faltou entidade ${entId} em ${ents.join(',')}`)
    }
    for (const fId of ['SO09', 'SO10']) {
      assert(fontes.includes(fId), `${pergunta}: faltou fonte ${fId} em ${fontes.join(',')}`)
    }
  }

  // Também quando SOE30–32 já vêm misturadas num mesmo contexto com o núcleo financeiro:
  const misto: ChatContextPayload = {
    raizes: [...FIXTURE_R2['|soros'].raizes],
    entidades: [
      ...FIXTURE_R2['|soros'].entidades,
      ...FIXTURE_R2['|open society foundations brasil'].entidades.filter(
        (e) => !FIXTURE_R2['|soros'].entidades.some((s) => s.id === e.id),
      ),
    ],
    relacoes: [
      ...FIXTURE_R2['|soros'].relacoes,
      ...FIXTURE_R2['|open society foundations brasil'].relacoes.filter(
        (r) => !FIXTURE_R2['|soros'].relacoes.some((s) => s.id === r.id),
      ),
    ],
    fontes: [
      ...FIXTURE_R2['|soros'].fontes,
      ...FIXTURE_R2['|open society foundations brasil'].fontes.filter(
        (f) => !FIXTURE_R2['|soros'].fontes.some((s) => s.id === f.id),
      ),
    ],
  }
  const ordenado = ordenarRecortePorPergunta(misto, PERGUNTA_SOROS_BRASIL, ['soros'])
  const topo = ordenado.relacoes.slice(0, 12).map((r) => r.id)
  for (const relId of ['SOE30', 'SOE31', 'SOE32', 'SOE48']) {
    assert(topo.includes(relId), `ordenação conservou ${relId} no topo: ${topo.join(',')}`)
  }
})

Deno.test('2b recorte só financeiro de Soros nunca afirma que não há vínculo ou que circula sem lastro', async () => {
  assert(fraseInexistencia('Tudo indica que não há vínculo entre George Soros e o Brasil.'), 'detecta não há vínculo')
  assert(fraseInexistencia('A associação entre Soros e o Brasil circula sem lastro.'), 'detecta circula sem lastro')
  assert(fraseInexistencia('Os documentos provam a inexistência de vínculo com o Brasil.'), 'detecta inexistência de vínculo')

  // Simula exatamente a resposta ruim do v21 ao vivo (citando só SO05, SO07, SO17, SO18 para afirmar inexistência):
  const respostaRuimV21 = JSON.stringify({
    blocos: [
      {
        tipo: 'documentado',
        texto: 'Tudo indica que não há vínculo entre George Soros e o Brasil, e essa associação circula sem lastro. George Soros é o fundador identificado da Soros Fund Management e da Open Society Foundations.',
        entidades: ['soros', 'george_soros', 'sfm', 'osf'],
        relacoes: ['SOE01', 'SOE02', 'SOE03'],
        fontes: ['SO05', 'SO07'],
      },
      {
        tipo: 'documentado',
        texto: 'O que liga tudo: a trajetória documentada concentra-se no Quantum Fund criado em 1973 e na atuação com Nils Taube. Não existe relação com o Brasil e a narrativa circula sem lastro documental.',
        entidades: ['george_soros', 'quantum_fund_nv', 'nils_taube'],
        relacoes: ['SOE35', 'SOE37'],
        fontes: ['SO17', 'SO18'],
      },
    ],
    sem_base: false,
    em_aberto: null,
  })

  const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  const { events } = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    openrouter: {
      async *stream() {
        yield { delta: respostaRuimV21 }
        yield { usage: { prompt_tokens: 30, completion_tokens: 40, cost: 0.0002 } }
      },
    },
  })
  const final = finalOf(events)
  assertFinalValido(final)
  const textoTodo = final.blocos.map((b) => b.texto).join('\n')
  assert(!/n[aã]o\s+h[aá]\s+v[ií]nculo/i.test(textoTodo), `afirmou não há vínculo: ${textoTodo}`)
  assert(!/n[aã]o\s+existe\s+rela[cç][aã]o/i.test(textoTodo), `afirmou não existe relação: ${textoTodo}`)
  assert(!/circula(?:m)?\s+sem\s+lastro/i.test(textoTodo), `afirmou circula sem lastro: ${textoTodo}`)
  assert(!/sem\s+lastro/i.test(textoTodo), `afirmou sem lastro: ${textoTodo}`)
  assert(!/base ainda n[aã]o cobre/i.test(textoTodo), `não injeta recusa seca enlatada: ${textoTodo}`)
  assert(textoTodo.includes('Soros Fund Management') || textoTodo.includes('Open Society'), 'preservou o que a base tem sobre Soros')
})

Deno.test('3 flag web off: nenhum fetch de busca; resposta usa o mais próximo da base sem recusa seca', async () => {
  Deno.env.delete('CHAT_WEB_FALLBACK')
  eq(isWebFallbackEnabled(), false, 'padrão desligado')
  eq(isWebFallbackEnabled('0'), false, '0 desligado')
  eq(isWebFallbackEnabled('false'), false, 'false desligado')

  let chamadasWeb = 0
  const mockWeb: WebSearchClient = {
    async search() {
      chamadasWeb += 1
      return [{ titulo: 'Nunca chamado', url: 'https://example.org/nunca' }]
    },
  }

  // Mesmo se o modelo devolver apenas sentenças de inexistência sobre Soros no Brasil:
  const soInexistencia = JSON.stringify({
    blocos: [{
      tipo: 'documentado',
      texto: 'Não há vínculo entre George Soros e o Brasil. A associação circula sem lastro.',
      entidades: ['soros', 'george_soros'],
      relacoes: ['SOE01', 'SOE02', 'SOE35', 'SOE37'],
      fontes: ['SO05', 'SO07', 'SO17', 'SO18'],
    }],
    sem_base: false,
    em_aberto: null,
  })

  const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  const { events } = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: false,
    webSearch: mockWeb,
    openrouter: {
      async *stream() {
        yield { delta: soInexistencia }
        yield { usage: { prompt_tokens: 25, completion_tokens: 25, cost: 0.0002 } }
      },
    },
  })

  eq(chamadasWeb, 0, 'flag off não chama busca web')
  const final = finalOf(events)
  assertFinalValido(final)
  const docs = final.blocos.filter((b) => b.tipo === 'documentado')
  assert(docs.length >= 1, 'complementa com o que a base tem em bloco documentado')
  const textoTodo = final.blocos.map((b) => b.texto).join('\n')
  assert(!/base ainda n[aã]o cobre/i.test(textoTodo), `sem recusa seca enlatada: ${textoTodo}`)
  assert(!/n[aã]o\s+h[aá]\s+v[ií]nculo|circula\s+sem\s+lastro/i.test(textoTodo), 'sem veredito de inexistência')
})

Deno.test('4 flag web on + mock de busca: fontes externas citadas e marcadas; sem promover a documentado da base', async () => {
  eq(isWebFallbackEnabled('1'), true, '1 ligado')
  eq(isWebFallbackEnabled('true'), true, 'true ligado')
  eq(isWebFallbackEnabled(true), true, 'boolean true ligado')

  // Contrato de preço do completion continua intocado: max_price.request === 0 e sem plugins.
  const prompt = buildSystemPrompt('basico', FIXTURE_SOROS_FINANCEIRO['|soros'])
  const reqBody = modelRequestBody('basico', prompt, PERGUNTA_SOROS_BRASIL)
  const provider = reqBody.provider as { max_price?: { request?: number } }
  eq(provider?.max_price?.request, 0, 'max_price.request continua 0')
  assert(!('plugins' in reqBody) && !('tools' in reqBody), 'sem plugins ou tools no completion body')

  // Testa também o cliente HTTP separado createFetchWebSearch com mock local de fetchImpl (sem rede real):
  let fetchUrl = ''
  const braveClient = createFetchWebSearch({
    provider: 'brave',
    apiKey: 'mock-local-key',
    fetchImpl: async (url) => {
      fetchUrl = String(url)
      return new Response(JSON.stringify({
        web: {
          results: [
            {
              title: 'Nova estratégia latino-americana com foco no Brasil',
              url: 'https://www.opensocietyfoundations.org/newsroom/latin-america-strategy',
              description: 'Estratégia de oito anos da Open Society no Brasil.',
              profile: { name: 'Open Society Foundations' },
            },
            {
              title: 'Demonstrações financeiras do Fundo Brasil',
              url: 'https://www.fundobrasil.org.br/balanco-2022.pdf',
              description: 'Rubrica Open Society Institute nas receitas internacionais.',
              profile: { name: 'Fundo Brasil de Direitos Humanos' },
            },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  const { events } = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: true,
    webSearch: braveClient,
    openrouter: {
      async *stream() {
        yield {
          delta: JSON.stringify({
            blocos: [{
              tipo: 'documentado',
              texto: 'George Soros fundou a Soros Fund Management e a Open Society Foundations.',
              entidades: ['soros', 'george_soros', 'sfm', 'osf'],
              relacoes: ['SOE01', 'SOE02', 'SOE03'],
              fontes: ['SO05', 'SO07'],
            }],
            sem_base: false,
            em_aberto: null,
          }),
        }
        yield { usage: { prompt_tokens: 25, completion_tokens: 25, cost: 0.0002 } }
      },
    },
  })

  assert(fetchUrl.includes('api.search.brave.com'), `chamou HTTP separado de busca: ${fetchUrl}`)
  const final = finalOf(events)
  assertFinal(final)

  // Nenhum bloco documentado pode conter as fontes externas nem o texto da busca externa.
  const docs = final.blocos.filter((b) => b.tipo === 'documentado')
  assert(docs.length >= 1, 'mantém bloco documentado da base')
  for (const doc of docs) {
    assert(doc.tipo === 'documentado', 'tipo documentado')
    assert(!doc.fontes.some((id) => id.startsWith('ext_')), `fonte externa não entra em bloco documentado: ${doc.fontes.join(',')}`)
    assert(!doc.texto.includes('https://www.opensocietyfoundations.org/newsroom/latin-america-strategy'), 'URL externa fora do bloco documentado')
  }

  // O bloco externo é inferencia (não documentado), cita URL + editor/título e marca como fonte externa, não verificada na base.
  const blocoExterno = final.blocos.find((b) => b.tipo === 'inferencia' && b.texto.includes(EXTERNA_NAO_VERIFICADA))
  assert(blocoExterno, 'bloco externo como inferencia presente')
  assert(blocoExterno.texto.includes('https://www.opensocietyfoundations.org/newsroom/latin-america-strategy'), 'cita URL externa 1')
  assert(blocoExterno.texto.includes('https://www.fundobrasil.org.br/balanco-2022.pdf'), 'cita URL externa 2')
  assert(blocoExterno.texto.includes('Open Society Foundations'), 'cita editor 1')
  assert(blocoExterno.texto.includes('Fundo Brasil de Direitos Humanos'), 'cita editor 2')

  // Fontes externas registradas em fontes_detalhe com a marca de não verificada na base.
  assert(final.fontes.includes('ext_1') && final.fontes.includes('ext_2'), `fontes externas listadas: ${final.fontes.join(',')}`)
  assert(final.fontes_detalhe.ext_1.titulo.includes(EXTERNA_NAO_VERIFICADA), 'detalhe ext_1 marcado')
  eq(final.fontes_detalhe.ext_1.url, 'https://www.opensocietyfoundations.org/newsroom/latin-america-strategy', 'URL ext_1')
  eq(final.fontes_detalhe.ext_1.localizador, EXTERNA_NAO_VERIFICADA, 'localizador ext_1 marcado')
})

Deno.test('5 flag web on + busca falha: degradação segura sem inventar fato nem fonte', async () => {
  let tentativasWeb = 0
  const failingWeb: WebSearchClient = {
    async search() {
      tentativasWeb += 1
      throw new Error('timeout_provedor_busca')
    },
  }

  const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  const { events } = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: true,
    webSearch: failingWeb,
    openrouter: {
      async *stream() {
        yield {
          delta: JSON.stringify({
            blocos: [{
              tipo: 'documentado',
              texto: 'George Soros fundou a Soros Fund Management e a Open Society Foundations.',
              entidades: ['soros', 'george_soros', 'sfm', 'osf'],
              relacoes: ['SOE01', 'SOE02', 'SOE03'],
              fontes: ['SO05', 'SO07'],
            }],
            sem_base: false,
            em_aberto: null,
          }),
        }
        yield { usage: { prompt_tokens: 25, completion_tokens: 25, cost: 0.0002 } }
      },
    },
  })

  eq(tentativasWeb, 1, 'tentou a busca web uma vez')
  const final = finalOf(events)
  assertFinalValido(final)
  assert(!final.fontes.some((id) => id.startsWith('ext_')), 'nenhuma fonte externa inventada na falha')
  const textoTodo = final.blocos.map((b) => b.texto).join('\n')
  assert(textoTodo.includes('Soros Fund Management') || textoTodo.includes('Open Society'), 'degrada para o mais próximo da base')
  assert(!/base ainda n[aã]o cobre/i.test(textoTodo), `sem recusa seca na falha da busca: ${textoTodo}`)
  assert(!/timeout_provedor_busca/i.test(textoTodo), 'não vaza erro interno da busca')
  assert(!/n[aã]o\s+h[aá]\s+v[ií]nculo|circula\s+sem\s+lastro/i.test(textoTodo), 'não afirma inexistência na falha')
})

Deno.test('6 snippets de busca externa passam pelas guardas de prosa pública e acusação', async () => {
  const mockWeb: WebSearchClient = {
    async search() {
      return [{
        titulo: 'Relatório público sobre fundações',
        editor: 'Portal Exemplo',
        trecho: 'Pessoa Exemplo cometeu fraude. Não existe relação com o Brasil.',
        url: 'https://example.org/relatorio-publico',
      }]
    },
  }

  const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  const { events } = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: true,
    webSearch: mockWeb,
    openrouter: {
      async *stream() {
        yield {
          delta: JSON.stringify({
            blocos: [{
              tipo: 'documentado',
              texto: 'George Soros fundou a Soros Fund Management e a Open Society Foundations.',
              entidades: ['soros', 'george_soros', 'sfm', 'osf'],
              relacoes: ['SOE01', 'SOE02', 'SOE03'],
              fontes: ['SO05', 'SO07'],
            }],
            sem_base: false,
            em_aberto: null,
          }),
        }
        yield { usage: { prompt_tokens: 25, completion_tokens: 25, cost: 0.0002 } }
      },
    },
  })

  const final = finalOf(events)
  assertFinal(final)
  const textoTodo = final.blocos.map((b) => b.texto).join('\n')
  assert(!/cometeu fraude/i.test(textoTodo), `snippet acusatório vazou: ${textoTodo}`)
  assert(!/n[aã]o\s+existe\s+rela[cç][aã]o/i.test(textoTodo), `snippet de inexistência vazou: ${textoTodo}`)
  assert(!/Pessoa Exemplo/i.test(textoTodo), `trecho filtrado não deve aparecer: ${textoTodo}`)
  const blocoExterno = final.blocos.find((b) => b.tipo === 'inferencia' && b.texto.includes('https://example.org/relatorio-publico'))
  assert(blocoExterno, `título + URL mantidos quando trecho fica vazio: ${textoTodo}`)
  assert(blocoExterno.texto.includes('Relatório público sobre fundações'), 'título mantido')
  assert(!blocoExterno.texto.includes('Relatório público sobre fundações:'), 'sem dois-pontos órfão quando trecho fica vazio')
})

Deno.test('7 cancelamento durante webSearch desfaz reserva sem commit de créditos', async () => {
  const controller = new AbortController()
  const abortingWeb: WebSearchClient = {
    async search() {
      controller.abort()
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    },
  }

  const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  let commits = 0
  let releases = 0
  const origCommit = store.commitCredits.bind(store)
  const origRelease = store.releaseReserve.bind(store)
  store.commitCredits = async (...args) => { commits += 1; return await origCommit(...args) }
  store.releaseReserve = async (...args) => { releases += 1; return await origRelease(...args) }

  const { events } = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    signal: controller.signal,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: true,
    webSearch: abortingWeb,
    openrouter: {
      async *stream() {
        yield {
          delta: JSON.stringify({
            blocos: [{
              tipo: 'documentado',
              texto: 'George Soros fundou a Soros Fund Management e a Open Society Foundations.',
              entidades: ['soros', 'george_soros', 'sfm', 'osf'],
              relacoes: ['SOE01', 'SOE02', 'SOE03'],
              fontes: ['SO05', 'SO07'],
            }],
            sem_base: false,
            em_aberto: null,
          }),
        }
        yield { usage: { prompt_tokens: 25, completion_tokens: 25, cost: 0.0002 } }
      },
    },
  })

  eq(commits, 0, 'aborto durante webSearch não pode commitar créditos')
  eq(releases, 1, 'aborto durante webSearch deve liberar a reserva uma vez')
  const erro = events.find((ev) => ev.event === 'error')
  assert(erro && erro.event === 'error', `deve emitir evento error: ${events.map((e) => e.event).join(',')}`)
  eq(erro.data.code, 'abortado', 'código de erro deve ser abortado')
  assert(!events.some((ev) => ev.event === 'final'), 'não deve emitir final após aborto')
})

Deno.test('8 citação entre aspas com frase interna de inexistência sai intacta', () => {
  const ctx = FIXTURE_SOROS_FINANCEIRO['|soros']
  const entrada = 'O relatório registra: "A atuação foi revisada. Não existe relação entre os temas." O grupo publicou o relatório.'
  const { answer } = sanitizeAnswer({
    blocos: [{
      tipo: 'documentado',
      texto: entrada,
      entidades: ['soros', 'george_soros'],
      relacoes: ['SOE01'],
      fontes: ['SO05'],
    }],
    sem_base: false,
  }, ctx)
  eq(answer.blocos.length, 1, 'bloco com citação preservado')
  eq(answer.blocos[0].texto, entrada, 'citação entre aspas sai intacta sem quebrar frases internas')
})

Deno.test('9 plurais em -ão/-ões são detectados por fraseInexistencia', () => {
  assert(fraseInexistencia('Não existem relações entre George Soros e o Brasil.'), 'detecta Não existem relações')
  assert(fraseInexistencia('Inexistem ligações comprovadas com o país.'), 'detecta Inexistem ligações')
  assert(fraseInexistencia('Não possui conexões ou operações registradas.'), 'detecta conexões/operações')
  assert(fraseInexistencia('Ausência total de atuações no país.'), 'detecta atuações')
})

Deno.test('10 frases reais do v21 ao vivo são removidas e preservam o mais próximo da base sem bloco enlatado', async () => {
  const respostaRealV21 = JSON.stringify({
    blocos: [
      {
        tipo: 'documentado',
        texto: 'George Soros fundou a Soros Fund Management e a Open Society Foundations. A trajetória documentada segue sem qualquer registro de atuação no Brasil. Nenhum desses movimentos aparece associado ao território brasileiro. A hipótese de uma atuação direta no Brasil não se sustenta.',
        entidades: ['soros', 'george_soros', 'sfm', 'osf'],
        relacoes: ['SOE01', 'SOE02', 'SOE03'],
        fontes: ['SO05', 'SO07'],
      },
      {
        tipo: 'documentado',
        texto: 'O Quantum Fund foi criado em 1973 e atuou com Nils Taube. A hipótese de uma relação direta com o país não encontra apoio. Quem procurar um vínculo brasileiro neste conjunto de fatos não o encontra. Quem procurou um vínculo brasileiro encontrou apenas o silêncio dos documentos.',
        entidades: ['george_soros', 'quantum_fund_nv', 'nils_taube'],
        relacoes: ['SOE35', 'SOE37'],
        fontes: ['SO17', 'SO18'],
      },
    ],
    sem_base: false,
    em_aberto: null,
  })

  const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  const { events } = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: false,
    openrouter: {
      async *stream() {
        yield { delta: respostaRealV21 }
        yield { usage: { prompt_tokens: 30, completion_tokens: 50, cost: 0.0002 } }
      },
    },
  })

  const final = finalOf(events)
  assertFinalValido(final)
  const textoTodo = final.blocos.map((b) => b.texto).join('\n')
  const proibidas = [
    /sem qualquer registro de atua[cç][aã]o no brasil/i,
    /nenhum desses movimentos aparece associado ao territ[oó]rio brasileiro/i,
    /hip[oó]tese de uma atua[cç][aã]o direta no brasil n[aã]o se sustenta/i,
    /hip[oó]tese de uma rela[cç][aã]o direta com o pa[ií]s n[aã]o encontra apoio/i,
    /quem procurar um v[ií]nculo brasileiro/i,
    /quem procurou um v[ií]nculo brasileiro/i,
    /sil[eê]ncio dos documentos/i,
    /base ainda n[aã]o cobre/i,
  ]
  for (const re of proibidas) {
    assert(!re.test(textoTodo), `frase proibida vazou (${re}): ${textoTodo}`)
  }
  assert(textoTodo.includes('Soros Fund') && textoTodo.includes('Open Society'), `preserva frase documentada sobre SFM/OSF: ${textoTodo}`)
  assert(textoTodo.includes('Quantum Fund'), `preserva frase documentada sobre Quantum Fund: ${textoTodo}`)
})

Deno.test('11 pergunta estrutural não monta relação entre aliases (George Soros e Soros) mas preserva entidades distintas', async () => {
  // 1) Recorte financeiro (ctx_soros_selecao) com a prosa ruim do v21 do teste 10:
  const respostaRealV21 = JSON.stringify({
    blocos: [
      {
        tipo: 'documentado',
        texto: 'George Soros fundou a Soros Fund Management e a Open Society Foundations. A trajetória documentada segue sem qualquer registro de atuação no Brasil. Nenhum desses movimentos aparece associado ao território brasileiro. A hipótese de uma atuação direta no Brasil não se sustenta.',
        entidades: ['soros', 'george_soros', 'sfm', 'osf'],
        relacoes: ['SOE01', 'SOE02', 'SOE03'],
        fontes: ['SO05', 'SO07'],
      },
      {
        tipo: 'documentado',
        texto: 'O Quantum Fund foi criado em 1973 e atuou com Nils Taube. A hipótese de uma relação direta com o país não encontra apoio. Quem procurar um vínculo brasileiro neste conjunto de fatos não o encontra. Quem procurou um vínculo brasileiro encontrou apenas o silêncio dos documentos.',
        entidades: ['george_soros', 'quantum_fund_nv', 'nils_taube'],
        relacoes: ['SOE35', 'SOE37'],
        fontes: ['SO17', 'SO18'],
      },
    ],
    sem_base: false,
    em_aberto: null,
  })

  const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  const { events } = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: false,
    openrouter: {
      async *stream() {
        yield { delta: respostaRealV21 }
        yield { usage: { prompt_tokens: 30, completion_tokens: 50, cost: 0.0002 } }
      },
    },
  })

  const final = finalOf(events)
  assertFinalValido(final)
  const ultimoTexto = final.blocos.at(-1)!.texto
  assert(/Que documento detalharia /.test(ultimoTexto), `pergunta estrutural presente: ${ultimoTexto}`)
  assert(!/entre George Soros e Soros/i.test(ultimoTexto), `não pode perguntar relação entre George Soros e Soros: ${ultimoTexto}`)
  assert(!/entre Soros e George Soros/i.test(ultimoTexto), `não pode perguntar relação entre Soros e George Soros: ${ultimoTexto}`)

  // 2) Caso explícito: par george_soros + soros (ligados) cai no papel de George Soros, mesmo quando soros tem mais citações.
  const ctxSoAlias: ChatContextPayload = {
    raizes: [{ id: 'soros', nome: 'Soros · índice familiar', tipo: 'familia' }],
    entidades: [
      { id: 'soros', nome: 'Soros · índice familiar', tipo: 'familia' },
      { id: 'george_soros', nome: 'George Soros', tipo: 'pessoa' },
    ],
    relacoes: [
      { id: 'SOE01', origem: 'soros', destino: 'george_soros', afirmacao: 'George Soros é o nome principal do índice familiar.', fontes: ['SO05'] },
    ],
    fontes: [{ id: 'SO05', titulo: 'Fonte 5' }],
  }
  assert(saoAliasPublicos(ctxSoAlias, 'george_soros', 'soros'), 'george_soros e soros são aliases públicos')
  assert(saoAliasPublicos(ctxSoAlias, 'soros', 'george_soros'), 'alias é simétrico')

  const perguntaAliasPessoaPrimeiro = perguntaEstrutural(
    [{ entidades: ['george_soros', 'soros'], relacoes: ['SOE01'] }],
    ctxSoAlias,
  )
  eq(perguntaAliasPessoaPrimeiro, 'Que documento detalharia o papel de George Soros?', 'fallback prefere papel de George Soros')

  const perguntaAliasIndiceMaisCitado = perguntaEstrutural(
    [
      { entidades: ['soros', 'george_soros'], relacoes: ['SOE01'] },
      { base: ['soros'] },
      { base: ['soros'] },
    ],
    ctxSoAlias,
  )
  eq(perguntaAliasIndiceMaisCitado, 'Que documento detalharia o papel de George Soros?', 'mesmo com índice mais citado, prefere o nome mais específico da pessoa')

  // 3) Controles: George Soros ≠ Alex Soros; SFM, Open Society e fundos ≠ índice Soros.
  const ctxControle: ChatContextPayload = {
    raizes: [{ id: 'soros', nome: 'Soros · índice familiar', tipo: 'familia' }],
    entidades: [
      { id: 'soros', nome: 'Soros · índice familiar', tipo: 'familia' },
      { id: 'george_soros', nome: 'George Soros', tipo: 'pessoa' },
      { id: 'alex_soros', nome: 'Alex Soros', tipo: 'pessoa' },
      { id: 'sfm', nome: 'Soros Fund Management LLC', tipo: 'empresa' },
      { id: 'osf', nome: 'Open Society Foundations · rede', tipo: 'conjunto' },
      { id: 'fundo_soros', nome: 'Fundo Soros', tipo: 'fundo' },
    ],
    relacoes: [
      { id: 'R_GA', origem: 'george_soros', destino: 'alex_soros', afirmacao: 'Sucessão na diretoria.', fontes: ['F1'] },
      { id: 'R_SSFM', origem: 'soros', destino: 'sfm', afirmacao: 'Vínculo societário.', fontes: ['F1'] },
      { id: 'R_SOSF', origem: 'soros', destino: 'osf', afirmacao: 'Vínculo institucional.', fontes: ['F1'] },
    ],
    fontes: [{ id: 'F1', titulo: 'Fonte 1' }],
  }
  assert(!saoAliasPublicos(ctxControle, 'george_soros', 'alex_soros'), 'George Soros e Alex Soros não são aliases')
  assert(!saoAliasPublicos(ctxControle, 'soros', 'sfm'), 'SFM não é alias de Soros')
  assert(!saoAliasPublicos(ctxControle, 'soros', 'osf'), 'Open Society não é alias de Soros')
  assert(!saoAliasPublicos(ctxControle, 'soros', 'fundo_soros'), 'Fundo Soros (fundo) não é alias do índice Soros')

  const perguntaGeorgeAlex = perguntaEstrutural(
    [{ entidades: ['george_soros', 'alex_soros'], relacoes: ['R_GA'] }],
    ctxControle,
  )
  assert(
    perguntaGeorgeAlex === 'Que documento detalharia a relação entre Alex Soros e George Soros?' ||
      perguntaGeorgeAlex === 'Que documento detalharia a relação entre George Soros e Alex Soros?',
    `George Soros e Alex Soros formam relação entre si: ${perguntaGeorgeAlex}`,
  )

  const perguntaSorosSfm = perguntaEstrutural(
    [{ entidades: ['soros', 'sfm'], relacoes: ['R_SSFM'] }],
    ctxControle,
  )
  assert(
    /Que documento detalharia a relação entre (?:Soros e Soros Fund Management LLC|Soros Fund Management LLC e Soros)\?/.test(perguntaSorosSfm),
    `Soros e SFM podem formar relação: ${perguntaSorosSfm}`,
  )
})

Deno.test('12 regressão Soros com recorte Brasil: documenta Fundo Brasil/OSF sem recusa seca nem desmentido', async () => {
  // Caso A: modelo documenta Fundo Brasil / OSF e aponta lacuna pontual em bloco hipotese.
  const respostaComLacunaPontual = JSON.stringify({
    blocos: [
      {
        tipo: 'documentado',
        texto: 'A Open Society Foundations financiou o Fundo Brasil de Direitos Humanos e estruturou estratégia latino-americana com foco no Brasil.',
        entidades: ['soros', 'osf', 'fundobrasil', 'osf_latam_2025'],
        relacoes: ['SOE30', 'SOE31', 'SOE32', 'SOE48'],
        fontes: ['SO09', 'SO10'],
      },
      {
        tipo: 'hipotese',
        texto: 'A documentação não registra reuniões bilaterais fora desses repasses.',
        base: ['soros', 'osf'],
        justificativa: 'Lacuna pontual sobre agendas fora dos balanços citados.',
      },
    ],
    sem_base: false,
    em_aberto: null,
  })

  // Caso B: modelo documenta Fundo Brasil / OSF mas deixa escapar uma frase de inexistência que é filtrada;
  // o pós-processamento NÃO pode injetar o bloco enlatado «A base ainda não cobre…» desmentindo os fatos já citados.
  const respostaComInexistenciaLateral = JSON.stringify({
    blocos: [
      {
        tipo: 'documentado',
        texto: 'A Open Society Foundations financiou o Fundo Brasil de Direitos Humanos e apoiou iniciativas no Brasil. Não há vínculo direto com campanhas eleitorais.',
        entidades: ['soros', 'osf', 'fundobrasil', 'osf_latam_2025'],
        relacoes: ['SOE30', 'SOE31', 'SOE32', 'SOE48'],
        fontes: ['SO09', 'SO10'],
      },
    ],
    sem_base: false,
    em_aberto: null,
  })

  for (const [nome, payload] of [
    ['lacuna pontual em hipotese', respostaComLacunaPontual],
    ['inexistencia lateral filtrada', respostaComInexistenciaLateral],
  ] as const) {
    const { store } = memoryFrom(FIXTURE_R2)
    const { events } = await runChat({
      userId: USER,
      body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
      db: store,
      clock: CLOCK,
      inferenceKey: acceptedKey(),
      repetirCurto: false,
      webFallback: false,
      openrouter: {
        async *stream() {
          yield { delta: payload }
          yield { usage: { prompt_tokens: 30, completion_tokens: 40, cost: 0.0002 } }
        },
      },
    })
    const final = finalOf(events)
    assertFinalValido(final)
    const docs = final.blocos.filter((b) => b.tipo === 'documentado')
    assert(docs.length >= 1, `${nome}: preserva bloco documentado`)
    const textoTodo = final.blocos.map((b) => b.texto).join('\n')
    assert(textoTodo.includes('Fundo Brasil') && textoTodo.includes('Open Society'), `${nome}: documenta ligação Brasil`)
    assert(!/base ainda n[aã]o cobre/i.test(textoTodo), `${nome}: nenhuma recusa seca ou desmentido enlatado: ${textoTodo}`)
    assert(!/n[aã]o\s+h[aá]\s+v[ií]nculo/i.test(textoTodo), `${nome}: sem veredito de inexistência`)
    for (const doc of docs) {
      assert(!ehConclusaoDeAusencia(doc.texto), `${nome}: bloco documentado não conclui ausência`)
    }
    if (nome === 'lacuna pontual em hipotese') {
      const lacuna = final.blocos.find((b) => b.texto.includes('reuniões bilaterais'))
      assert(lacuna && lacuna.tipo !== 'documentado', 'lacuna pontual convive em inferencia/hipotese')
    }
  }
})

Deno.test('13 pergunta fora da base (Odebrecht–Rockefeller): usa o mais próximo da base e integra Tavily com degradação segura', async () => {
  const PERGUNTA_Q14 = 'Qual a relação da família Odebrecht com a Fundação Rockefeller?'
  const mapaHotfix: Record<string, ChatContextPayload> = {}
  for (const [k, v] of Object.entries(FIXTURE_HOTFIX1)) {
    if (k !== '_nota' && v && typeof v === 'object') mapaHotfix[k] = v
  }
  const makeStore = () => {
    const store = createMemoryDb({ clock: CLOCK })
    store.chatContext = async (ids, query) => {
      const k = chave(ids, query)
      const hit = mapaHotfix[k]
      return hit ? JSON.parse(JSON.stringify(hit)) as ChatContextPayload : vazio()
    }
    return store
  }

  // A) Flag OFF: mesmo se o modelo devolver sem_base:true vazio, não termina em erro fora_da_base;
  // traz o mais próximo da base (Rockefeller no Brasil) + bloco inferencia indicando que Odebrecht não está na base.
  const storeOff = makeStore()
  const resOff = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_Q14, contexto: { entidades: [] }, modelo: 'basico' },
    db: storeOff,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: false,
    openrouter: {
      async *stream() {
        yield { delta: JSON.stringify({ blocos: [], sem_base: true, em_aberto: null }) }
        yield { usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.0001 } }
      },
    },
  })
  assert(!resOff.events.some((e) => e.event === 'error'), `Q14 flag off não pode virar erro fora_da_base: ${resOff.events.map((e) => e.event).join(',')}`)
  const finalOff = finalOf(resOff.events)
  assertFinal(finalOff)
  const docsOff = finalOff.blocos.filter((b) => b.tipo === 'documentado')
  assert(docsOff.length >= 1, 'Q14 flag off traz bloco documentado mais próximo (Rockefeller)')
  const avisoOff = finalOff.blocos.find((b) => b.tipo === 'inferencia' && b.texto.includes('Odebrecht não está na base do atlas.'))
  assert(avisoOff, 'Q14 flag off deixa claro em inferencia que Odebrecht não está na base')

  // B) Flag ON + mock Tavily: incorpora hits filtrados e rotulados + mantém o mais próximo da base.
  let tavilyCalls = 0
  const tavilyMock = createFetchWebSearch({
    provider: 'tavily',
    apiKey: 'tvly-mock-local-q14',
    fetchImpl: async () => {
      tavilyCalls += 1
      return new Response(JSON.stringify({
        results: [
          {
            title: 'Arquivos públicos sobre projetos no Brasil',
            url: 'https://example.org/arquivo-rockefeller-brasil',
            content: 'Documentos históricos sobre programas de saúde e cooperação no Brasil. Fulano cometeu fraude.',
            source: 'Acervo Exemplo',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const storeOn = makeStore()
  const resOn = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_Q14, contexto: { entidades: [] }, modelo: 'basico' },
    db: storeOn,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: true,
    webSearch: tavilyMock,
    openrouter: {
      async *stream() {
        yield { delta: JSON.stringify({ blocos: [], sem_base: true, em_aberto: null }) }
        yield { usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.0001 } }
      },
    },
  })
  eq(tavilyCalls, 1, 'Q14 flag on chama mock Tavily uma vez')
  const finalOn = finalOf(resOn.events)
  assertFinal(finalOn)
  assert(finalOn.blocos.some((b) => b.tipo === 'documentado'), 'Q14 flag on mantém fatos documentados da base')
  const extBlock = finalOn.blocos.find((b) => b.tipo === 'inferencia' && b.texto.includes(EXTERNA_NAO_VERIFICADA))
  assert(extBlock, 'Q14 flag on traz bloco inferencia rotulado como fonte externa não verificada')
  assert(extBlock.texto.includes('https://example.org/arquivo-rockefeller-brasil'), 'cita URL do hit Tavily')
  assert(!/cometeu fraude/i.test(extBlock.texto), 'snippet acusatório filtrado no hit Tavily')
  assert(finalOn.fontes.includes('ext_1'), 'registra ext_1 em fontes')
  eq(finalOn.fontes_detalhe.ext_1.localizador, EXTERNA_NAO_VERIFICADA, 'localizador ext_1 rotulado')

  // C) Flag ON + mock Tavily falha (HTTP 500): chat não quebra e degrada para o mais próximo da base.
  const tavilyErro = createFetchWebSearch({
    provider: 'tavily',
    apiKey: 'tvly-mock-local-q14',
    fetchImpl: async () => new Response('upstream error', { status: 500 }),
  })
  const storeFalha = makeStore()
  const resFalha = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_Q14, contexto: { entidades: [] }, modelo: 'basico' },
    db: storeFalha,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: true,
    webSearch: tavilyErro,
    openrouter: {
      async *stream() {
        yield { delta: JSON.stringify({ blocos: [], sem_base: true, em_aberto: null }) }
        yield { usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.0001 } }
      },
    },
  })
  const finalFalha = finalOf(resFalha.events)
  assertFinal(finalFalha)
  assert(finalFalha.blocos.some((b) => b.tipo === 'documentado'), 'Q14 falha Tavily preserva fatos da base')
  assert(!finalFalha.fontes.some((id) => id.startsWith('ext_')), 'Q14 falha Tavily não inventa fonte externa')
  const textoFalha = finalFalha.blocos.map((b) => b.texto).join('\n')
  assert(!/base ainda n[aã]o cobre/i.test(textoFalha), `Q14 falha Tavily sem recusa seca: ${textoFalha}`)
})

Deno.test('14 Tavily + flag: formato oficial POST, default OFF, degradação sem chave/erro/zero hits e aborto', async () => {
  // 1) Default da flag é OFF.
  Deno.env.delete('CHAT_WEB_FALLBACK')
  eq(isWebFallbackEnabled(Deno.env.get('CHAT_WEB_FALLBACK')), false, 'flag ausente é OFF')
  eq(isWebFallbackEnabled('0'), false, '0 é OFF')
  eq(isWebFallbackEnabled('false'), false, 'false é OFF')

  // 2) Verifica formato oficial do POST https://api.tavily.com/search com fetchImpl local (zero rede real).
  let capturedUrl = ''
  let capturedMethod = ''
  let capturedAuth = ''
  let capturedContentType = ''
  let capturedBody: Record<string, unknown> = {}
  const tavilyClient = createFetchWebSearch({
    provider: 'tavily',
    apiKey: 'tvly-mock-test-key',
    fetchImpl: async (url, init) => {
      capturedUrl = String(url)
      capturedMethod = String(init?.method ?? '')
      const headers = new Headers(init?.headers)
      capturedAuth = headers.get('authorization') ?? ''
      capturedContentType = headers.get('content-type') ?? ''
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        query: PERGUNTA_SOROS_BRASIL,
        results: [
          {
            title: 'Open Society no Brasil',
            url: 'https://www.opensocietyfoundations.org/newsroom/brasil',
            content: 'Iniciativas documentadas na América Latina e no Brasil.',
            source: 'Open Society Foundations',
            published_date: '2025-04-10',
          },
          {
            title: 'URL inválida ignorada',
            url: 'javascript:alert(1)',
            content: 'Deve ser descartado.',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const hits = await tavilyClient.search({ query: PERGUNTA_SOROS_BRASIL, maxResults: 3 })
  eq(capturedUrl, 'https://api.tavily.com/search', 'endpoint oficial Tavily')
  eq(capturedMethod, 'POST', 'método POST')
  eq(capturedAuth, 'Bearer tvly-mock-test-key', 'auth Bearer no header')
  assert(capturedContentType.includes('application/json'), 'content-type JSON')
  eq(capturedBody.query, PERGUNTA_SOROS_BRASIL, 'body.query')
  eq(capturedBody.search_depth, 'basic', 'body.search_depth basic (1 crédito)')
  eq(capturedBody.max_results, 3, 'body.max_results')
  eq(capturedBody.include_answer, false, 'body.include_answer false')
  eq(capturedBody.include_raw_content, false, 'body.include_raw_content false')
  eq(hits.length, 1, 'mapeia hit válido e descarta URL inválida')
  eq(hits[0].titulo, 'Open Society no Brasil', 'mapeia title -> titulo')
  eq(hits[0].url, 'https://www.opensocietyfoundations.org/newsroom/brasil', 'mapeia url')
  eq(hits[0].trecho, 'Iniciativas documentadas na América Latina e no Brasil.', 'mapeia content -> trecho')
  eq(hits[0].editor, 'Open Society Foundations', 'mapeia source -> editor')
  eq(hits[0].publicado_em, '2025-04-10', 'mapeia published_date -> publicado_em')

  // 3) Flag ON + mock Tavily no fluxo completo de runChat: preserva base + acrescenta inferencia rotulada.
  const { store: storeOk } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  const resOk = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: storeOk,
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: true,
    webSearch: tavilyClient,
    openrouter: {
      async *stream() {
        yield {
          delta: JSON.stringify({
            blocos: [{
              tipo: 'documentado',
              texto: 'George Soros fundou a Soros Fund Management e a Open Society Foundations.',
              entidades: ['soros', 'george_soros', 'sfm', 'osf'],
              relacoes: ['SOE01', 'SOE02', 'SOE03'],
              fontes: ['SO05', 'SO07'],
            }],
            sem_base: false,
            em_aberto: null,
          }),
        }
        yield { usage: { prompt_tokens: 25, completion_tokens: 25, cost: 0.0002 } }
      },
    },
  })
  const finalOk = finalOf(resOk.events)
  assertFinal(finalOk)
  assert(
    finalOk.blocos.some((b) => b.tipo === 'documentado' && (b.texto.includes('Soros Fund') || b.texto.includes('SFM') || b.texto.includes('Open Society'))),
    'preserva o mais próximo da base',
  )
  const blocoTavily = finalOk.blocos.find((b) => b.tipo === 'inferencia' && b.texto.includes(EXTERNA_NAO_VERIFICADA))
  assert(blocoTavily && blocoTavily.texto.includes('https://www.opensocietyfoundations.org/newsroom/brasil'), 'acrescenta complemento Tavily rotulado')
  assert(finalOk.fontes.includes('ext_1'), 'ext_1 registrado')

  // 4) Flag ON + chave ausente, HTTP 502, e zero resultados: degradação segura sem quebrar o chat nem recusa seca.
  const clientesDegradacao: Array<[string, WebSearchClient]> = [
    ['chave ausente', createFetchWebSearch({ provider: 'tavily', apiKey: '', fetchImpl: async () => { throw new Error('não deveria chamar fetch sem chave') } })],
    ['http 502', createFetchWebSearch({ provider: 'tavily', apiKey: 'tvly-mock', fetchImpl: async () => new Response('bad gateway', { status: 502 }) })],
    ['zero resultados', createFetchWebSearch({ provider: 'tavily', apiKey: 'tvly-mock', fetchImpl: async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) })],
  ]
  for (const [cenario, cliente] of clientesDegradacao) {
    const { store } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
    const { events } = await runChat({
      userId: USER,
      body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
      db: store,
      clock: CLOCK,
      inferenceKey: acceptedKey(),
      repetirCurto: false,
      webFallback: true,
      webSearch: cliente,
      openrouter: {
        async *stream() {
          yield {
            delta: JSON.stringify({
              blocos: [{
                tipo: 'documentado',
                texto: 'George Soros fundou a Soros Fund Management e a Open Society Foundations.',
                entidades: ['soros', 'george_soros', 'sfm', 'osf'],
                relacoes: ['SOE01', 'SOE02', 'SOE03'],
                fontes: ['SO05', 'SO07'],
              }],
              sem_base: false,
              em_aberto: null,
            }),
          }
          yield { usage: { prompt_tokens: 25, completion_tokens: 25, cost: 0.0002 } }
        },
      },
    })
    const finalDeg = finalOf(events)
    assertFinalValido(finalDeg)
    assert(!finalDeg.fontes.some((id) => id.startsWith('ext_')), `${cenario}: sem ext_* inventado`)
    const textoDeg = finalDeg.blocos.map((b) => b.texto).join('\n')
    assert(textoDeg.includes('Soros Fund') || textoDeg.includes('SFM') || textoDeg.includes('Open Society'), `${cenario}: degrada para o mais próximo da base`)
    assert(!/base ainda n[aã]o cobre/i.test(textoDeg), `${cenario}: sem recusa seca`)
  }

  // 5) Flag ON + aborto no meio da busca Tavily: release da reserva, sem commit.
  const controller = new AbortController()
  const tavilyAbort = createFetchWebSearch({
    provider: 'tavily',
    apiKey: 'tvly-mock',
    fetchImpl: async () => {
      controller.abort()
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    },
  })
  const { store: storeAbort } = memoryFrom(FIXTURE_SOROS_FINANCEIRO)
  let commits = 0
  let releases = 0
  const origCommit = storeAbort.commitCredits.bind(storeAbort)
  const origRelease = storeAbort.releaseReserve.bind(storeAbort)
  storeAbort.commitCredits = async (...args) => { commits += 1; return await origCommit(...args) }
  storeAbort.releaseReserve = async (...args) => { releases += 1; return await origRelease(...args) }
  const resAbort = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_SOROS_BRASIL, contexto: { entidades: [] }, modelo: 'basico' },
    db: storeAbort,
    clock: CLOCK,
    signal: controller.signal,
    inferenceKey: acceptedKey(),
    repetirCurto: false,
    webFallback: true,
    webSearch: tavilyAbort,
    openrouter: {
      async *stream() {
        yield {
          delta: JSON.stringify({
            blocos: [{
              tipo: 'documentado',
              texto: 'George Soros fundou a Soros Fund Management e a Open Society Foundations.',
              entidades: ['soros', 'george_soros', 'sfm', 'osf'],
              relacoes: ['SOE01', 'SOE02', 'SOE03'],
              fontes: ['SO05', 'SO07'],
            }],
            sem_base: false,
            em_aberto: null,
          }),
        }
        yield { usage: { prompt_tokens: 25, completion_tokens: 25, cost: 0.0002 } }
      },
    },
  })
  eq(commits, 0, 'aborto na busca Tavily não commita créditos')
  eq(releases, 1, 'aborto na busca Tavily libera reserva')
  const erroAbort = resAbort.events.find((ev) => ev.event === 'error')
  assert(erroAbort && erroAbort.event === 'error' && erroAbort.data.code === 'abortado', 'emite erro abortado')
  assert(!resAbort.events.some((ev) => ev.event === 'final'), 'sem final após aborto')
})

Deno.test('15 regressão P2 (Q14 Odebrecht–Rockefeller): resposta só de ausência com base:[] não vira fora_da_base e aciona resumo/Tavily', async () => {
  const PERGUNTA_Q14 = 'Qual a relação da família Odebrecht com a Fundação Rockefeller?'
  const mapaHotfix: Record<string, ChatContextPayload> = {}
  for (const [k, v] of Object.entries(FIXTURE_HOTFIX1)) {
    if (k !== '_nota' && v && typeof v === 'object') mapaHotfix[k] = v
  }
  const makeStore = () => {
    const store = createMemoryDb({ clock: CLOCK })
    store.chatContext = async (ids, query) => {
      const k = chave(ids, query)
      const hit = mapaHotfix[k]
      return hit ? JSON.parse(JSON.stringify(hit)) as ChatContextPayload : vazio()
    }
    return store
  }

  // A) Flag OFF: modelo devolve apenas um bloco hipotese/inferencia «Odebrecht não está na base do atlas.» com base: [].
  // Não pode cair em recusarSemId / fora_da_base nem desperdiçar retry.
  for (const tipoAusencia of ['hipotese', 'inferencia'] as const) {
    let chamadasModeloOff = 0
    const resOff = await runChat({
      userId: USER,
      body: { mensagem: PERGUNTA_Q14, contexto: { entidades: [] }, modelo: 'basico' },
      db: makeStore(),
      clock: CLOCK,
      inferenceKey: acceptedKey(),
      webFallback: false,
      openrouter: {
        async *stream() {
          chamadasModeloOff += 1
          yield {
            delta: JSON.stringify({
              blocos: [{
                tipo: tipoAusencia,
                texto: 'Odebrecht não está na base do atlas.',
                base: [],
                justificativa: 'A base ainda não cobre este ponto.',
              }],
              sem_base: false,
              em_aberto: null,
            }),
          }
          yield { usage: { prompt_tokens: 20, completion_tokens: 15, cost: 0.0001 } }
        },
      },
    })
    eq(chamadasModeloOff, 1, `Q14 (${tipoAusencia}) flag off não deve entrar em retry de idsInvalidos`)
    assert(!resOff.events.some((e) => e.event === 'error'), `Q14 (${tipoAusencia}) flag off não pode virar fora_da_base: ${resOff.events.map((e) => e.event).join(',')}`)
    const finalOff = finalOf(resOff.events)
    if (tipoAusencia === 'inferencia') assertFinal(finalOff)
    else assertFinalValido(finalOff)
    const docsOff = finalOff.blocos.filter((b) => b.tipo === 'documentado')
    assert(docsOff.length >= 1, `Q14 (${tipoAusencia}) flag off traz bloco documentado mais próximo (Rockefeller)`)
    const textoDocsOff = docsOff.map((b) => b.texto).join('\n')
    assert(/Rockefeller/i.test(textoDocsOff), `Q14 (${tipoAusencia}) flag off documenta Rockefeller: ${textoDocsOff}`)
    const blocoAusenciaOff = finalOff.blocos.find((b) => b.tipo !== 'documentado' && b.texto.includes('Odebrecht não está na base do atlas.'))
    assert(blocoAusenciaOff, `Q14 (${tipoAusencia}) flag off mantém ausência de Odebrecht fora de documentado`)
  }

  // B) Flag ON + mock Tavily (fetchImpl local, zero rede, chave fake só no teste):
  // Primeiro stream é só ausência com base: []; não termina em fora_da_base nem em zero buscas.
  let chamadasModeloOn = 0
  let tavilyCalls = 0
  const tavilyMock = createFetchWebSearch({
    provider: 'tavily',
    apiKey: 'tvly-mock-local-p2-q14',
    fetchImpl: async () => {
      tavilyCalls += 1
      return new Response(JSON.stringify({
        results: [
          {
            title: 'Registros públicos sobre fundações e projetos no Brasil',
            url: 'https://example.org/rockefeller-odebrecht-registros',
            content: 'Documentos públicos de cooperação técnica no Brasil. Fulano cometeu fraude.',
            source: 'Acervo Exemplo',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const resOn = await runChat({
    userId: USER,
    body: { mensagem: PERGUNTA_Q14, contexto: { entidades: [] }, modelo: 'basico' },
    db: makeStore(),
    clock: CLOCK,
    inferenceKey: acceptedKey(),
    webFallback: true,
    webSearch: tavilyMock,
    openrouter: {
      async *stream() {
        chamadasModeloOn += 1
        yield {
          delta: JSON.stringify({
            blocos: [{
              tipo: 'hipotese',
              texto: 'Odebrecht não está na base do atlas.',
              base: [],
              justificativa: 'A base ainda não cobre este ponto.',
            }],
            sem_base: false,
            em_aberto: null,
          }),
        }
        yield { usage: { prompt_tokens: 20, completion_tokens: 15, cost: 0.0001 } }
      },
    },
  })

  eq(chamadasModeloOn, 1, 'Q14 flag on com stream só ausência não entra em retry de idsInvalidos')
  eq(tavilyCalls, 1, 'Q14 flag on chama mock Tavily uma vez (nunca zero buscas)')
  assert(!resOn.events.some((e) => e.event === 'error'), `Q14 flag on não pode virar fora_da_base: ${resOn.events.map((e) => e.event).join(',')}`)
  const finalOn = finalOf(resOn.events)
  assertFinal(finalOn)
  const docsOn = finalOn.blocos.filter((b) => b.tipo === 'documentado')
  assert(docsOn.length >= 1, 'Q14 flag on traz bloco documentado mais próximo (Rockefeller)')
  assert(/Rockefeller/i.test(docsOn.map((b) => b.texto).join('\n')), 'Q14 flag on traz fatos de Rockefeller na base')
  const extBlock = finalOn.blocos.find((b) => b.tipo === 'inferencia' && b.texto.includes(EXTERNA_NAO_VERIFICADA))
  assert(extBlock, 'Q14 flag on incorpora bloco inferencia rotulado como fonte externa não verificada')
  assert(extBlock.texto.includes('https://example.org/rockefeller-odebrecht-registros'), 'cita URL do hit Tavily')
  assert(!/cometeu fraude/i.test(extBlock.texto), 'snippet acusatório filtrado no hit Tavily')
  assert(finalOn.fontes.includes('ext_1'), 'registra ext_1 em fontes')
  eq(finalOn.fontes_detalhe.ext_1.localizador, EXTERNA_NAO_VERIFICADA, 'localizador ext_1 rotulado')
})
