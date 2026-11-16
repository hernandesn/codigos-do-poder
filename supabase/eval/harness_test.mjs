import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseGolden, idsDeEntidades } from './golden.mjs'
import {
  avaliarRubricas,
  avaliarSemLigacao,
  citacoesInvalidas,
  classificarAvaliacao,
  classificarIdCitado,
  extrairIdsRubrica,
  paresPerguntados,
  percentilLinear,
  precisaoRevocacao,
  vozExigida,
} from './metrics.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const harness = fileURLToPath(new URL('./harness.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../functions/chat/fixtures/ctx_rockefeller_golpe64.json', import.meta.url))
const node = process.execPath

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.OPENROUTER_API_KEY
  delete env.ATLAS_SYNC_SQL
  delete env.OPENROUTER_URL
  delete env.OPENROUTER_KEY_URL
  return env
}

function runHarness(args, env = childEnv(), preload) {
  const nodeArgs = ['--experimental-strip-types']
  if (preload) nodeArgs.push('--import', preload)
  nodeArgs.push(harness, ...args)
  return new Promise((resolve) => {
    const child = spawn(node, nodeArgs, {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function tempGolden(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'aion-eval-'))
  const golden = join(dir, 'golden.jsonl')
  const out = join(dir, 'out')
  const body = Array.isArray(lines)
    ? lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
    : lines
  await writeFile(golden, body)
  return { dir, golden, out }
}

function resultadoPath(stdout) {
  const line = stdout.split('\n').find((item) => item.startsWith('resultados '))
  assert.ok(line, `sem caminho de resultado:\n${stdout}`)
  return line.slice('resultados '.length).trim()
}

const limpa = {
  id: 'limpa',
  pergunta: 'O que o recorte diz sobre a família Rockefeller?',
  expectativa: 'documentado',
  entidades_esperadas: ['rockefeller'],
  fontes_esperadas: ['S02'],
  deve_conter: ['Rockefeller'],
  nao_deve_conter: ['bolo de cenoura'],
  contexto_fixture: fixture,
  mock_resposta: {
    blocos: [{
      tipo: 'documentado',
      texto: 'A família Rockefeller aparece como coinvestidora na Rockefeller Financial Services, segundo o comunicado.',
      entidades: ['rockefeller', 'rfs'],
      relacoes: ['E005'],
      fontes: ['S02'],
    }],
    sem_base: false,
  },
}

test('percentil linear e precisão/revocação', () => {
  assert.equal(percentilLinear([], 0.5), null)
  assert.equal(percentilLinear([7], 0.95), 7)
  assert.equal(percentilLinear([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(percentilLinear([10, 20, 30, 40, 50], 0.95), 48)
  const pr = precisaoRevocacao([
    { esperado: true, detectado: true },
    { esperado: true, detectado: false },
    { esperado: false, detectado: true },
    { esperado: false, detectado: false },
  ])
  assert.equal(pr.tp, 1)
  assert.equal(pr.fp, 1)
  assert.equal(pr.fn, 1)
  assert.equal(pr.tn, 1)
  assert.equal(pr.precisao, 0.5)
  assert.equal(pr.revocacao, 0.5)
  const vazio = precisaoRevocacao([{ esperado: false, detectado: false }])
  assert.equal(vazio.precisao, null)
  assert.equal(vazio.revocacao, null)
})

test('mock: citação inválida, bloco sem fonte e caso limpo', async () => {
  const invalida = {
    ...limpa,
    id: 'invalida',
    mock_resposta: {
      blocos: [{
        tipo: 'documentado',
        texto: 'Citação inventada que aponta uma entidade que não existe na base.',
        entidades: ['id_inexistente_xyz'],
        relacoes: [],
        fontes: ['S02'],
      }],
      sem_base: false,
    },
  }
  const semFonte = {
    ...limpa,
    id: 'sem_fonte',
    mock_resposta: {
      blocos: [{
        tipo: 'documentado',
        texto: 'Fato sem fonte sobre a família Rockefeller no recorte.',
        entidades: ['rockefeller'],
        relacoes: ['E005'],
        fontes: [],
      }],
      sem_base: false,
    },
  }
  const dirs = []
  try {
    const [a, b, c] = await Promise.all([invalida, semFonte, limpa].map(async (item) => {
      const tmp = await tempGolden(['// comentario', '', item])
      dirs.push(tmp.dir)
      const run = await runHarness(['--golden', tmp.golden, '--modo', 'mock', '--out', tmp.out])
      return { run, tmp }
    }))
    assert.equal(a.run.code, 1, a.run.stderr)
    assert.equal(b.run.code, 1, b.run.stderr)
    assert.equal(c.run.code, 0, c.run.stderr + c.run.stdout)
    const jsonA = JSON.parse(await readFile(resultadoPath(a.run.stdout), 'utf8'))
    const jsonB = JSON.parse(await readFile(resultadoPath(b.run.stdout), 'utf8'))
    const jsonC = JSON.parse(await readFile(resultadoPath(c.run.stdout), 'utf8'))
    const idFantasma = jsonA.perguntas[0].repeticoes[0].citacoes.ids_invalidos.find((item) => item.id === 'id_inexistente_xyz')
    assert.ok(idFantasma)
    assert.equal(idFantasma.classe, 'inventado')
    assert.equal(idFantasma.subtipo, null)
    assert.equal(jsonA.motivos_saida.some((item) => item.endsWith(': id inventado')), true)
    assert.equal(jsonB.perguntas[0].repeticoes[0].grounding.quebrado, true)
    assert.ok(jsonB.perguntas[0].repeticoes[0].grounding.motivos.includes('bloco_documentado_sem_fonte'))
    assert.equal(jsonC.perguntas[0].repeticoes[0].citacoes.ids_invalidos.length, 0)
    assert.equal(jsonC.perguntas[0].repeticoes[0].grounding.quebrado, false)
    assert.equal(jsonC.rede.fetches_supabase, 0)
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  }
})

test('jsonl inválido sai 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aion-eval-'))
  try {
    const ruim = join(dir, 'ruim.jsonl')
    await writeFile(ruim, '// ok\n\n{nao json\n')
    const run = await runHarness(['--golden', ruim, '--modo', 'mock', '--out', join(dir, 'out')])
    assert.equal(run.code, 2)
    assert.match(run.stderr, /golden inválido/)
    const esquema = join(dir, 'esquema.jsonl')
    await writeFile(esquema, JSON.stringify({ id: 'x', pergunta: 'y', expectativa: 'chute' }) + '\n')
    const run2 = await runHarness(['--golden', esquema, '--modo', 'mock', '--out', join(dir, 'out2')])
    assert.equal(run2.code, 2)
    assert.match(run2.stderr, /expectativa/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('openrouter sem chave sai 3 e não abre rede', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aion-eval-'))
  const preload = join(dir, 'no-net.mjs')
  await writeFile(preload, `
import net from 'node:net'
net.Socket.prototype.connect = function connectBloqueado() {
  console.error('NETWORK_ATTEMPT')
  process.exit(99)
}
`)
  try {
    const run = await runHarness(
      ['--golden', join(dir, 'nao-precisa-existir.jsonl'), '--modo', 'openrouter', '--out', join(dir, 'out')],
      childEnv(),
      preload,
    )
    assert.equal(run.code, 3, run.stderr)
    assert.match(run.stderr, /falta OPENROUTER_API_KEY no ambiente/)
    assert.doesNotMatch(run.stderr, /NETWORK_ATTEMPT/)
    assert.doesNotMatch(run.stdout, /NETWORK_ATTEMPT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('arquivo de resultado não guarda segredo', async () => {
  const item = {
    ...limpa,
    id: 'segredo',
    mock_resposta: {
      blocos: [{
        tipo: 'documentado',
        texto: 'Texto com sk-or-v1-abc123456789 e Bearer abc.def e eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.signature e postgres://user:pass@localhost/db.',
        entidades: ['rockefeller'],
        relacoes: ['E005'],
        fontes: ['S02'],
      }],
      sem_base: false,
    },
  }
  const tmp = await tempGolden([item])
  try {
    const run = await runHarness(['--golden', tmp.golden, '--modo', 'mock', '--out', tmp.out])
    assert.equal(run.code, 0, run.stderr + run.stdout)
    const jsonPath = resultadoPath(run.stdout)
    const mdPath = run.stdout.split('\n').find((line) => line.startsWith('resumo ')).slice('resumo '.length).trim()
    const jsonBody = await readFile(jsonPath, 'utf8')
    const mdBody = await readFile(mdPath, 'utf8')
    for (const body of [jsonBody, mdBody]) {
      assert.equal(body.includes('sk-or-'), false)
      assert.equal(body.includes('eyJ'), false)
      assert.equal(body.includes('Bearer'), false)
      assert.doesNotMatch(body, /postgres(?:ql)?:\/\/\S+@/)
    }
    assert.match(jsonBody, /\[chave-redigida\]/)
    assert.match(jsonBody, /\[autorizacao-redigida\]/)
    assert.match(jsonBody, /\[jwt-redigido\]/)
    assert.match(jsonBody, /\[dsn-redigida\]/)
  } finally {
    await rm(tmp.dir, { recursive: true, force: true })
  }
})

test('rubricas, sem_ligacao e voz', () => {
  const frase = 'citar ids inexistentes na base, como walther_moreira_salles, walter_ms ou heitor'
  const ids = extrairIdsRubrica(frase, new Set(['walther_ms']))
  assert.ok(ids.includes('walther_moreira_salles'))
  assert.ok(ids.includes('walter_ms'))
  assert.ok(ids.includes('heitor'))
  assert.ok(!ids.includes('base'))
  const citado = avaliarRubricas({
    texto: 'A resposta cita o id proibido.',
    citados: new Set(['walther_moreira_salles']),
    deve: [],
    naoDeve: [frase],
    conhecidos: new Set(['walther_ms']),
  })
  assert.equal(citado.passa, false)
  assert.ok(citado.sobrou.includes('walther_moreira_salles'))
  assert.equal(citado.rubrica_manual[0].status, 'nao_avaliado_automaticamente')
  const limpo = avaliarRubricas({
    texto: 'A família Rockefeller aparece como coinvestidora no comunicado.',
    citados: new Set(['rockefeller', 'E005', 'S02']),
    deve: ['Rockefeller'],
    naoDeve: ['bolo de cenoura', 'walther_ms'],
    conhecidos: new Set(['rockefeller', 'walther_ms', 'E005', 'S02']),
  })
  assert.equal(limpo.passa, true)
  assert.equal(limpo.rubrica_manual.length, 0)
  const longo = avaliarRubricas({
    texto: 'O IPES atuou na derrubada.',
    citados: new Set(['ipes']),
    deve: ['IPES: atuação propagandística relacionada à derrubada de Goulart (E219, Arquivo Nacional)'],
    naoDeve: ['receita'],
    conhecidos: new Set(['E219', 'ipes']),
  })
  assert.equal(longo.passa, false)
  assert.ok(longo.faltou.includes('E219'))
  assert.equal(longo.rubrica_manual.length, 1)
  assert.ok(!longo.faltou.includes('alta'))
  const arestas = [
    { id: 'R1', origem: 'a', destino: 'x' },
    { id: 'R2', origem: 'x', destino: 'b' },
    { id: 'RAB', origem: 'a', destino: 'b' },
  ]
  const passa = avaliarSemLigacao({
    expectativa: 'sem_ligacao',
    texto: 'O atlas não documenta ligação direta entre A e B.',
    bruto: { sem_base: true, blocos: [] },
    finalData: {
      blocos: [
        { tipo: 'documentado', texto: 'A consta com X.', entidades: ['a', 'x'], relacoes: ['R1'], fontes: ['F'] },
        { tipo: 'documentado', texto: 'O atlas não documenta ligação direta entre A e B.', entidades: [], relacoes: [], fontes: [] },
      ],
      avisos: [{ tipo: 'outro', texto: 'Resposta montada direto da base: a ligação pedida não está documentada.' }],
    },
    arestas,
    entidadesEsperadas: ['a', 'b'],
  })
  assert.equal(passa.ok, true)
  const via = avaliarSemLigacao({
    expectativa: 'sem_ligacao',
    texto: 'O atlas não documenta ligação direta entre A e B.',
    bruto: { sem_base: false, blocos: [
      { tipo: 'documentado', texto: 'A liga X.', relacoes: ['R1'], fontes: ['F'] },
      { tipo: 'inferencia', texto: 'X chega em B.', base: ['R2'], justificativa: 'caminho' },
    ] },
    arestas,
    entidadesEsperadas: ['a', 'b'],
  })
  assert.equal(via.ok, false)
  assert.equal(via.afirma_relacao, true)
  const direta = avaliarSemLigacao({
    expectativa: 'sem_ligacao',
    texto: 'Há ligação direta entre A e B.',
    bruto: { sem_base: false, blocos: [{ tipo: 'documentado', texto: 'Há ligação direta entre A e B.', relacoes: ['RAB'], fontes: ['F'] }] },
    arestas,
    entidadesEsperadas: ['a', 'b'],
  })
  assert.equal(direta.ok, false)
  assert.equal(direta.afirma_texto, true)
  assert.equal(vozExigida({ categoria: 'voz_aion', pergunta: 'oi', explicita: false }), true)
  assert.equal(vozExigida({ categoria: '', pergunta: 'Separe o que é fato do que é interpretação.', explicita: false }), true)
  assert.equal(vozExigida({ categoria: '', pergunta: 'Quero fato, inferência e o que falta saber.', explicita: false }), true)
  assert.equal(vozExigida({ categoria: 'documentado_tipico', pergunta: 'O que foi a CPI do IBAD?', explicita: false }), false)
})

test('GS-008: ligação vizinha documentada não conta, ligação entre as raízes perguntadas conta', async () => {
  const esperadas = ['rothschild', 'golpe64', 'ipes', 'ibad']
  const v2 = parseGolden(await readFile(new URL('./golden/seed_v0.2.jsonl', import.meta.url), 'utf8'), 'seed_v0.2.jsonl')
  const pares = v2.find((item) => item.id === 'GS-008').pares_sem_ligacao
  const arestas = [
    { id: 'E219', origem: 'ipes', destino: 'golpe64' },
    { id: 'RX1', origem: 'rothschild', destino: 'lord_rothschild_familia' },
    { id: 'RX2', origem: 'lord_rothschild_familia', destino: 'golpe64' },
    { id: 'RD', origem: 'rothschild', destino: 'golpe64' },
  ]
  assert.deepEqual([...paresPerguntados(pares, esperadas)].sort(), ['golpe64|rothschild', 'ibad|rothschild', 'ipes|rothschild'])
  assert.equal(paresPerguntados([], esperadas).size, 6, 'sem pares explícitos vale a régua antiga: todo par')
  const lacuna = 'O atlas não documenta ligação direta entre Rothschild e IPES.'
  const comum = { expectativa: 'sem_ligacao', arestas, entidadesEsperadas: esperadas }
  const vizinhaBruto = { sem_base: false, blocos: [
    { tipo: 'documentado', texto: 'O IPES atuou na propaganda do golpe.', entidades: ['ipes', 'golpe64'], relacoes: ['E219'], fontes: ['B10'] },
    { tipo: 'documentado', texto: lacuna, entidades: [], relacoes: [], fontes: [] },
  ] }
  const vizinha = avaliarSemLigacao({ ...comum, paresSemLigacao: pares, texto: `O IPES atuou na propaganda do golpe. ${lacuna}`, bruto: vizinhaBruto })
  assert.equal(vizinha.reconhece, true)
  assert.equal(vizinha.afirma_relacao, false, 'citar E219 (ipes↔golpe64) não afirma Rothschild↔golpe/IPES')
  assert.deepEqual(vizinha.relacoes, [])
  assert.equal(vizinha.ok, true)
  const antiga = avaliarSemLigacao({ ...comum, texto: `O IPES atuou na propaganda do golpe. ${lacuna}`, bruto: vizinhaBruto })
  assert.deepEqual(antiga.relacoes, ['E219'], 'régua antiga (sem pares) reprovava a vizinha')
  assert.equal(antiga.ok, false)
  const caminho = avaliarSemLigacao({ ...comum, paresSemLigacao: pares, texto: `Os Rothschild chegam ao golpe pela família. ${lacuna}`,
    bruto: { sem_base: false, blocos: [
      { tipo: 'documentado', texto: 'O IPES atuou na propaganda do golpe.', relacoes: ['E219'], fontes: ['B10'] },
      { tipo: 'inferencia', texto: 'Os Rothschild chegam ao golpe pela família.', base: ['RX1', 'RX2'], justificativa: 'caminho' },
    ] } })
  assert.equal(caminho.afirma_relacao, true, 'caminho rothschild→família→golpe64 liga o par perguntado')
  assert.ok(!caminho.relacoes.includes('E219'), 'a vizinha documentada não entra na lista')
  assert.equal(caminho.ok, false)
  const direta = avaliarSemLigacao({ ...comum, paresSemLigacao: pares, texto: lacuna,
    bruto: { sem_base: false, blocos: [{ tipo: 'documentado', texto: 'Rothschild e o golpe.', relacoes: ['RD'], fontes: ['F'] }] } })
  assert.deepEqual(direta.relacoes, ['RD'], 'aresta direta Rothschild↔golpe é afirmação')
  assert.equal(direta.ok, false)
})

test('GS-009: pares explícitos não mudam o caso Aranha', async () => {
  const esperadas = ['oswaldo_aranha', 'egydio_aranha', 'alfredo_aranha']
  const v2 = parseGolden(await readFile(new URL('./golden/seed_v0.2.jsonl', import.meta.url), 'utf8'), 'seed_v0.2.jsonl')
  const pares = v2.find((item) => item.id === 'GS-009').pares_sem_ligacao
  const arestas = [
    { id: 'E178', origem: 'egydio_aranha', destino: 'alfredo_aranha' },
    { id: 'RO', origem: 'oswaldo_aranha', destino: 'x_intermediario' },
    { id: 'RE', origem: 'x_intermediario', destino: 'egydio_aranha' },
  ]
  const texto = 'O atlas não documenta ligação direta entre Oswaldo Aranha e Egydio de Souza Aranha. Sobrenome igual não prova parentesco.'
  const casos = [
    { texto, bruto: { sem_base: false, blocos: [{ tipo: 'documentado', texto, entidades: [], relacoes: [], fontes: [] }] } },
    { texto: 'Oswaldo Aranha e Egydio são parentes.', bruto: { sem_base: false, blocos: [] } },
    { texto, bruto: { sem_base: false, blocos: [{ tipo: 'inferencia', texto: 'via x', base: ['RO', 'RE'], justificativa: 'caminho' }] } },
    { texto: 'Sem registro.', bruto: { sem_base: false, blocos: [] } },
  ]
  for (const caso of casos) {
    const base = { expectativa: 'sem_ligacao', arestas, entidadesEsperadas: esperadas, ...caso }
    const nova = avaliarSemLigacao({ ...base, paresSemLigacao: pares })
    const velha = avaliarSemLigacao(base)
    assert.equal(nova.ok, velha.ok, caso.texto)
    assert.equal(nova.afirma_relacao, velha.afirma_relacao, caso.texto)
  }
})

test('golden aceita pares_sem_ligacao e recusa par inválido', () => {
  const linha = (pares) => JSON.stringify({ id: 'X1', pergunta: 'a e b?', expectativa: 'sem_ligacao', entidades_esperadas: ['a', 'b'], pares_sem_ligacao: pares })
  assert.deepEqual(parseGolden(linha([['a', 'b']]), 'x.jsonl')[0].pares_sem_ligacao, [['a', 'b']])
  assert.deepEqual(parseGolden(JSON.stringify({ id: 'X2', pergunta: 'p', expectativa: 'documentado' }), 'x.jsonl')[0].pares_sem_ligacao, [])
  assert.throws(() => parseGolden(linha([['a']]), 'x.jsonl'), /pares_sem_ligacao/)
  assert.throws(() => parseGolden(linha([['a', 'a']]), 'x.jsonl'), /pares_sem_ligacao/)
})

test('seed oficial aceita entidades em objeto', async () => {
  const raw = await readFile(new URL('./golden/seed_v0.1.jsonl', import.meta.url), 'utf8')
  const items = parseGolden(raw, 'seed_v0.1.jsonl')
  assert.equal(items.length, 20)
  const primeira = items.find((item) => item.id === 'GS-001')
  assert.equal(primeira.entidades_esperadas[0].id, 'golpe64')
  assert.equal(primeira.entidades_esperadas[0].id_pendente, null)
  assert.ok(primeira.conexoes_esperadas.includes('E219'))
  assert.equal(items.filter((item) => item.expectativa === 'sem_ligacao').length, 2)
  assert.equal(items.filter((item) => item.expectativa === 'fora_da_base').length, 3)
  const [solto] = parseGolden(`${JSON.stringify({
    id: 'obj',
    pergunta: 'p',
    expectativa: 'sem_ligacao',
    entidades_esperadas: [{ id: 'aa_eval', id_pendente: true }, 'bb_eval'],
    conexoes_esperadas: ['R_AA'],
  })}\n`, 't.jsonl')
  assert.equal(solto.entidades_esperadas[0].id_pendente, true)
  assert.deepEqual(idsDeEntidades(solto.entidades_esperadas), ['aa_eval', 'bb_eval'])
})

test('seed_v0.2 = v0.1 + pares_sem_ligacao só no GS-008 e no GS-009', async () => {
  const v1 = parseGolden(await readFile(new URL('./golden/seed_v0.1.jsonl', import.meta.url), 'utf8'), 'seed_v0.1.jsonl')
  const v2 = parseGolden(await readFile(new URL('./golden/seed_v0.2.jsonl', import.meta.url), 'utf8'), 'seed_v0.2.jsonl')
  assert.equal(v2.length, v1.length)
  for (const item of v1) assert.deepEqual(item.pares_sem_ligacao, [], `${item.id}: v0.1 sem pares (régua antiga)`)
  for (let i = 0; i < v1.length; i++) {
    const { pares_sem_ligacao: pares, ...resto } = v2[i]
    const { pares_sem_ligacao: _vazio, ...base } = v1[i]
    assert.deepEqual(resto, base, `${v1[i].id}: igual à v0.1 fora do campo novo`)
    if (v2[i].id === 'GS-008') assert.deepEqual(pares, [['rothschild', 'golpe64'], ['rothschild', 'ipes'], ['rothschild', 'ibad']])
    else if (v2[i].id === 'GS-009') assert.deepEqual(pares, [['oswaldo_aranha', 'egydio_aranha'], ['oswaldo_aranha', 'alfredo_aranha']])
    else assert.deepEqual(pares, [], `${v2[i].id}: sem pares`)
  }
})

test('sem_ligacao, objetos, conexões e rubrica no harness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aion-eval-'))
  const fixtureSl = join(dir, 'ctx.json')
  await writeFile(fixtureSl, JSON.stringify({
    raizes: [
      { id: 'aa_eval', nome: 'Aa', tipo: 'organizacao' },
      { id: 'bb_eval', nome: 'Bb', tipo: 'organizacao' },
    ],
    entidades: [
      { id: 'aa_eval', nome: 'Aa', tipo: 'organizacao' },
      { id: 'bb_eval', nome: 'Bb', tipo: 'organizacao' },
      { id: 'xx_eval', nome: 'Xx', tipo: 'organizacao' },
      { id: 'yy_eval', nome: 'Yy', tipo: 'organizacao' },
    ],
    relacoes: [
      { id: 'R_AA', origem: 'aa_eval', destino: 'xx_eval', afirmacao: 'Aa consta com Xx no recorte de teste.', fontes: ['F_EVAL'], estado: 'historico' },
      { id: 'R_BB', origem: 'bb_eval', destino: 'yy_eval', afirmacao: 'Bb consta com Yy no recorte de teste.', fontes: ['F_EVAL'], estado: 'historico' },
      { id: 'R_AB', origem: 'aa_eval', destino: 'bb_eval', afirmacao: 'Aa consta com Bb no recorte de teste.', fontes: ['F_EVAL'], estado: 'historico' },
    ],
    fontes: [{ id: 'F_EVAL', titulo: 'Fonte de teste' }],
    casos: [],
    ligacoes_entre_raizes: [],
  }))
  const tmp = await tempGolden([
    {
      id: 'sl_passa',
      pergunta: 'A base liga Aa e Bb neste recorte de teste?',
      expectativa: 'sem_ligacao',
      categoria: 'sem_ligacao',
      entidades_esperadas: [{ id: 'aa_eval' }, { id: 'bb_eval', id_pendente: false }],
      conexoes_esperadas: ['R_AA', 'R_BB'],
      fontes_esperadas: ['F_EVAL'],
      deve_conter: ['não documenta ligação'],
      nao_deve_conter: ['walther_moreira_salles'],
      contexto_fixture: fixtureSl,
    },
    {
      id: 'sl_falha',
      pergunta: 'Existe ligação direta de Aa com Bb no teste?',
      expectativa: 'sem_ligacao',
      entidades_esperadas: [{ id: 'aa_eval' }, { id: 'bb_eval' }],
      conexoes_esperadas: ['R_AB'],
      contexto_fixture: fixtureSl,
      mock_resposta: {
        blocos: [{
          tipo: 'documentado',
          texto: 'Há ligação direta entre Aa e Bb.',
          entidades: ['aa_eval', 'bb_eval'],
          relacoes: ['R_AB'],
          fontes: ['F_EVAL'],
        }],
        sem_base: false,
      },
    },
    {
      id: 'rubrica_id',
      pergunta: 'O que o recorte de teste diz sobre Aa?',
      expectativa: 'documentado',
      entidades_esperadas: ['aa_eval'],
      conexoes_esperadas: ['R_AA'],
      fontes_esperadas: ['F_EVAL'],
      nao_deve_conter: ['aa_eval'],
      contexto_fixture: fixtureSl,
      mock_resposta: {
        blocos: [{
          tipo: 'documentado',
          texto: 'Aa consta com Xx no recorte de teste.',
          entidades: ['aa_eval', 'xx_eval'],
          relacoes: ['R_AA'],
          fontes: ['F_EVAL'],
        }],
        sem_base: false,
      },
    },
  ])
  try {
    const run = await runHarness([
      '--golden', tmp.golden,
      '--modo', 'mock',
      '--mock-perfil', 'limpo',
      '--juiz', 'off',
      '--out', tmp.out,
    ])
    assert.equal(run.code, 0, run.stderr + run.stdout)
    const json = JSON.parse(await readFile(resultadoPath(run.stdout), 'utf8'))
    assert.equal(json.juiz.ativo, false)
    assert.equal(json.juiz.status, 'desativado')
    assert.equal(json.fora_da_base?.tp, undefined)
    assert.equal(json.agregado.fora_da_base.fp, 0)
    const porId = Object.fromEntries(json.perguntas.map((item) => [item.id, item]))
    const passa = porId.sl_passa.repeticoes[0]
    assert.equal(passa.sem_ligacao.ok, true)
    assert.equal(passa.recall_entidades.recall, 1)
    assert.equal(passa.recall_conexoes.recall, 1)
    assert.equal(passa.conter.passa, true)
    assert.equal(porId.sl_falha.repeticoes[0].sem_ligacao.ok, false)
    assert.equal(porId.sl_falha.repeticoes[0].recall_conexoes.recall, 1)
    const rubrica = porId.rubrica_id.repeticoes[0]
    assert.equal(rubrica.conter.passa, false)
    assert.ok(rubrica.conter.sobrou.includes('aa_eval'))
    assert.equal(json.agregado.sem_ligacao.ok, 1)
    assert.equal(json.agregado.sem_ligacao.n, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(tmp.dir, { recursive: true, force: true })
  }
})

test('--ids-base marca id fora da referência como inválido', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aion-eval-'))
  const idsPath = join(dir, 'ids.json')
  await writeFile(idsPath, JSON.stringify({
    entidades: ['rockefeller'],
    relacoes: ['E005'],
    fontes: ['S02'],
    casos: ['caso_so_na_ref'],
    _meta: { origem: 'teste' },
  }))
  const tmp = await tempGolden([{
    ...limpa,
    id: 'fora_da_ref',
    entidades_esperadas: [{ id: 'rockefeller' }, { id: 'id_esperado_ausente', id_pendente: true }],
  }])
  try {
    const run = await runHarness([
      '--golden', tmp.golden,
      '--modo', 'mock',
      '--ids-base', idsPath,
      '--out', tmp.out,
    ])
    assert.equal(run.code, 1, run.stderr + run.stdout)
    const json = JSON.parse(await readFile(resultadoPath(run.stdout), 'utf8'))
    assert.equal(json.base_citacao, 'ids_base')
    assert.equal(json.referencia_ids.contagens.entidades, 1)
    assert.equal(json.referencia_ids._meta.origem, 'teste')
    const invalidos = json.perguntas[0].repeticoes[0].citacoes.ids_invalidos
    assert.ok(invalidos.some((item) => item.id === 'rfs'), JSON.stringify(invalidos))
    assert.equal(json.divergencia_ids.origem, 'recorte')
    assert.ok(json.divergencia_ids.tipos.casos.so_na_referencia.ids.includes('caso_so_na_ref'))
    assert.ok(json.avisos_golden.some((item) => item.tipo === 'id_esperado_inexistente' && item.id === 'id_esperado_ausente'))
    assert.equal(json.codigo_saida, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(tmp.dir, { recursive: true, force: true })
  }
})

test('id inválido separa inventado e formato, com subtipo', () => {
  const base = {
    entidades: new Set(['walther_ms', 'heitor_lyra']),
    relacoes: new Set(['E219', 'PR3-E056', 'E005']),
    fontes: new Set(['B10', 'S02']),
    casos: new Set(['OP35']),
  }
  const nomes = [{ id: 'heitor_lyra', nome: 'Heitor Lyra · diplomata' }]
  const invalidos = citacoesInvalidas({
    entidades: [
      'Heitor Lyra · diplomata',
      'id:B10',
      'id_B10',
      'id":"B10"',
      'id": "B10"',
      '"B10"',
      '{B10}',
      'B10/',
      'id',
      'E219',
      'walther_moreira_salles',
      'walther_ms',
      'id:nao_existe_eval',
    ],
    relacoes: ['B10', 'E005'],
    fontes: ['S02'],
    bases: ['PR3-E056', 'B10'],
  }, base, { nomes })
  const achar = (campo, id) => invalidos.find((item) => item.campo === campo && item.id === id)
  const rotulo = achar('entidade', 'Heitor Lyra · diplomata')
  assert.equal(rotulo.classe, 'formato')
  assert.equal(rotulo.subtipo, 'rotulo_exibicao')
  assert.equal(rotulo.id_normalizado, 'heitor_lyra')
  for (const id of ['id:B10', 'id_B10', 'id":"B10"', 'id": "B10"']) {
    const item = achar('entidade', id)
    assert.equal(item.classe, 'formato', id)
    assert.equal(item.subtipo, 'prefixo_id', id)
    assert.equal(item.id_normalizado, 'B10', id)
  }
  for (const id of ['"B10"', '{B10}', 'B10/']) {
    const item = achar('entidade', id)
    assert.equal(item.classe, 'formato', id)
    assert.equal(item.subtipo, 'json_vazado', id)
    assert.equal(item.id_normalizado, 'B10', id)
  }
  const literal = achar('entidade', 'id')
  assert.equal(literal.classe, 'formato')
  assert.equal(literal.subtipo, 'literal_id')
  assert.equal(literal.id_normalizado, null)
  assert.equal(classificarIdCitado('entidade', '', base).subtipo, 'literal_id')
  assert.equal(classificarIdCitado('entidade', '{}', base).subtipo, 'literal_id')
  assert.equal(classificarIdCitado('fonte', 'id": ', base).subtipo, 'literal_id')
  const campo = achar('entidade', 'E219')
  assert.equal(campo.classe, 'formato')
  assert.equal(campo.subtipo, 'campo_errado')
  assert.equal(campo.id_normalizado, 'E219')
  assert.equal(achar('relacao', 'B10').subtipo, 'campo_errado')
  assert.equal(achar('base', 'B10').subtipo, 'campo_errado')
  const inventado = achar('entidade', 'walther_moreira_salles')
  assert.equal(inventado.classe, 'inventado')
  assert.equal(inventado.subtipo, null)
  const prefixoFantasma = achar('entidade', 'id:nao_existe_eval')
  assert.equal(prefixoFantasma.classe, 'inventado')
  assert.equal(prefixoFantasma.subtipo, null)
  assert.equal(prefixoFantasma.id_normalizado, 'nao_existe_eval')
  assert.equal(achar('entidade', 'walther_ms'), undefined)
  assert.equal(achar('relacao', 'E005'), undefined)
  assert.equal(achar('fonte', 'S02'), undefined)
  assert.equal(achar('base', 'PR3-E056'), undefined)
  const semNome = citacoesInvalidas({
    entidades: ['Heitor Lyra · diplomata'],
    relacoes: [],
    fontes: [],
    bases: [],
  }, base)
  assert.equal(semNome[0].classe, 'inventado')
})

test('rótulo homônimo não usa o recorte para desempatar', () => {
  const base = {
    entidades: new Set(['heitor_lyra', 'heitor_outro', 'h0', 'h1', 'h2', 'h3', 'h4', 'h5']),
    relacoes: new Set(),
    fontes: new Set(),
    casos: new Set(),
  }
  const nomes = [
    { id: 'heitor_outro', nome: 'Heitor Lyra' },
    { id: 'heitor_lyra', nome: 'Heitor Lyra · diplomata' },
  ]
  const preferir = new Set(['heitor_outro'])
  const citados = (id) => ({ entidades: [id], relacoes: [], fontes: [], bases: [] })

  const cheio = citacoesInvalidas(citados('Heitor Lyra · diplomata'), base, { nomes, preferir })
  assert.equal(cheio[0].classe, 'formato')
  assert.equal(cheio[0].subtipo, 'rotulo_exibicao')
  assert.equal(cheio[0].id_normalizado, 'heitor_lyra')

  const ambiguo = citacoesInvalidas(citados('Heitor Lyra · embaixador'), base, { nomes, preferir })
  assert.equal(ambiguo[0].classe, 'formato')
  assert.equal(ambiguo[0].subtipo, 'rotulo_ambiguo')
  assert.equal(ambiguo[0].id_normalizado, null)
  assert.deepEqual(ambiguo[0].candidatos, ['heitor_lyra', 'heitor_outro'])

  const nenhum = citacoesInvalidas(citados('Pessoa Nenhuma · cargo'), base, { nomes, preferir })
  assert.equal(nenhum[0].classe, 'inventado')
  assert.equal(nenhum[0].subtipo, null)
  assert.equal(nenhum[0].id_normalizado, null)
  assert.equal(nenhum[0].candidatos, undefined)

  const soUm = citacoesInvalidas(citados('Heitor Lyra · consul'), base, {
    nomes: [{ id: 'heitor_lyra', nome: 'Heitor Lyra · diplomata' }],
    preferir: new Set(['heitor_outro']),
  })
  assert.equal(soUm[0].subtipo, 'rotulo_exibicao')
  assert.equal(soUm[0].id_normalizado, 'heitor_lyra')

  const muitos = []
  for (let i = 0; i < 6; i++) {
    muitos.push({ id: `h${i}`, nome: i === 0 ? 'Homem Igual' : `Homem Igual · cargo ${i}` })
  }
  const cap = citacoesInvalidas(citados('Homem Igual · desconhecido'), base, {
    nomes: muitos,
    preferir: new Set(['h0']),
  })
  assert.equal(cap[0].subtipo, 'rotulo_ambiguo')
  assert.equal(cap[0].id_normalizado, null)
  assert.deepEqual(cap[0].candidatos, ['h0', 'h1', 'h2', 'h3', 'h4'])
})

test('light e ms na prosa da rubrica não viram id', () => {
  const conhecidos = new Set(['light', 'ms', 'atlas', 'E219', 'PR3-E056', 'walther_ms', 'base', 'fonte'])
  const prosa = extrairIdsRubrica(
    'A prosa cita light e ms ao falar do atlas, sem lista.',
    conhecidos,
  )
  assert.ok(!prosa.includes('light'))
  assert.ok(!prosa.includes('ms'))
  assert.ok(!prosa.includes('atlas'))
  assert.ok(!prosa.includes('base'))
  const estrutural = extrairIdsRubrica('O IPES atuou (E219) e a relação PR3-E056 continua.', conhecidos)
  assert.ok(estrutural.includes('E219'))
  assert.ok(estrutural.includes('PR3-E056'))
  assert.deepEqual(extrairIdsRubrica('light', conhecidos), ['light'])
  assert.deepEqual(extrairIdsRubrica('ms', conhecidos), ['ms'])
  const lista = extrairIdsRubrica('walther_ms, light ou ms', conhecidos)
  assert.ok(lista.includes('walther_ms'))
  assert.ok(lista.includes('light'))
  assert.ok(lista.includes('ms'))
  const ignorar = extrairIdsRubrica('citar a base e a fonte no meio da frase', conhecidos)
  assert.ok(!ignorar.includes('base'))
  assert.ok(!ignorar.includes('fonte'))
})

test('fora_da_base segue avaliável e json inválido não', () => {
  assert.deepEqual(
    classificarAvaliacao({ httpStatus: 200, erroCode: 'fora_da_base', textosModelo: [], bruto: null }),
    { avaliavel: true, codigo: null },
  )
  assert.deepEqual(
    classificarAvaliacao({ httpStatus: 503, erroCode: 'chave_recusada', textosModelo: [], bruto: null }),
    { avaliavel: false, codigo: 'chave_recusada' },
  )
  assert.deepEqual(
    classificarAvaliacao({ httpStatus: 200, erroCode: null, textosModelo: ['{nao-json'], bruto: null }),
    { avaliavel: false, codigo: 'json_invalido' },
  )
  assert.deepEqual(
    classificarAvaliacao({ httpStatus: 200, erroCode: null, textosModelo: ['{"sem_base":true}'], bruto: { sem_base: true } }),
    { avaliavel: true, codigo: null },
  )
  assert.equal(
    classificarAvaliacao({ httpStatus: 401, erroCode: 'sem_login', textosModelo: [], bruto: null }).codigo,
    'sem_login',
  )
  assert.equal(
    classificarAvaliacao({ httpStatus: 429, erroCode: 'rate_limit', textosModelo: [], bruto: null }).avaliavel,
    false,
  )
})

test('chave recusada em toda corrida sai 3', async () => {
  const doc = { ...limpa, id: 'doc_503' }
  delete doc.mock_resposta
  const fora = {
    ...doc,
    id: 'fora_503',
    expectativa: 'fora_da_base',
    deve_conter: [],
    nao_deve_conter: [],
  }
  const semLigacao = {
    ...doc,
    id: 'sl_503',
    expectativa: 'sem_ligacao',
    entidades_esperadas: ['rockefeller', 'rfs'],
    deve_conter: [],
    nao_deve_conter: [],
  }
  const tmp = await tempGolden([doc, fora, semLigacao])
  try {
    const run = await runHarness(
      ['--golden', tmp.golden, '--modo', 'mock', '--out', tmp.out],
      childEnv({ AION_EVAL_MOCK_RECUSAR_CHAVE: '1' }),
    )
    assert.equal(run.code, 3, run.stderr + run.stdout)
    assert.doesNotMatch(run.stderr, /sk-or-|eyJ|Bearer [A-Za-z0-9]/)
    const json = JSON.parse(await readFile(resultadoPath(run.stdout), 'utf8'))
    const md = await readFile(
      run.stdout.split('\n').find((line) => line.startsWith('resumo ')).slice('resumo '.length).trim(),
      'utf8',
    )
    assert.equal(json.codigo_saida, 3)
    assert.equal(json.agregado.avaliaveis, 0)
    assert.equal(json.agregado.nao_avaliaveis, 3)
    assert.equal(json.agregado.grounding_documentado, null)
    assert.equal(json.agregado.recall_entidades_medio, null)
    assert.equal(json.agregado.pt_br_medio, null)
    assert.equal(json.agregado.custo.usd_medio, null)
    assert.equal(json.agregado.custo.tokens_in, 0)
    assert.equal(json.agregado.fora_da_base.tp + json.agregado.fora_da_base.fp + json.agregado.fora_da_base.fn + json.agregado.fora_da_base.tn, 0)
    assert.equal(json.agregado.sem_ligacao.n, 0)
    assert.deepEqual(
      json.motivos_saida,
      [
        'doc_503: avaliacao_nao_ocorreu (chave_recusada)',
        'fora_503: avaliacao_nao_ocorreu (chave_recusada)',
        'sl_503: avaliacao_nao_ocorreu (chave_recusada)',
      ],
    )
    for (const item of json.perguntas) {
      const corrida = item.repeticoes[0]
      assert.equal(corrida.http_status, 503)
      assert.equal(corrida.erro.code, 'chave_recusada')
      assert.equal(corrida.avaliavel, false)
      assert.equal(corrida.recall_entidades.recall, null)
      assert.equal(corrida.recall_fontes.recall, null)
      assert.equal(corrida.recall_conexoes.recall, null)
      assert.equal(corrida.pt_br, null)
      assert.equal(corrida.voz, null)
      assert.equal(corrida.custo, null)
    }
    assert.match(md, /nao_avaliado/)
    assert.match(md, /rubricas nao_avaliado/)
    assert.match(md, /avaliacao_nao_ocorreu \(chave_recusada\)/)
    assert.equal(json.agregado.rubricas.auto_ok, 0)
    assert.equal(json.agregado.rubricas.auto_falha, 0)
    assert.equal(json.agregado.rubricas.manual, 0)
    assert.equal(json.perguntas[0].repeticoes[0].conter.nao_avaliado, true)
    assert.ok(json.agregado.metricas_sem_amostra.includes('pt_br'))
    assert.ok(json.agregado.metricas_sem_amostra.includes('custo_medio_usd'))
    assert.ok(json.agregado.metricas_sem_amostra.includes('entidades'))
    assert.ok(json.agregado.metricas_sem_amostra.includes('sem_ligacao'))
    assert.equal(json.alertas.some((item) => item.includes('indefinido')), false)
    assert.equal(json.alertas.some((item) => item.startsWith('sem_ligacao:')), false)
    assert.match(md, /Métricas sem amostra:/)
    assert.doesNotMatch(md, /indefinido \(limiar/)
    assert.equal(json.rede.fetches_supabase, 0)
    assert.deepEqual(json.rede.hosts, ['127.0.0.1'])
  } finally {
    await rm(tmp.dir, { recursive: true, force: true })
  }
})

test('harness grava inventado e formato na mesma corrida', async () => {
  const tmp = await tempGolden([{
    ...limpa,
    id: 'classes',
    mock_resposta: {
      blocos: [{
        tipo: 'documentado',
        texto: 'A família Rockefeller aparece no recorte, com uma fonte.',
        entidades: ['Heitor Lyra · diplomata', 'id_E001', 'id', 'E005', 'walther_moreira_salles', 'rockefeller'],
        relacoes: ['S02'],
        fontes: ['S02'],
      }],
      entidades: ['Heitor Lyra · diplomata', 'id_E001', 'id', 'E005', 'walther_moreira_salles', 'rockefeller'],
      relacoes: ['S02'],
      fontes: ['S02'],
      sem_base: false,
    },
  }])
  try {
    const run = await runHarness(['--golden', tmp.golden, '--modo', 'mock', '--out', tmp.out])
    assert.equal(run.code, 1, run.stderr + run.stdout)
    const json = JSON.parse(await readFile(resultadoPath(run.stdout), 'utf8'))
    const invalidos = json.perguntas[0].repeticoes[0].citacoes.ids_invalidos
    const achar = (id) => invalidos.find((item) => item.id === id)
    assert.equal(achar('Heitor Lyra · diplomata').classe, 'inventado')
    assert.equal(achar('id_E001').classe, 'inventado')
    assert.equal(achar('id').classe, 'formato')
    assert.equal(achar('id').subtipo, 'literal_id')
    assert.equal(achar('E005').subtipo, 'campo_errado')
    assert.equal(achar('S02').subtipo, 'campo_errado')
    assert.equal(achar('walther_moreira_salles').classe, 'inventado')
    assert.equal(achar('rockefeller'), undefined)
    assert.equal(json.agregado.citacoes_por_classe.inventado, 3)
    assert.equal(json.agregado.citacoes_por_classe.formato, 3)
    assert.equal(json.agregado.citacoes_por_classe.formato_por_subtipo.literal_id, 1)
    assert.equal(json.agregado.citacoes_por_classe.formato_por_subtipo.campo_errado, 2)
    assert.equal(json.perguntas[0].citacoes_por_classe.inventado, 3)
    assert.equal(json.codigo_saida, 1)
    assert.ok(json.motivos_saida.includes('classes: id inventado'))
    assert.ok(json.motivos_saida.includes('classes: citação com formato inválido'))
    const md = await readFile(
      run.stdout.split('\n').find((line) => line.startsWith('resumo ')).slice('resumo '.length).trim(),
      'utf8',
    )
    assert.match(md, /inventado 3/)
    assert.match(md, /formato 3/)
    assert.match(md, /campo_errado 2/)
    assert.match(md, /literal_id 1/)
    assert.match(md, /id inventado em 1 corrida/)
    assert.match(md, /citação com formato inválido em 1 corrida/)
  } finally {
    await rm(tmp.dir, { recursive: true, force: true })
  }
})

test('finally restaura CHAT_DAILY_BUDGET_USD e CHAT_EXPOSE_STATE', async () => {
  const { capturarAmbiente, restaurarAmbiente } = await import('./harness.mjs')
  const anterior = {
    CHAT_DAILY_BUDGET_USD: process.env.CHAT_DAILY_BUDGET_USD,
    CHAT_EXPOSE_STATE: process.env.CHAT_EXPOSE_STATE,
  }
  const restaurarOriginal = () => {
    for (const [key, value] of Object.entries(anterior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    delete process.env.CHAT_DAILY_BUDGET_USD
    delete process.env.CHAT_EXPOSE_STATE
    const ausentes = capturarAmbiente()
    process.env.CHAT_DAILY_BUDGET_USD = '3'
    process.env.CHAT_EXPOSE_STATE = '1'
    restaurarAmbiente(ausentes)
    assert.equal(process.env.CHAT_DAILY_BUDGET_USD, undefined)
    assert.equal(process.env.CHAT_EXPOSE_STATE, undefined)

    process.env.CHAT_DAILY_BUDGET_USD = '9'
    process.env.CHAT_EXPOSE_STATE = 'sim'
    const presentes = capturarAmbiente()
    process.env.CHAT_DAILY_BUDGET_USD = '3'
    delete process.env.CHAT_EXPOSE_STATE
    restaurarAmbiente(presentes)
    assert.equal(process.env.CHAT_DAILY_BUDGET_USD, '9')
    assert.equal(process.env.CHAT_EXPOSE_STATE, 'sim')
  } finally {
    restaurarOriginal()
  }
})

test('reclassificar.mjs separa inventado e formato sem rede', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aion-reclass-'))
  const resultados = join(dir, 'resultados_teste.json')
  const ids = join(dir, 'ids.json')
  const sync = join(dir, 'sync.sql')
  const out = join(dir, 'out')
  await writeFile(ids, JSON.stringify({
    entidades: ['heitor_lyra', 'walther_ms'],
    relacoes: ['E219'],
    fontes: ['B10'],
    casos: [],
  }))
  await writeFile(sync, `INSERT INTO entities (entity_id, canonical_name, normalized_name, entity_type, research_cluster, note, metadata) VALUES
('heitor_lyra', 'Heitor Lyra · diplomata', 'heitor lyra · diplomata', 'pessoa', 'x', 'nota com ''aspas''', '{}'::jsonb);
`)
  await writeFile(resultados, JSON.stringify({
    gerado_em: '2026-11-09T00:00:00.000Z',
    perguntas: [{
      id: 'GS-007',
      expectativa: 'inferencia',
      repeticoes: [{
        http_status: 200,
        avaliavel: true,
        grounding: { quebrado: false },
        recorte: { raizes: ['heitor_lyra'] },
        citacoes: {
          ids_invalidos: [
            { campo: 'entidade', id: 'id:B10', motivo: 'inexistente' },
            { campo: 'entidade', id: 'fantasma_xyz', motivo: 'inexistente' },
            { campo: 'entidade', id: 'Heitor Lyra · diplomata', motivo: 'formato_quebrado' },
            { campo: 'entidade', id: 'E219', motivo: 'campo_errado' },
            { campo: 'entidade', id: 'id', motivo: 'formato_quebrado' },
          ],
        },
      }],
    }],
  }))
  const script = fileURLToPath(new URL('./reclassificar.mjs', import.meta.url))
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(node, ['--experimental-strip-types', script, '--resultados', resultados, '--ids-base', ids, '--sync-sql', sync, '--out', out], {
        cwd: repo,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
    assert.equal(run.code, 1, run.stderr + run.stdout)
    const json = JSON.parse(await readFile(join(out, 'reclassificado_teste.json'), 'utf8'))
    const itens = json.perguntas[0].repeticoes[0].ids_invalidos
    const achar = (id) => itens.find((item) => item.id === id)
    assert.equal(achar('id:B10').subtipo, 'prefixo_id')
    assert.equal(achar('id:B10').id_normalizado, 'B10')
    assert.equal(achar('fantasma_xyz').classe, 'inventado')
    assert.equal(achar('Heitor Lyra · diplomata').subtipo, 'rotulo_exibicao')
    assert.equal(achar('Heitor Lyra · diplomata').id_normalizado, 'heitor_lyra')
    assert.equal(achar('E219').subtipo, 'campo_errado')
    assert.equal(achar('id').subtipo, 'literal_id')
    assert.equal(achar('id').id_normalizado, null)
    assert.equal(json.agregado.citacoes_por_classe.inventado, 1)
    assert.equal(json.agregado.citacoes_por_classe.formato, 4)
    assert.ok(json.motivos_saida.includes('GS-007: id inventado'))
    assert.ok(json.motivos_saida.includes('GS-007: citação com formato inválido'))
    const md = await readFile(join(out, 'reclassificado_teste.md'), 'utf8')
    assert.match(md, /\| GS-007 \| 1 \| 4 \|/)
    assert.match(md, /id inventado/)
    assert.match(md, /citação com formato inválido/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('integração com sync SQL quando ATLAS_SYNC_SQL existe', { timeout: 180_000 }, async () => {
  const sync = process.env.ATLAS_SYNC_SQL_TEST
  if (!sync) {
    console.log('SKIP integração: ATLAS_SYNC_SQL_TEST ausente')
    return
  }
  const tmp = await tempGolden([{
    id: 'walther',
    pergunta: 'Quem foi Walther Moreira Salles?',
    expectativa: 'documentado',
    entidades_esperadas: ['walther_ms'],
    notas: 'Integração: o recorte sai de public.chat_context no PGlite.',
  }])
  try {
    const run = await runHarness(
      ['--golden', tmp.golden, '--modo', 'mock', '--sync-sql', sync, '--out', tmp.out],
      childEnv(),
    )
    assert.equal(run.code, 0, run.stderr + run.stdout)
    const json = JSON.parse(await readFile(resultadoPath(run.stdout), 'utf8'))
    assert.equal(json.base_citacao, 'sync')
    assert.equal(json.rede.fetches_supabase, 0)
    const raizes = json.perguntas[0].repeticoes[0].recorte.raizes
    assert.ok(raizes.includes('walther_ms'), `raízes: ${raizes.join(',')}`)
    assert.equal(json.perguntas[0].repeticoes[0].citacoes.ids_invalidos.length, 0)
    assert.equal(json.perguntas[0].repeticoes[0].grounding.quebrado, false)
  } finally {
    await rm(tmp.dir, { recursive: true, force: true })
  }
})
