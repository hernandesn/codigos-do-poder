import { assessInferenceKey, boundContextJson, buildSystemPrompt, type ChatContextPayload, type ChatFinal, type ChatSseEvent, prepareChat, RESPOSTA_JSON_SCHEMA, sanitizeAnswer, streamPrepared } from './chat_core.ts'
import { idKind, normalizeCitations } from './citation_ids.ts'
import { lacunasEntreRaizes } from './lacunas.ts'
import { createMemoryDb } from './memory_db.ts'

const NOME = 'Walther Moreira Salles \u00B7 banqueiro'
const MARCADOR = 'sem ligação direta documentada'
const USER = '11111111-1111-4111-8111-111111111111'
const CLOCK = () => new Date('2026-11-05T15:00:00-03:00')

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n actual=${JSON.stringify(actual)}\n expected=${JSON.stringify(expected)}`)
  }
}

function atlas(): ChatContextPayload {
  return {
    raizes: [
      { id: 'walther_ms', nome: NOME, tipo: 'pessoa' },
      { id: 'golpe64', nome: 'Golpe de 1964', tipo: 'evento' },
    ],
    entidades: [
      { id: 'walther_ms', nome: NOME, tipo: 'pessoa' },
      { id: 'golpe64', nome: 'Golpe de 1964', tipo: 'evento' },
      { id: 'ipes', nome: 'IPES', tipo: 'instituicao' },
    ],
    relacoes: [
      { id: 'E219', origem: 'ipes', destino: 'golpe64' },
      { id: 'E154', origem: 'walther_ms', destino: 'ipes' },
      { id: 'PR4-E017', origem: 'ipes', destino: 'walther_ms' },
      { id: 'AP_E41', origem: 'ipes', destino: 'golpe64' },
      { id: 'heitor_primeira', origem: 'walther_ms', destino: 'ipes' },
    ],
    fontes: [
      { id: 'PR1-NF22', titulo: 'Nota' },
      { id: 'B10', titulo: 'Boletim' },
      { id: 'PR12-P12-F23', titulo: 'Página' },
    ],
    casos: [{ id: 'OP35', titulo: 'Caso' }],
  }
}

function bloco(over: Record<string, unknown> = {}) {
  return {
    tipo: 'documentado',
    texto: 'O recorte cita o golpe.',
    entidades: [],
    relacoes: [],
    fontes: [],
    ...over,
  }
}

function idsOf(raw: unknown, field: 'entidades' | 'relacoes' | 'fontes') {
  const record = raw as { blocos: Array<Record<string, unknown>> }
  return record.blocos[0][field]
}

Deno.test('normaliza prefixo, json, rótulo e nome exato sem inventar id', () => {
  const ctx = atlas()
  const prefix = normalizeCitations({
    blocos: [bloco({
      entidades: ['id:golpe64', '[id:ipes]', 'id:B10'],
      relacoes: ['id:E219', 'id:AP_E41', 'id:PR12-P12-F23'],
      fontes: [],
    })],
  }, ctx)
  eq(JSON.stringify(idsOf(prefix.raw, 'entidades')), JSON.stringify(['golpe64', 'ipes']), 'prefixo de entidade')
  eq(JSON.stringify(idsOf(prefix.raw, 'relacoes')), JSON.stringify(['E219', 'AP_E41']), 'prefixo de relação')
  eq(JSON.stringify(idsOf(prefix.raw, 'fontes')), JSON.stringify(['B10', 'PR12-P12-F23']), 'fonte sai do campo errado')
  eq(prefix.stats.prefixo, 6, 'um prefixo por token reparado')
  eq(prefix.stats.campo, 2, 'B10 e PR12-P12-F23 mudam de campo')
  eq(prefix.stats.json, 0, 'prefixo não conta como json')
  eq(prefix.stats.rotulo, 0, 'id puro não é rótulo')
  eq(prefix.stats.nome_exato, 0, 'id puro não é nome')

  const json = normalizeCitations({
    blocos: [bloco({
      entidades: ['id":"walther_ms"', 'id": "E154"', 'id": ', '{"id":"ipes"}'],
    })],
  }, ctx)
  eq(JSON.stringify(idsOf(json.raw, 'entidades')), JSON.stringify(['walther_ms', 'id": ', 'ipes']), 'json vazio permanece no lugar')
  eq(JSON.stringify(idsOf(json.raw, 'relacoes')), JSON.stringify(['E154']), 'E154 é relação')
  eq(json.stats.json, 3, 'três json com id')
  eq(json.stats.campo, 1, 'E154 deixa entidades')

  const rotulo = normalizeCitations({
    blocos: [bloco({
      entidades: [
        `walther_ms \u00B7 Walther Moreira Salles`,
        'Walther Moreira Salles (walther_ms)',
        'Golpe de 1964: golpe64',
        'golpe64 \u2014 evento',
      ],
    })],
  }, ctx)
  eq(JSON.stringify(idsOf(rotulo.raw, 'entidades')), JSON.stringify(['walther_ms', 'golpe64']), 'rótulo deduplica')
  eq(rotulo.stats.rotulo, 4, 'quatro rótulos')
  eq(rotulo.stats.nome_exato, 0, 'pedaço de rótulo não é nome exato')

  const nome = normalizeCitations({
    blocos: [bloco({ entidades: [NOME, 'Walther Moreira Salles  \u00B7 banqueiro'] })],
  }, ctx)
  eq(JSON.stringify(idsOf(nome.raw, 'entidades')), JSON.stringify(['walther_ms']), 'nome inteiro, espaços extras colapsados')
  eq(nome.stats.nome_exato, 2, 'dois nomes exatos')

  const ambiguous = normalizeCitations({
    blocos: [bloco({ entidades: ['E219 \u00B7 PR1-NF22', 'Walther Moreira'] })],
  }, ctx)
  eq(JSON.stringify(idsOf(ambiguous.raw, 'entidades')), JSON.stringify(['E219 \u00B7 PR1-NF22', 'Walther Moreira']), 'ambíguo e parcial ficam crus')
  eq(ambiguous.stats.rotulo + ambiguous.stats.nome_exato + ambiguous.stats.prefixo + ambiguous.stats.json + ambiguous.stats.campo, 0, 'sem correção')

  const shared = normalizeCitations({
    blocos: [bloco({ entidades: ['Mesmo Nome'] })],
  }, {
    raizes: [],
    entidades: [{ id: 'a_um', nome: 'Mesmo Nome' }, { id: 'b_dois', nome: 'Mesmo Nome' }],
    relacoes: [],
    fontes: [],
  })
  eq(JSON.stringify(idsOf(shared.raw, 'entidades')), JSON.stringify(['Mesmo Nome']), 'nome repetido não mapeia')
})

Deno.test('campo errado vai para o conjunto do recorte e o prefixo não veta', () => {
  const ctx = atlas()
  const moved = normalizeCitations({
    blocos: [bloco({
      entidades: ['ipes', 'E219', 'PR1-NF22'],
      relacoes: ['E154', 'golpe64'],
      fontes: ['B10', 'heitor_primeira'],
    })],
  }, ctx)
  eq(JSON.stringify(idsOf(moved.raw, 'entidades')), JSON.stringify(['ipes', 'golpe64']), 'entidade volta de relacoes')
  eq(JSON.stringify(idsOf(moved.raw, 'relacoes')), JSON.stringify(['E154', 'E219', 'heitor_primeira']), 'relação sai de entidades e de fontes')
  eq(JSON.stringify(idsOf(moved.raw, 'fontes')), JSON.stringify(['B10', 'PR1-NF22']), 'fonte sai de entidades')
  eq(moved.stats.campo, 4, 'quatro mudanças de campo')
  eq(idKind('heitor_primeira'), 'entidade', 'prefixo leria entidade')
  assert(ctx.relacoes.some((rel) => rel.id === 'heitor_primeira'), 'no recorte é relação')

  const top = normalizeCitations({
    entidades: ['PR1-NF22', 'id:ipes', 'E219'],
    fontes: ['walther_ms', { id: 'B10' }],
  }, ctx)
  const record = top.raw as { entidades: unknown[]; fontes: unknown[] }
  eq(JSON.stringify(record.entidades), JSON.stringify(['ipes', 'E219', 'walther_ms']), 'relação de topo não tem destino')
  eq(JSON.stringify(record.fontes), JSON.stringify([{ id: 'B10' }, 'PR1-NF22']), 'objeto de fonte preservado e a movida entra depois')
  eq(top.stats.prefixo, 1, 'id:ipes')
  eq(top.stats.campo, 2, 'fonte e entidade trocam de lista')

  const infer = normalizeCitations({
    blocos: [{
      tipo: 'inferencia',
      texto: 'leitura',
      base: ['id:B10', 'golpe64', 'E219'],
      justificativa: 'não mexer id:E219',
    }],
  }, ctx)
  const row = (infer.raw as { blocos: Array<Record<string, unknown>> }).blocos[0]
  eq(JSON.stringify(row.base), JSON.stringify(['golpe64', 'E219']), 'fonte sai de base')
  eq(JSON.stringify((infer.raw as { fontes?: unknown }).fontes), JSON.stringify(['B10']), 'fonte da base sobe para o topo')
  eq(row.justificativa, 'não mexer id:E219', 'justificativa intacta')
  eq(infer.stats.prefixo, 1, 'prefixo na base')
  eq(infer.stats.campo, 1, 'fonte em inferência conta como campo')
  const sanitized = sanitizeAnswer(infer.raw, ctx)
  assert(!sanitized.removed, 'fonte do recorte não é mais removida')
  const base = sanitized.answer.blocos[0]
  // R2 (prosa corrida): inferência vira parágrafo com as relações-base e suas fontes.
  assert(base.tipo === 'documentado', 'inferência vira parágrafo')
  eq(JSON.stringify(base.relacoes), JSON.stringify(['E219']), 'relação da base vira citação')
  eq(JSON.stringify(sanitized.answer.fontes), JSON.stringify(['B10']), 'fonte da base vira fonte citada no topo')

  const caso = normalizeCitations({
    blocos: [bloco({ relacoes: ['OP35'], texto: 'caso' })],
  }, ctx)
  eq(JSON.stringify(idsOf(caso.raw, 'entidades')), JSON.stringify(['OP35']), 'caso vai para entidades')
  eq(JSON.stringify(idsOf(caso.raw, 'relacoes')), JSON.stringify([]), 'caso sai de relacoes')
  const casoOut = sanitizeAnswer(caso.raw, ctx)
  assert(casoOut.removed, 'sanitize não passa a aceitar caso')
  eq(casoOut.answer.blocos[0].tipo === 'documentado' ? casoOut.answer.blocos[0].entidades.length : -1, 0, 'OP35 não está em raízes nem entidades')
})

Deno.test('F1b: correção de campo determinística só com ids do recorte', () => {
  const ctx = atlas()
  // move conexão, fonte e nó; não duplica
  const out = normalizeCitations({
    blocos: [bloco({
      entidades: ['E219', 'ipes', 'B10'],
      relacoes: ['golpe64', 'E219'],
      fontes: ['E154', 'PR1-NF22', 'walther_ms', 'B10'],
    })],
  }, ctx)
  eq(JSON.stringify(idsOf(out.raw, 'entidades')), JSON.stringify(['ipes', 'golpe64', 'walther_ms']), 'nó volta para entidades')
  eq(JSON.stringify(idsOf(out.raw, 'relacoes')), JSON.stringify(['E219', 'E154']), 'conexão vai para relacoes sem duplicar E219')
  eq(JSON.stringify(idsOf(out.raw, 'fontes')), JSON.stringify(['PR1-NF22', 'B10']), 'fonte vai para fontes sem duplicar B10')
  const clean = sanitizeAnswer(out.raw, ctx)
  assert(!clean.removed, 'nada removido quando todo id é do recorte')

  // id fora do recorte não é movido nem criado, mesmo com formato de relação/fonte
  const fora = normalizeCitations({
    blocos: [bloco({ entidades: ['E9999', 'B99'], relacoes: ['ipes_x'], fontes: ['E2190'] })],
  }, ctx)
  eq(JSON.stringify(idsOf(fora.raw, 'entidades')), JSON.stringify(['E9999', 'B99']), 'E9999/B99 ficam onde estão')
  eq(JSON.stringify(idsOf(fora.raw, 'relacoes')), JSON.stringify(['ipes_x']), 'nada criado em relacoes')
  eq(JSON.stringify(idsOf(fora.raw, 'fontes')), JSON.stringify(['E2190']), 'sem similaridade com E219')
  eq(fora.stats.campo, 0, 'nenhuma mudança de campo')
  const foraOut = sanitizeAnswer(fora.raw, ctx)
  assert(foraOut.removed, 'id fora do recorte continua removido')
  const doc = foraOut.answer.blocos[0]
  assert(doc.tipo === 'documentado' && doc.entidades.length + doc.relacoes.length + doc.fontes.length === 0, 'nenhum id sobrevive')

  // id ambíguo (relação e fonte no mesmo recorte) fica onde o modelo pôs
  const amb = atlas()
  amb.fontes = [...amb.fontes, { id: 'E154', titulo: 'homônimo' }]
  const ambOut = normalizeCitations({ blocos: [bloco({ entidades: ['E154'], fontes: ['E154'] })] }, amb)
  eq(JSON.stringify(idsOf(ambOut.raw, 'entidades')), JSON.stringify(['E154']), 'ambíguo não sai de entidades')
  eq(JSON.stringify(idsOf(ambOut.raw, 'fontes')), JSON.stringify(['E154']), 'ambíguo fica em fontes')
  eq(ambOut.stats.campo, 0, 'ambíguo não conta mudança')

  // fonte em inferência sobe para o topo sem duplicar a que já está lá
  const inf = normalizeCitations({
    blocos: [{ tipo: 'inferencia', texto: 'leitura', base: ['PR1-NF22', 'E219', 'B99'], justificativa: 'j' }],
    fontes: ['PR1-NF22'],
  }, ctx)
  const infRow = (inf.raw as { blocos: Array<Record<string, unknown>> }).blocos[0]
  eq(JSON.stringify(infRow.base), JSON.stringify(['E219', 'B99']), 'B99 (fora) não sobe nem some aqui')
  eq(JSON.stringify((inf.raw as { fontes: unknown[] }).fontes), JSON.stringify(['PR1-NF22']), 'sem duplicar no topo')
  const infOut = sanitizeAnswer(inf.raw, ctx)
  assert(infOut.removed, 'B99 continua removido pelo sanitize')
  const ib = infOut.answer.blocos[0]
  eq(ib.tipo === 'documentado' ? JSON.stringify(ib.relacoes) : '', JSON.stringify(['E219']), 'R2: só a relação do recorte vira citação')
})

Deno.test('id inventado ou parcial continua removido', () => {
  const ctx = atlas()
  const original = {
    blocos: [bloco({
      texto: 'texto intacto id:golpe64',
      entidades: ['walther_m', 'E9999', 'id:E9999', 'WALTHER_MS', 'Walther Moreira'],
    })],
    sem_base: false,
  }
  const snapshot = JSON.stringify(original)
  const ctxSnapshot = JSON.stringify(ctx)
  const norm = normalizeCitations(original, ctx)
  eq(JSON.stringify(original), snapshot, 'não muta o JSON do modelo')
  eq(JSON.stringify(ctx), ctxSnapshot, 'não muta o recorte')
  eq((norm.raw as { blocos: Array<{ texto: string }> }).blocos[0].texto, 'texto intacto id:golpe64', 'texto intocado')
  eq(JSON.stringify(idsOf(norm.raw, 'entidades')), JSON.stringify(['walther_m', 'E9999', 'id:E9999', 'WALTHER_MS', 'Walther Moreira']), 'strings originais')
  eq(norm.stats.prefixo + norm.stats.json + norm.stats.rotulo + norm.stats.nome_exato + norm.stats.campo, 0, 'id ausente não é correção')
  const { answer, removed } = sanitizeAnswer(norm.raw, ctx)
  assert(removed, 'removed')
  assert(answer.avisos.some((aviso) => aviso.tipo === 'citacao_removida'), 'aviso citacao_removida')
  const doc = answer.blocos[0]
  assert(doc.tipo === 'documentado', 'bloco permanece')
  eq(JSON.stringify(doc.entidades), JSON.stringify([]), 'nenhum id inventado sobrevive')
  eq(doc.texto, 'Texto intacto id:Golpe de 1964', 'golpe64 tem dígito e vira o nome; citação inventada não vira id')
})

Deno.test('idKind classifica os padrões reais e nada além deles', () => {
  const relacoes = [
    'E219', 'PR3-E056', 'PR12a-E004', 'F12_C3', 'OP13_R01', 'ROM12', 'AP_E41', 'SOE3', 'ORI4', 'IN2', 'PAP1',
    'BR1_B2', 'BR1_C2', 'BR1_BG1', 'BR1_G1', 'BR1_H1',
    'LIN_R_B1', 'LIN_K_F1', 'LIN_R_P1', 'LIN_K_M1', 'LIN_K_SPOUSE1', 'LIN_R_I1',
  ]
  const fontes = ['PR1-NF22', 'PR1a-NF3', 'S02', 'R12', 'AP10', 'B10', 'I20', 'SO3', 'FEC4', 'PR12-P12-F23', 'BP3']
  for (const id of relacoes) eq(idKind(id), 'relacao', id)
  for (const id of fontes) eq(idKind(id), 'fonte', id)
  for (const id of ['walther_ms', 'golpe64', 'ipes', 'grupo_C12']) eq(idKind(id), 'entidade', id)
  for (const id of ['OP01', 'OP49', 'OP13']) eq(idKind(id), 'caso', id)
  eq(idKind('AP_E41'), 'relacao', 'AP_E não é fonte AP')
  eq(idKind('AP10'), 'fonte', 'AP+dígitos é fonte')
  eq(idKind('SOE3'), 'relacao', 'SOE é relação')
  eq(idKind('SO3'), 'fonte', 'SO é fonte')
  eq(idKind('OP13_R01'), 'relacao', 'OP_R não é caso')
  eq(idKind('WALTHER_MS'), null, 'caixa diferente')
  eq(idKind('id:golpe64'), null, 'prefixo não é id')
  eq(idKind(''), null, 'vazio')
  eq(idKind('OP00'), null, 'fora de OP01–OP49')
  eq(idKind('OP50'), null, 'fora de OP01–OP49')
  eq(idKind('E9999'), 'relacao', 'formato, não existência')
})

Deno.test('lacunas entre raízes só onde não há aresta direta', () => {
  const marcador = MARCADOR
  eq(lacunasEntreRaizes({ raizes: [], entidades: [], relacoes: [], fontes: [] }).length, 0, 'zero raízes')
  eq(lacunasEntreRaizes({
    raizes: [{ id: 'golpe64' }], entidades: [], relacoes: [], fontes: [],
  }).length, 0, 'uma raiz')

  const tres = lacunasEntreRaizes({
    raizes: [{ id: 'golpe64' }, { id: 'ipes' }, { id: 'jacob_r' }],
    entidades: [],
    relacoes: [{ id: 'E219', origem: 'ipes', destino: 'golpe64' }],
    fontes: [],
  })
  eq(JSON.stringify(tres), JSON.stringify([
    { de: 'golpe64', para: 'jacob_r', marcador },
    { de: 'ipes', para: 'jacob_r', marcador },
  ]), 'ligação só entre duas das três')

  eq(lacunasEntreRaizes({
    raizes: [{ id: 'golpe64' }, { id: 'ipes' }],
    entidades: [],
    relacoes: [{ id: 'E219', origem: 'ipes', destino: 'golpe64' }],
    fontes: [],
    ligacoes_entre_raizes: [{ de: 'golpe64', para: 'ipes', via: 'meio', relacoes: ['E219'] }],
  }).length, 0, 'relação direta em qualquer direção elimina a lacuna')

  eq(lacunasEntreRaizes({
    raizes: [{ id: 'golpe64' }, { id: 'ipes' }],
    entidades: [],
    relacoes: [],
    fontes: [],
    ligacoes_entre_raizes: [{ de: 'ipes', para: 'golpe64', via: null, relacoes: ['E219'] }],
  }).length, 0, 'via null é ligação direta')

  const via = lacunasEntreRaizes({
    raizes: [{ id: 'egydio_aranha' }, { id: 'itau_unibanco' }],
    entidades: [],
    relacoes: [{ id: 'E1', origem: 'itau_unibanco', destino: 'oswaldo_aranha' }],
    fontes: [],
    ligacoes_entre_raizes: [
      { de: 'itau_unibanco', para: 'egydio_aranha', via: 'oswaldo_aranha', relacoes: ['E1'] },
      { de: 'egydio_aranha', para: 'itau_unibanco', via: 'ipes', relacoes: ['E2'] },
      { de: 'itau_unibanco', para: 'egydio_aranha', via: 'oswaldo_aranha', relacoes: ['E3'] },
    ],
  })
  eq(JSON.stringify(via), JSON.stringify([{
    de: 'egydio_aranha', para: 'itau_unibanco', marcador, via: ['oswaldo_aranha', 'ipes'],
  }]), 'intermediários em ordem, sem duplicar')

  const ordem = lacunasEntreRaizes({
    raizes: [{ id: 'z_root' }, { id: 'a_root' }],
    entidades: [], relacoes: [], fontes: [],
  })
  eq(ordem[0].de, 'z_root', 'ordem do recorte, não alfabética')
  eq(ordem[0].para, 'a_root', 'par estável')

  eq(lacunasEntreRaizes({
    raizes: [{ id: 'a' }, { id: 'a' }],
    entidades: [], relacoes: [], fontes: [],
  }).length, 0, 'a raiz consigo mesma não é par')
})

Deno.test('lacunas_entre_raizes sobrevive ao boundContextJson, inclusive no último recurso', () => {
  const vazio = JSON.parse(boundContextJson({
    raizes: [{ id: 'golpe64', nome: 'Golpe' }],
    entidades: [], relacoes: [], fontes: [],
    lacunas_entre_raizes: [{ de: 'golpe64', para: 'ipes', marcador: MARCADOR }],
  }))
  assert(!('lacunas_entre_raizes' in vazio), 'não envia lacuna com menos de duas raízes')

  const meio = boundContextJson({
    raizes: [{ id: 'golpe64', nome: 'Golpe' }, { id: 'jacob_r', nome: 'Jacob' }],
    entidades: [{ id: 'golpe64', nota: 'n'.repeat(18000) }],
    relacoes: [], fontes: [],
  })
  assert(meio.length <= 16000, 'degrau intermediário cabe')
  const meioParsed = JSON.parse(meio)
  eq(meioParsed.lacunas_entre_raizes.length, 1, 'lacuna no degrau que encolhe nota')
  eq(meioParsed.lacunas_entre_raizes[0].de, 'golpe64', 'par preservado')
  assert(typeof meioParsed.entidades[0].nota === 'string', 'ainda não é o último recurso')
  assert(!meio.includes('n'.repeat(500)), 'a nota foi encurtada')

  const enorme = boundContextJson({
    raizes: [
      { id: 'golpe64', nome: 'Golpe de 1964' },
      { id: 'ipes', nome: 'IPES' },
      { id: 'jacob_r', nome: 'Jacob' },
    ],
    entidades: [{ id: 'meio', nome: 'Meio' }],
    relacoes: [{ id: 'E219', origem: 'golpe64', destino: 'ipes', extra: 'Z'.repeat(20000) } as ChatContextPayload['relacoes'][number]],
    fontes: [],
    ligacoes_entre_raizes: [{ de: 'golpe64', para: 'ipes', via: null, relacoes: ['E219'] }],
  })
  const parsed = JSON.parse(enorme)
  assert(!enorme.includes('Z'.repeat(100)), 'último recurso descarta o campo extra')
  assert(!('extra' in parsed.relacoes[0]), 'relação reduzida a id, origem, destino e fontes')
  eq(parsed.lacunas_entre_raizes.length, 2, 'duas lacunas no último recurso')
  eq(JSON.stringify(parsed.lacunas_entre_raizes.map((item: { de: string; para: string }) => [item.de, item.para])),
    JSON.stringify([['golpe64', 'jacob_r'], ['ipes', 'jacob_r']]), 'o par com via null não entra')
  eq(JSON.stringify(parsed.ligacoes_entre_raizes), JSON.stringify([
    { de: 'golpe64', para: 'ipes', via: null, relacoes: ['E219'] },
  ]), 'caminhos continuam no último recurso')
})

Deno.test('prompt pede id puro e a frase de lacuna sem crescer mais de 15%', () => {
  const vazio: ChatContextPayload = { raizes: [], entidades: [], relacoes: [], fontes: [] }
  // Prompt fixo sem o JSON. v12 media 1373/1341; as duas linhas de apelido sobem para 1412/1380.
  // R2: o prompt longo de tom acusatório + trava legal mede 5810/5811; o teto de 15% passa a valer sobre isso.
  const base = { basico: 5810, avancado: 5811 }
  for (const modelo of ['basico', 'avancado'] as const) {
    const prompt = buildSystemPrompt(modelo, vazio)
    const json = boundContextJson(vazio)
    assert(prompt.endsWith(json), 'o recorte fecha o prompt')
    const fixo = prompt.length - json.length
    const teto = Math.floor(base[modelo] * 1.15)
    console.log(`prompt fixo ${modelo}: ${base[modelo]} -> ${fixo} (${((fixo / base[modelo] - 1) * 100).toFixed(1)}%, teto ${teto})`)
    assert(fixo <= teto, `${modelo} cresceu além de 15%`)
    assert(prompt.includes('id puro'), 'regra de id puro')
    assert(prompt.includes('"walther_ms"') && prompt.includes('"E219"') && prompt.includes('"PR1-NF22"'), 'exemplos de id')
    assert(prompt.includes('sem id:, nome, rótulo ou aspas'), 'sem prefixo, nome ou aspas')
    assert(prompt.includes('Relação em relacoes, fonte em fontes, entidade em entidades'), 'campo certo')
    assert(prompt.includes('Texto livre só em texto/justificativa'), 'texto livre isolado')
    // R2: a frase canônica de lacuna saiu do prompt fora da pauta.
    assert(!prompt.includes("O atlas não documenta ligação direta entre <nome de> e <nome para>."), 'sem frase de lacuna')
    assert(prompt.includes('só quando o recorte não sustenta nenhum dos temas'), 'sem_base preservado')
    assert(prompt.includes('sem_base true só com blocos vazios'), 'F1c(b): sem_base só com blocos vazios')
    // R2: em_aberto é a pergunta final provocativa; sem frase de lacuna; caminho indireto continua não sendo direto.
    assert(prompt.includes('em_aberto: uma pergunta final provocativa'), 'F1c(b): em_aberto no prompt')
    assert(/caminho por intermediário|intermediário não é ligação direta/i.test(prompt), 'indireto não é direto')
  }
  assert(!JSON.stringify(RESPOSTA_JSON_SCHEMA).includes('pattern'), 'schema sem pattern')
  eq(JSON.stringify(RESPOSTA_JSON_SCHEMA.properties.em_aberto.type), '["string","null"]', 'em_aberto opcional no strict')
  assert((RESPOSTA_JSON_SCHEMA.required as readonly string[]).includes('em_aberto'), 'strict lista toda chave')
})

Deno.test('streamPrepared normaliza antes do sanitize e manda lacunas ao modelo', async () => {
  const context: ChatContextPayload = {
    raizes: [
      { id: 'golpe64', nome: 'Golpe de 1964', tipo: 'evento' },
      { id: 'jacob_r', nome: 'Jacob', tipo: 'pessoa' },
    ],
    entidades: [
      { id: 'golpe64', nome: 'Golpe de 1964', tipo: 'evento' },
      { id: 'ipes', nome: 'IPES', tipo: 'instituicao' },
    ],
    relacoes: [{ id: 'E219', origem: 'ipes', destino: 'golpe64', fontes: ['B10'] }],
    fontes: [{ id: 'B10', titulo: 'Boletim' }],
  }
  const store = createMemoryDb({ clock: CLOCK })
  store.chatContext = async () => context
  const prepared = await prepareChat({
    userId: USER,
    body: { mensagem: 'O que liga o golpe a Jacob?', contexto: { entidades: ['golpe64'] }, modelo: 'basico' },
    db: store,
    clock: CLOCK,
    inferenceKey: assessInferenceKey({
      data: { limit: 3, limit_reset: 'daily', limit_remaining: 2.5, include_byok_in_limit: false },
    }),
  })
  assert(prepared.ok, 'preparado')
  const system = (prepared.requestBody.messages as Array<{ content: string }>)[0].content
  // R2: fora da pauta o recorte não leva lacunas_entre_raizes (a resposta não fala de lacuna).
  assert(!system.includes('lacunas_entre_raizes'), 'o recorte enviado não traz a lacuna')
  assert(system.includes('id puro'), 'regra no pedido real')

  const calls: Record<string, unknown>[] = []
  const raw = JSON.stringify({
    sem_base: false,
    entidades: ['id:ipes'],
    fontes: [],
    blocos: [{
      tipo: 'documentado',
      texto: 'O recorte cita o golpe.',
      entidades: ['id:golpe64', 'E219', 'id:B10', 'walther_m'],
      relacoes: [],
      fontes: [],
    }],
  })
  const emitted: ChatSseEvent[] = []
  const status = await streamPrepared({
    prepared,
    db: store,
    openrouter: {
      async *stream(input) {
        calls.push(input.body)
        yield { delta: raw }
        yield { usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.0002 } }
      },
    },
    signal: new AbortController().signal,
    emit: (event) => emitted.push(event),
    repetirCurto: false,
  })
  eq(status, 200, 'ok')
  eq(calls.length, 1, 'uma chamada')
  const final = emitted.find((event) => event.event === 'final')
  assert(final && final.event === 'final', 'final')
  const data = final.data as ChatFinal
  const doc = data.blocos[0]
  assert(doc.tipo === 'documentado', 'documentado')
  eq(doc.texto, 'A documentação cita o golpe.\n\nQue documento detalharia a relação entre Golpe de 1964 e IPES?', 'texto do modelo e pergunta do código')
  eq(JSON.stringify(doc.entidades), JSON.stringify(['golpe64']), 'id:golpe64 virou golpe64')
  eq(JSON.stringify(doc.relacoes), JSON.stringify(['E219']), 'relação saiu de entidades')
  eq(JSON.stringify(doc.fontes), JSON.stringify(['B10']), 'fonte saiu de entidades')
  eq(JSON.stringify(data.entidades.map((item) => item.id)), JSON.stringify(['ipes', 'golpe64']), 'topo id:ipes também')
  assert(!JSON.stringify(data).includes('walther_m'), 'id inventado não passa')
  // R2: nenhum aviso de sistema vai para a tela; a remoção do id inválido continua.
  eq(data.avisos.length, 0, 'sem aviso na tela')
})
