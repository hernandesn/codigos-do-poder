// Rodada 2: relevância antes do corte, pares nomeados, Brasil e texto visível.
// Compatível com `deno test` e com o runner Node (chat_core_node_test.mjs).
import {
  apelidarRecorte,
  assessInferenceKey,
  type ChatContextPayload,
  type ChatDb,
  ocultarIdsVisiveis,
  ordenarRecortePorPergunta,
  prepareChat,
  recuperarContexto,
} from './chat_core.ts'
import { createMemoryDb } from './memory_db.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const CLOCK = () => new Date('2026-11-05T15:00:00-03:00')
const FIXO_831 = 1412
const Q10 = 'Qual foi o papel da casa Rothschild nos empréstimos do Brasil no século XIX?'
const Q12 = 'Quais doações recentes a Fundação Rockefeller fez para organizações brasileiras?'
const Q4 = 'Existe ligação documentada entre o IBEC e o IPES ou o IBAD antes do golpe de 1964?'
const Q3 = 'O que era o IBEC, quem o fundou e quais participações ele teve em empresas brasileiras?'
const Q9 = 'A família Rothschild controla a RIT Capital Partners e a Rothschild & Co?'
const SOROS = 'qual a ligação de Soros e Lula? pq Soros comemorou a vitória de Lula?'
const FIXTURE = JSON.parse(await Deno.readTextFile(
  new URL('../chat/fixtures/ctx_r2.json', import.meta.url),
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

function memoryFrom(map: Record<string, ChatContextPayload>) {
  const calls: string[] = []
  const store = createMemoryDb({ clock: CLOCK })
  store.chatContext = async (ids, query) => {
    calls.push(chave(ids, query))
    const hit = map[chave(ids, query)]
    return hit ? JSON.parse(JSON.stringify(hit)) as ChatContextPayload : vazio()
  }
  return { store, calls }
}

async function preparar(mensagem: string, entidades: string[] = []) {
  const { store, calls } = memoryFrom(FIXTURE)
  const prepared = await prepareChat({
    userId: USER,
    body: { mensagem, contexto: { entidades }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: assessInferenceKey({
      data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false },
    }),
  })
  if (!prepared.ok) throw new Error(`prepare falhou: ${JSON.stringify(prepared.event)}`)
  return { prepared, calls }
}

function sistema(prepared: Awaited<ReturnType<typeof preparar>>['prepared']): string {
  const messages = prepared.requestBody.messages as Array<{ content: string }>
  return messages[0].content
}

function relacoesNoPrompt(prepared: Awaited<ReturnType<typeof preparar>>['prepared']): string[] {
  const texto = sistema(prepared)
  const json = texto.slice(texto.lastIndexOf('\n') + 1)
  const parsed = JSON.parse(json) as { relacoes?: Array<{ id?: string }> }
  return (parsed.relacoes ?? []).map((rel) => {
    const numero = String(rel.id ?? '').replace(/\D/g, '')
    return prepared.apelidos[numero] || String(rel.id ?? '')
  })
}

function exigir(relacoes: string[], ids: string[], rotulo: string) {
  const falta = ids.filter((id) => !relacoes.includes(id))
  assert(falta.length === 0, `${rotulo} sem ${falta.join(', ')}; tem ${relacoes.join(', ')}`)
}

Deno.test('Q10 Rothschild XIX traz AP_E44, AP_E47 e AP_E48 no prompt', async () => {
  const { prepared } = await preparar(Q10)
  exigir(relacoesNoPrompt(prepared), ['AP_E44', 'AP_E47', 'AP_E48'], 'Q10')
  eq(prepared.context.raizes.map((item) => item.id).join(','), 'rothschild', 'raiz rothschild')
})

Deno.test('Q12 doações traz PR3-E025 a PR3-E030 no prompt', async () => {
  const { prepared } = await preparar(Q12)
  exigir(relacoesNoPrompt(prepared), ['PR3-E025', 'PR3-E026', 'PR3-E027', 'PR3-E028', 'PR3-E029', 'PR3-E030'], 'Q12')
})

Deno.test('Q9 traz E001, PR13-E006 e E017 no prompt', async () => {
  const { prepared } = await preparar(Q9)
  exigir(relacoesNoPrompt(prepared), ['E001', 'PR13-E006', 'E017'], 'Q9')
})

Deno.test('Q4 inclui ibad e PR4-E015 no prompt', async () => {
  const { prepared } = await preparar(Q4)
  assert(prepared.context.raizes.some((item) => item.id === 'ibad'), `raízes ${prepared.context.raizes.map((item) => item.id).join(',')}`)
  exigir(relacoesNoPrompt(prepared), ['PR4-E015'], 'Q4')
})

Deno.test('Q3 usa o nome do BIB e pede o nome exato', async () => {
  const { prepared } = await preparar(Q3)
  const prompt = sistema(prepared)
  assert(prompt.includes('Banco de Investimento do Brasil'), 'nome do BIB')
  assert(prompt.includes('copie-o exatamente; não expanda nem traduza siglas.'), 'nomes exatos')
})

Deno.test('Soros/Lula com e sem seleção traz SOE30 a SOE33 e Lula ausente', async () => {
  for (const entidades of [[], ['sfa', 'minas1941']]) {
    const { prepared } = await preparar(SOROS, entidades)
    exigir(relacoesNoPrompt(prepared), ['SOE30', 'SOE31', 'SOE32', 'SOE33'], `Soros ${entidades.join('+') || 'sem seleção'}`)
    eq(JSON.stringify(prepared.ausentes), JSON.stringify(['Lula']), 'Lula ausente')
    assert(sistema(prepared).includes('outro nome no Brasil'), 'instrução de Brasil')
  }
})

Deno.test('saneamento tira apelido, parêntese vazio e não mexe em R$', () => {
  const ctx = vazio()
  const amostras = [
    'O Departamento emitiu a decisão (relação ) e a Embaixada (relações, ).',
    'Relação  indica',
    'fontes ,,, e',
    'Soros (1-5) fundou',
    'justificativa (R18), (R9).',
    'R$ 359.971 em 2021',
  ]
  for (const texto of amostras) {
    const out = ocultarIdsVisiveis(texto, ctx)
    assert(!out.includes('(') && !out.includes(')'), `parêntese em ${JSON.stringify(out)}`)
    assert(!/\[[1-9]\d{0,2}(?:\s*[-–,]\s*[1-9]\d{0,2})?\]/.test(out), `apelido em ${JSON.stringify(out)}`)
    assert(!/\bR\d{1,3}\b/.test(out), `R\\d em ${JSON.stringify(out)}`)
    assert(!out.includes('  ') && !out.includes(',,'), `buraco em ${JSON.stringify(out)}`)
  }
  eq(ocultarIdsVisiveis('R$ 359.971 em 2021', ctx), 'R$ 359.971 em 2021', 'valor intacto')
  eq(ocultarIdsVisiveis('Relação  indica', ctx), 'Relação indica', 'espaço duplo')
  eq(ocultarIdsVisiveis('Soros (1-5) fundou', ctx), 'Soros fundou', 'faixa')
  eq(ocultarIdsVisiveis('justificativa (R18), (R9).', ctx), 'justificativa.', 'erres')
  eq(ocultarIdsVisiveis('fontes ,,, e', ctx), 'fontes, e', 'vírgulas')
  assert(!ocultarIdsVisiveis('O Departamento emitiu a decisão (relação ) e a Embaixada (relações, ).', ctx).includes('relação'), 'relação oca')
})

Deno.test('ordenação sobe a relação que casa e não apaga nada', () => {
  const ctx: ChatContextPayload = {
    raizes: [{ id: 'alfa', nome: 'Alfa' }],
    entidades: [
      { id: 'alfa', nome: 'Alfa' },
      { id: 'beta', nome: 'Beta' },
      { id: 'doacao_br', nome: 'Doação Brasil' },
    ],
    relacoes: [
      { id: 'r1', origem: 'alfa', destino: 'beta', afirmacao: 'Nada a ver com o tema.', periodo: '1990', fontes: ['f1'] },
      { id: 'r2', origem: 'alfa', destino: 'doacao_br', afirmacao: 'Doação para o Brasil.', periodo: '2020', tipo: 'doacao', fontes: ['f2'] },
    ],
    fontes: [{ id: 'f1', titulo: 'Uma' }, { id: 'f2', titulo: 'Duas' }],
  }
  const out = ordenarRecortePorPergunta(ctx, 'Quais doações recentes no Brasil?', ['doacao_br'])
  eq(out.relacoes[0]?.id, 'r2', 'a que casa sobe')
  eq([...out.relacoes.map((rel) => rel.id)].sort().join(','), 'r1,r2', 'relações permanecem')
  eq([...out.entidades.map((item) => item.id)].sort().join(','), 'alfa,beta,doacao_br', 'entidades permanecem')
  eq([...out.fontes.map((item) => item.id)].sort().join(','), 'f1,f2', 'fontes permanecem')
  eq(out.raizes.map((item) => item.id).join(','), 'alfa', 'raízes permanecem')
})

Deno.test('teto de 8 chamadas chatContext na rodada 2', async () => {
  let n = 0
  const db = {
    async chatContext() {
      n += 1
      return vazio()
    },
  } as ChatDb
  const got = await recuperarContexto(db, 'Soros e Lula e a Fundação Rockefeller e o IPES em 1964?', ['sfa', 'minas1941'], false)
  assert(got.chamadas <= 8, `contador ${got.chamadas}`)
  assert(n <= 8, `banco ${n}`)
  eq(n, got.chamadas, 'contador bate com o banco')
  const { calls } = await preparar(Q4)
  assert(calls.length <= 8, `Q4 chamou ${calls.length}: ${calls.join(' || ')}`)
})

Deno.test('tamanho do prompt das 6 perguntas da rodada 2', async () => {
  const antesCtx: Array<[string, string]> = [
    ['Q10', 'rothschild|'],
    ['Q12', '|quais doacoes recentes a rockefeller foundation fez para organizacoes brasileiras?'],
    ['Q4', 'golpe64,ipes,ibec|'],
    ['Q3', '|o que era o ibec, quem o fundou e quais participacoes ele teve em empresas brasileiras?'],
    ['Q9', 'rit,rothschild,rco|'],
    ['Soros', 'soros|'],
  ]
  const perguntas = [Q10, Q12, Q4, Q3, Q9, SOROS]
  for (let i = 0; i < perguntas.length; i++) {
    const [nome, key] = antesCtx[i]
    const antes = FIXO_831 + apelidarRecorte(FIXTURE[key]).json.length
    const { prepared } = await preparar(perguntas[i])
    const depois = sistema(prepared).length
    console.log(`PROMPT ${nome}: antes=${antes} depois=${depois} delta=${depois - antes}`)
  }
})
