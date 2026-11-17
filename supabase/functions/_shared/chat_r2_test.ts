// Rodada 2 do chat: prosa longa acusatória com trava legal, sem strings internas na tela.
import {
  assessInferenceKey,
  BASICO_MODEL_SLUG,
  capBasicWords,
  CHAT_MAX_TOKENS,
  CHAT_MAX_WORDS,
  CHAT_REASONING,
  type ChatBloco,
  type ChatContextPayload,
  type ChatFinal,
  type ChatSseEvent,
  MODEL_SLUGS,
  modelRequestBody,
  prepareChat,
  sanitizeAnswer,
  streamPrepared,
} from './chat_core.ts'
import { createMemoryDb } from './memory_db.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const CLOCK = () => new Date('2026-11-17T12:00:00-04:00')

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}
function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}\n actual=${JSON.stringify(actual)}\n expected=${JSON.stringify(expected)}`)
}
function key() {
  return assessInferenceKey({ data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false } })
}

function itauCtx(): ChatContextPayload {
  return {
    raizes: [
      { id: 'itau_legado', nome: 'Itaú · grupo anterior à associação', tipo: 'instituicao' },
      { id: 'rockefeller', nome: 'Rockefeller · índice familiar', tipo: 'familia' },
    ],
    entidades: [
      { id: 'itau_legado', nome: 'Itaú · grupo anterior à associação', tipo: 'instituicao' },
      { id: 'rockefeller', nome: 'Rockefeller · índice familiar', tipo: 'familia' },
      { id: 'american_coffee', nome: 'American Coffee Company · empresa', tipo: 'empresa' },
      { id: 'casa_ms', nome: 'Casa Bancária Moreira Salles', tipo: 'instituicao' },
    ],
    relacoes: [
      { id: 'E149', origem: 'american_coffee', destino: 'rockefeller', tipo: 'vinculo_institucional', afirmacao: 'Empresa do grupo Rockefeller.', periodo: '1936–1937', estado: 'retrato_documental', fontes: ['B01'] },
      { id: 'E150', origem: 'casa_ms', destino: 'american_coffee', tipo: 'contrato', afirmacao: 'Contrato exclusivo de compra e venda de cafés finos.', periodo: '1936–1937', estado: 'retrato_documental', fontes: ['B01'] },
      { id: 'E166', origem: 'itau_legado', destino: 'casa_ms', tipo: 'associacao_empresarial', afirmacao: 'Associação anunciada em 2008.', periodo: '2008', estado: 'retrato_documental', fontes: ['B07'] },
    ],
    fontes: [
      { id: 'B01', titulo: 'Cronologia IMS', tipo: 'documento' },
      { id: 'B07', titulo: 'Itaú Unibanco 90 anos', tipo: 'documento' },
    ],
  }
}

async function rodar(modelo: 'basico' | 'avancado', saidas: string[], ctx = itauCtx(), mensagem = 'qual a relação dos rockefellers com o itau?') {
  const store = createMemoryDb({ clock: CLOCK })
  store.setPaid(USER, 40)
  store.chatContext = async () => JSON.parse(JSON.stringify(ctx))
  const prepared = await prepareChat({ userId: USER, body: { mensagem, contexto: { entidades: [] }, modelo }, db: store, clock: CLOCK, inferenceKey: key() })
  if (!prepared.ok) throw new Error(`prepare falhou: ${JSON.stringify(prepared.event)}`)
  const emitted: ChatSseEvent[] = []
  let chamadas = 0
  const status = await streamPrepared({
    prepared,
    db: store,
    openrouter: {
      async *stream() {
        const raw = saidas[Math.min(chamadas, saidas.length - 1)]
        chamadas += 1
        yield { delta: raw }
        yield { usage: { prompt_tokens: 11, completion_tokens: raw.length > 20_000 ? CHAT_MAX_TOKENS[modelo] : 700, cost: 0.0002 } }
      },
    },
    signal: new AbortController().signal,
    emit: (event) => emitted.push(event),
  })
  return { status, emitted, chamadas, store, prepared }
}
function finalOf(events: ChatSseEvent[]): ChatFinal {
  const event = events.find((item) => item.event === 'final')
  assert(event && event.event === 'final', `sem final: ${events.map((item) => item.event).join(',')}`)
  return event.data
}
const json = (blocos: unknown[], em_aberto: string | null = 'Quem mais sentou nessa mesa?') => JSON.stringify({ blocos, sem_base: false, em_aberto })

// Tudo o que nunca pode aparecer na tela.
const PROIBIDO: Array<[string, RegExp]> = [
  ['rótulo após « · »', / · /],
  ['recorte', /\brecorte\b/i],
  ['atlas', /\batlas\b/i],
  ['apelido [n]', /\[\d+\]/],
  ['id de relação/fonte', /\b(?:E1[0-9]{2}|B0[0-9])\b/],
  ['slug interno', /\b[a-z]+_[a-z0-9_]+\b/],
  ['estado de registro', /retrato_documental|rascunho|está como/],
  ['rótulo de instrução', /acusação-tese|veredito da tese|A acusação é direta|A pergunta final é|desta tese/],
  ['elo/ponte/seta', /\b(?:elos?|pontes?|seta)\b/],
  ['fallback antigo', /Resposta montada direto da base|Sem cobrança: a ligação pedida|não documenta ligação direta|Resposta básica cortada|Afirmação sobre pessoa sem fonte/],
  ['lugar inventado', /Nova York|Wall Street|Faria Lima/],
  ['superlativo sem base', /o maior banco|o maior ativo|mais poderoso do país/],
  ['ilícito', /crime|corrup|suborn|propina|fraud|lavagem/i],
]
function visivel(final: ChatFinal): string {
  return [...final.blocos.map((b) => b.texto), ...final.avisos.map((a) => a.texto)].join('\n')
}
function semVazamento(final: ChatFinal, onde: string) {
  const texto = visivel(final)
  for (const [nome, re] of PROIBIDO) assert(!re.test(texto), `${onde}: vazou ${nome}: ${texto.match(re)?.[0]}`)
  eq(final.avisos.length, 0, `${onde}: nenhum aviso de sistema na tela`)
}

const SUJO = [
  { tipo: 'documentado', texto: 'Em_aberto: Se o IBEC financiou a campanha de 1916. Em aberto: o contrato segue. Justificativa: o acordo de 1936 permanece. A acusação é direta: tudo indica que o Itaú · grupo anterior à associação e a American Coffee Company · empresa se cruzaram no recorte, elo por elo, pela ponte de 1936 [2] (E150, B01) com estado retrato_documental. O acordo consta na ficha OP16 e no caso OP16_R2, além de BR12_H3, PR1-E4 e AP_E2.', entidades: ['itau_legado', 'american_coffee'], relacoes: ['E150'], fontes: ['B01'] },
  { tipo: 'hipotese', texto: 'A hipótese é que a Casa Bancária Moreira Salles negociou com o grupo Rockefeller, e a ordem veio de Nova York. Era o maior banco do país.', base: ['E150', 'E149'] },
  { tipo: 'inferencia', texto: 'O padrão denuncia que, na hipótese desta tese, o capital atravessou mais de um século, de 1936 a 2008. O veredito da tese é claro.', base: ['brasil_2026'], justificativa: 'Relação E166 está como rascunho.' },
  { tipo: 'documentado', texto: 'O que liga tudo: o contrato de 1936 e a associação de 2008 contam a mesma história de poder. A pergunta final é: quem pagou?', entidades: ['casa_ms', 'itau_legado'], relacoes: ['E150', 'E166'], fontes: ['B01', 'B07'] },
]

Deno.test('R2 vazamento: texto sujo do modelo sai limpo no Básico e no Avançado', async () => {
  for (const modelo of ['basico', 'avancado'] as const) {
    const { emitted } = await rodar(modelo, [json(SUJO, 'Quem, no recorte, sentou com os Rockefeller em [3]?')])
    const final = finalOf(emitted)
    semVazamento(final, modelo)
    const texto = visivel(final)
    assert(texto.includes('Se o IBEC financiou a campanha de 1916.'), `${modelo}: rótulo Em_aberto sai e a frase fica`)
    assert(texto.includes('o contrato segue.'), `${modelo}: rótulo Em aberto sai`)
    assert(texto.includes('o acordo de 1936 permanece.'), `${modelo}: rótulo justificativa sai`)
    assert(!/em[\s_]*aberto\s*:/i.test(texto), `${modelo}: sem rótulo em_aberto`)
    assert(!/\p{L}_\p{L}/u.test(texto), `${modelo}: sem token com underscore entre letras`)
    assert(!/OP\d+/.test(texto), `${modelo}: sem código OP`)
    assert(!/\b(?:na|da) ficha\b/i.test(texto), `${modelo}: sem «na ficha» ou «da ficha»`)
    assert(!/BR\d+_H\d+|PR\d+-(?:E|NF)\d+|AP_E\d+/.test(texto), `${modelo}: sem código de ficha`)
    assert(final.blocos.length >= 3, `${modelo}: prosa preservada (${final.blocos.length} blocos)`)
    assert(final.blocos.every((b) => b.tipo === 'documentado'), `${modelo}: hipótese/inferência viram parágrafo`)
    assert(final.blocos.at(-1)!.texto.includes('\n\nQuem'), `${modelo}: pergunta final em parágrafo próprio`)
    assert(final.blocos.every((b) => b.relacoes.length <= 5 && b.fontes.length <= 5 && b.entidades.length <= 5), `${modelo}: teto de ids por parágrafo`)
    const terceiro = final.blocos.find((b) => b.texto.includes('capital'))
    assert(!terceiro || terceiro.relacoes.length > 0, `${modelo}: base inválida reatribuída pelos nomes`)
  }
})

Deno.test('R2 sem conteúdo vira fora_da_base sem débito', async () => {
  const { emitted, store } = await rodar('basico', [JSON.stringify({ blocos: [], sem_base: true, em_aberto: null })])
  const erro = emitted.find((e) => e.event === 'error')
  eq((erro?.data as { code?: string })?.code, 'fora_da_base', 'fora_da_base')
  eq(store.snapshot(USER, CLOCK()).used, 0, 'sem débito')
  assert(!emitted.some((e) => e.event === 'final'), 'sem final montado da base')
})

Deno.test('R2 saída em laço ou truncada tenta de novo uma vez', async () => {
  const laco = '{"blocos":[{"tipo":"documentado","texto":"Texto","relacoes":[' + Array.from({ length: 4000 }, () => '"[1]"').join(',')
  const bom = json([{ tipo: 'documentado', texto: 'O que liga tudo: tudo indica que o contrato de 1936 aproximou as casas.', relacoes: ['E150'], fontes: ['B01'], entidades: ['casa_ms'] }])
  const { emitted, chamadas } = await rodar('avancado', [laco, bom])
  eq(chamadas, 2, 'uma nova tentativa')
  semVazamento(finalOf(emitted), 'retry')
})

Deno.test('R2 corte do Básico preserva tese e veredito, nunca parte frase', () => {
  const p = (n: number, t: string) => ({ tipo: 'documentado', texto: `${t} ${'palavra '.repeat(n).trim()}.`, entidades: [], relacoes: ['r'], fontes: [] }) as ChatBloco
  const blocos = [p(200, 'Tese.'), p(300, 'Meio1.'), p(300, 'Meio2.'), p(300, 'Meio3.'), p(150, 'O que liga tudo:')]
  const { blocos: out, trimmed } = capBasicWords(blocos, CHAT_MAX_WORDS.basico)
  assert(trimmed, 'cortou')
  assert(out[0].texto.startsWith('Tese.') && out.at(-1)!.texto.startsWith('O que liga tudo:'), 'primeiro e último preservados')
  assert(out.every((b) => b.texto.endsWith('.')), 'nenhum parágrafo partido')
  assert(out.reduce((n, b) => n + b.texto.split(/\s+/).length, 0) <= CHAT_MAX_WORDS.basico, 'dentro do teto')
})

Deno.test('R2 filtros de fato de fora: superlativo, século, hoje, lugar', () => {
  const ctx = itauCtx()
  const t = (texto: string) => sanitizeAnswer({ blocos: [{ tipo: 'documentado', texto, entidades: ['casa_ms'], relacoes: ['E150'], fontes: ['B01'] }] }, ctx).answer.blocos[0]?.texto ?? ''
  eq(t('O contrato é de 1936. Criou o maior ativo do grupo. Fim.'), 'O contrato é de 1936. Fim.', 'superlativo sem base')
  eq(t('Durou mais de um século, de 1936 a 2018. Fim.'), 'Fim.', 'século sem os anos')
  eq(t('Durou nove décadas, de 1936 a 2026. Fim.'), 'Durou nove décadas, de 1936 a 2026. Fim.', 'década com os anos certos')
  eq(t('Quem mais reaparece nos balanços de hoje?'), 'Quem mais reaparece nos balanços?', 'pergunta perde só o «de hoje»')
  eq(t('A ponte decade de 1930 havão colocado e é member da firma.'), 'A ligação década de 1930 haviam colocado e é membro da firma.', 'deslizes de idioma')
  eq(t('Os dois seguem nos conselhos de hoje. A lista de 2026 o mantém até hoje. Fim.'), 'A lista de 2026 o mantém até hoje. Fim.', 'hoje só com data atual')
  eq(t('O vínculo remonta a 1936 e a origem remonta à década de 1930.'), 'O vínculo começa em 1936 e a origem começa na década de 1930.', 'sem «remonta»')
  eq(t('A ordem veio de Wall Street. A Rockefeller & Co. operou em 2012. Fim.'), 'A Rockefeller & Co. operou em 2012. Fim.', 'lugar de fora e abreviação intacta')
})

Deno.test('R2 modelo do Básico numa constante e raciocínio por modelo', () => {
  eq(MODEL_SLUGS.basico, BASICO_MODEL_SLUG, 'Básico lê a constante')
  eq(BASICO_MODEL_SLUG, 'deepseek/deepseek-v4.1-flash-1017', 'Básico atual')
  eq(MODEL_SLUGS.avancado, 'z-ai/glm-5.3', 'Avançado')
  const av = modelRequestBody('avancado', 's', 'm')
  eq(JSON.stringify(av.reasoning), JSON.stringify({ effort: 'minimal', exclude: true }), 'GLM exige raciocínio')
  eq(JSON.stringify(modelRequestBody('basico', 's', 'm').reasoning), JSON.stringify(CHAT_REASONING.basico), 'Básico sem raciocínio')
  eq(av.max_tokens, 6000, 'teto do Avançado')
})
