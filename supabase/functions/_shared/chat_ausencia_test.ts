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
  prepareChat,
  runChat,
  sanitizeAnswer,
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
  assertFinal(final)
  const textoTodo = final.blocos.map((b) => b.texto).join('\n')
  assert(!/n[aã]o\s+h[aá]\s+v[ií]nculo/i.test(textoTodo), `afirmou não há vínculo: ${textoTodo}`)
  assert(!/n[aã]o\s+existe\s+rela[cç][aã]o/i.test(textoTodo), `afirmou não existe relação: ${textoTodo}`)
  assert(!/circula(?:m)?\s+sem\s+lastro/i.test(textoTodo), `afirmou circula sem lastro: ${textoTodo}`)
  assert(!/sem\s+lastro/i.test(textoTodo), `afirmou sem lastro: ${textoTodo}`)
  assert(textoTodo.includes('Soros Fund Management') || textoTodo.includes('Open Society'), 'preservou o que a base tem sobre Soros')
  const blocoCobertura = final.blocos.find((b) => /base ainda n[aã]o cobre/i.test(b.texto))
  assert(blocoCobertura, `deve admitir cobertura incompleta: ${textoTodo}`)
  assert(blocoCobertura.tipo !== 'documentado', 'aviso de cobertura incompleta nunca é documentado')
  eq(blocoCobertura.tipo, 'inferencia', 'bloco de cobertura incompleta é inferencia')
})

Deno.test('3 flag web off: nenhum fetch de busca; resposta admite cobertura incompleta e usa o que a base tiver', async () => {
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
  assertFinal(final)
  const docs = final.blocos.filter((b) => b.tipo === 'documentado')
  const infs = final.blocos.filter((b) => b.tipo === 'inferencia')
  assert(docs.length >= 1, 'complementa com o que a base tem em bloco documentado')
  assert(infs.length >= 1, 'inclui bloco não-documentado de cobertura incompleta')
  assert(infs.some((b) => /base ainda n[aã]o cobre/i.test(b.texto)), 'admite cobertura incompleta com clareza')
  const textoTodo = final.blocos.map((b) => b.texto).join('\n')
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
  assertFinal(final)
  assert(!final.fontes.some((id) => id.startsWith('ext_')), 'nenhuma fonte externa inventada na falha')
  const degradado = final.blocos.find((b) => /base ainda n[aã]o cobre/i.test(b.texto) && /busca externa n[aã]o p[oô]de ser conclu[ií]da/i.test(b.texto))
  assert(degradado, `bloco de degradação segura presente: ${final.blocos.map((b) => b.texto).join(' | ')}`)
  assert(degradado.tipo !== 'documentado', 'degradação nunca sai como documentado')
  eq(degradado.tipo, 'inferencia', 'degradação sai como inferencia')
  const textoTodo = final.blocos.map((b) => b.texto).join('\n')
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

Deno.test('10 frases reais do v21 ao vivo são removidas e substituídas por inferencia de cobertura incompleta', async () => {
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
  assertFinal(final)
  const textoTodo = final.blocos.map((b) => b.texto).join('\n')
  const proibidas = [
    /sem qualquer registro de atua[cç][aã]o no brasil/i,
    /nenhum desses movimentos aparece associado ao territ[oó]rio brasileiro/i,
    /hip[oó]tese de uma atua[cç][aã]o direta no brasil n[aã]o se sustenta/i,
    /hip[oó]tese de uma rela[cç][aã]o direta com o pa[ií]s n[aã]o encontra apoio/i,
    /quem procurar um v[ií]nculo brasileiro/i,
    /quem procurou um v[ií]nculo brasileiro/i,
    /sil[eê]ncio dos documentos/i,
  ]
  for (const re of proibidas) {
    assert(!re.test(textoTodo), `frase real do v21 vazou (${re}): ${textoTodo}`)
  }
  assert(textoTodo.includes('Soros Fund') && textoTodo.includes('Open Society'), `preserva frase documentada sobre SFM/OSF: ${textoTodo}`)
  assert(textoTodo.includes('Quantum Fund'), `preserva frase documentada sobre Quantum Fund: ${textoTodo}`)
  const blocoCobertura = final.blocos.find((b) => b.tipo === 'inferencia' && /A base ainda não cobre a relação de .+ com o Brasil/.test(b.texto))
  assert(blocoCobertura, `deve conter bloco inferencia de cobertura incompleta: ${textoTodo}`)
})
