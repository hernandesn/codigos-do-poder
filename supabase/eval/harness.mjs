// Harness de avaliação do chat (Fase 0).
// O recorte entra por monkeypatch de MemoryChatDb.prototype.chatContext.
// O pedido HTTP passa por handleChatRequest, que chama prepareChat,
// streamPrepared e sanitizeAnswer do núcleo de produção.
// Sem --sync-sql, cada pergunta pode trazer contexto_fixture.
// Sem sync e sem fixture, a pergunta fica marcada como recorte_indisponivel.

import { createServer } from 'node:http'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openAtlas, idsFromContext } from './atlas.mjs'
import { GoldenError, idsDeEntidades, parseGolden } from './golden.mjs'
import * as metrics from './metrics.mjs'
import { MOCK_API_KEY, createMockState, parseRecorte, startMock } from './mock_openrouter.mjs'
import { filtroSegredos, redigir } from './redact.mjs'
import { loadChatModules } from './runtime.mjs'
import { parseModelJson, parseSse, terminalCompleto, textoDoFluxo } from './sse.mjs'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const JWT_SECRET = 'fixture-hmac-eval'
const SUPABASE_URL = 'https://fixture.supabase.co'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key'

const LATENCIA_METODO = 'PERCENTILE.INC: ordena a amostra e interpola em p*(n-1). p50 = 0.5, p95 = 0.95.'

export async function main(argv = process.argv.slice(2), env = process.env) {
  const restaurarStderr = instalarFiltroStderr()
  const sair = (codigo) => {
    restaurarStderr()
    return codigo
  }
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'argumento inválido')
    return sair(2)
  }
  if (args.modo === 'openrouter' && !env.OPENROUTER_API_KEY) {
    console.error('falta OPENROUTER_API_KEY no ambiente')
    return sair(3)
  }

  const { core, memory, handler } = await loadChatModules()
  let golden
  try {
    const raw = await readFile(args.golden, 'utf8')
    golden = parseGolden(raw, args.golden)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'golden inválido')
    return sair(2)
  }

  const precos = resolverPrecos(args, core)
  const limiares = JSON.parse(await readFile(new URL('./limiares.json', import.meta.url), 'utf8'))
  const outDir = args.out ?? fileUrlToPath(new URL('./out/', import.meta.url))
  await mkdir(outDir, { recursive: true })
  let referencia = null
  if (args.idsBase) {
    try {
      referencia = await lerIdsBase(args.idsBase)
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'ids-base inválido')
      return sair(2)
    }
  }

  let atlas = null
  let envSalvo = null
  const contagem = { bloqueados: 0, supabase: 0, hosts: new Set() }
  let restoreFetch = () => {}
  const state = {
    atlas: null,
    fixture: null,
    lastContext: null,
    empty: () => ({
      raizes: [], entidades: [], relacoes: [], fontes: [], casos: [],
      limites: { relacoes: 0, fontes: 0, truncado: false },
    }),
  }
  const restoreContext = installContext(memory.MemoryChatDb, state)
  let mock = null
  let app = null
  try {
    envSalvo = capturarAmbiente()
    if (args.syncSql) {
      try {
        await readFile(args.syncSql)
        atlas = await openAtlas(args.syncSql)
        state.atlas = atlas
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'falha ao carregar o sync SQL')
        return 2
      }
    }
    try {
      await carregarFixtures(golden, atlas)
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'fixture inválida')
      return 2
    }

    const catalogo = atlas
      ? atlas.ids
      : unirBases(golden.filter((item) => item._fixture).map((item) => idsFromContext(item._fixture)))
    const base = referencia ? metrics.baseCitacaoDe(referencia) : metrics.baseCitacaoDe(catalogo)
    const conhecidos = metrics.conhecidosDe(referencia ?? catalogo)
    const avisosEsperados = metrics.avisosIdsEsperados(golden, referencia)
    const mockState = createMockState()
    mockState.precoEntradaMtok = precos.entrada
    mockState.precoSaidaMtok = precos.saida
    mockState.perfil = args.mockPerfil
    mockState.recusarChave = process.env.AION_EVAL_MOCK_RECUSAR_CHAVE === '1'
    for (const item of golden) {
      if (item.mock_resposta) mockState.respostas.set(item.pergunta, item.mock_resposta)
      mockState.expectativas.set(item.pergunta, item.expectativa)
    }

    restoreFetch = installFetchGuard(args.modo, contagem)
    if (args.modo === 'mock') {
      mock = await startMock(mockState)
      process.env.OPENROUTER_URL = mock.url
      process.env.OPENROUTER_KEY_URL = mock.keyUrl
      process.env.OPENROUTER_API_KEY = MOCK_API_KEY
    } else {
      process.env.OPENROUTER_URL = OPENROUTER_URL
      process.env.OPENROUTER_KEY_URL = OPENROUTER_KEY_URL
    }
    process.env.CHAT_DB = 'memory'
    process.env.JWT_SECRET = JWT_SECRET
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.CHAT_DAILY_BUDGET_USD = '3'
    delete process.env.CHAT_EXPOSE_STATE

    app = await startApp(handler.handleChatRequest)
    const token = await signJwt(JWT_SECRET, USER_ID)
    const perguntas = []
    for (const item of golden) {
      perguntas.push(await avaliarPergunta({
        item, args, app, token, state, atlas, base, conhecidos, mockState, core, precos, handler,
        modelo: args.modelo,
      }))
    }
    const origemDivergencia = atlas ? atlas.ids : catalogo
    const resultado = montarResultado({
      args,
      precos,
      limiares,
      perguntas,
      baseModo: referencia ? 'ids_base' : (atlas ? 'sync' : 'fixture_ou_recorte'),
      contagem,
      referencia,
      divergencia: referencia
        ? { origem: atlas ? 'pglite' : 'recorte', tipos: metrics.divergenciaIds(origemDivergencia, referencia) }
        : null,
      avisosEsperados,
    })
    const stamp = new Date().toISOString().replace(/[:.]/g, '')
    const jsonPath = join(outDir, `resultados_${stamp}.json`)
    const mdPath = join(outDir, `resumo_${stamp}.md`)
    const redigido = (value) => redigir(
      typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      core.redactSecrets,
    )
    await writeFile(jsonPath, redigido(resultado))
    await writeFile(mdPath, redigido(renderMd(resultado)))
    console.log(`resultados ${jsonPath}`)
    console.log(`resumo ${mdPath}`)
    console.log(`saida ${resultado.codigo_saida}`)
    return resultado.codigo_saida
  } finally {
    if (envSalvo) restaurarAmbiente(envSalvo)
    restaurarStderr()
    restoreContext()
    restoreFetch()
    if (app) await closeServer(app)
    if (mock) await mock.close()
    if (atlas) await atlas.close()
    handler.resetMemoryForTests()
  }
}

async function avaliarPergunta({ item, args, app, token, state, atlas, base, conhecidos, mockState, core, precos, handler, modelo }) {
  if (!atlas && !item._fixture) {
    return {
      id: item.id,
      pergunta: item.pergunta,
      expectativa: item.expectativa,
      categoria: item.categoria,
      notas: item.notas,
      recorte_indisponivel: true,
      repeticoes: [],
    }
  }
  const repeticoes = []
  for (let i = 0; i < args.repeticoes; i++) {
    handler.resetMemoryForTests()
    state.lastContext = null
    state.fixture = atlas ? null : item._fixture
    mockState.ultima = null
    const corrida = await umaCorrida({ item, modelo, app, token, state, core, precos, base, conhecidos, mockState })
    repeticoes.push(corrida)
  }
  return {
    id: item.id,
    pergunta: item.pergunta,
    expectativa: item.expectativa,
    notas: item.notas,
    categoria: item.categoria,
    voz_aion_obrigatoria: metrics.vozExigida({
      categoria: item.categoria,
      pergunta: item.pergunta,
      explicita: item.voz_aion_obrigatoria,
    }),
    recorte_indisponivel: false,
    fixture_ignorada: Boolean(atlas && item.contexto_fixture),
    repeticoes,
  }
}

async function umaCorrida({ item, modelo, app, token, state, core, precos, base, conhecidos, mockState }) {
  const t0 = performance.now()
  const response = await fetch(`http://127.0.0.1:${app.port}/`, {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:5173',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      mensagem: item.pergunta,
      contexto: { entidades: item.entidades_contexto },
      modelo,
    }),
  })
  const lido = await lerCorpo(response, t0)
  const events = parseSse(lido.rawBody)
  const finalEvent = [...events].reverse().find((event) => event.event === 'final')
  const errorEvent = [...events].reverse().find((event) => event.event === 'error')
  const finalData = finalEvent?.data && typeof finalEvent.data === 'object' ? finalEvent.data : null
  let erro = errorEvent?.data && typeof errorEvent.data === 'object' ? errorEvent.data : null
  if (!finalData && !erro) erro = { code: 'sem_evento', message: `HTTP ${response.status} sem final nem error` }
  const textoDelta = textoDoFluxo(events)
  const captura = mockState?.ultima?.pergunta === item.pergunta ? mockState.ultima : null
  const textoMock = captura?.texto ?? ''
  const brutoDelta = parseModelJson(textoDelta)
  const brutoMock = parseModelJson(textoMock)
  const bruto = brutoMock ?? brutoDelta
  const recorte = recorteEnviado(captura, state, core)
  const recorteIdx = metrics.indexarRecorte(recorte)
  const citados = metrics.unirCitados(
    metrics.idsDoModelo(brutoMock),
    metrics.idsDoModelo(brutoDelta),
    metrics.idsDoFinal(finalData),
  )
  const nomes = metrics.nomesDeContexto(recorte)
  const invalidos = baseVazia(base)
    ? []
    : metrics.citacoesInvalidas(citados, base, {
      nomes,
      preferir: new Set(nomes.map((item) => item.id)),
    })
  const avisos = Array.isArray(finalData?.avisos) ? finalData.avisos : []
  const groundingPartes = [brutoMock, brutoDelta]
    .filter(Boolean)
    .map((modelo) => metrics.avaliarGrounding({ bruto: modelo, finalData, recorte: recorteIdx, avisos }))
  if (groundingPartes.length === 0) {
    groundingPartes.push(metrics.avaliarGrounding({ bruto: null, finalData, recorte: recorteIdx, avisos }))
  }
  const grounding = juntarGrounding(groundingPartes)
  const classe = metrics.classificarAvaliacao({
    httpStatus: response.status,
    erroCode: typeof erro?.code === 'string' ? erro.code : null,
    textosModelo: [textoMock, textoDelta],
    bruto,
  })
  const texto = metrics.textoResposta({ bruto, finalData, erro })
  const recusa = metrics.detectarRecusa({ bruto, finalData, erro, texto })
  const usage = finalData?.usage && typeof finalData.usage === 'object' ? finalData.usage : null
  const tokensIn = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : metrics.estimarTokens(item.pergunta.length)
  const tokensOut = typeof usage?.completion_tokens === 'number'
    ? usage.completion_tokens
    : metrics.estimarTokens((textoMock || textoDelta || texto).length)
  const estimado = !(usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number')
  const usdCalculado = metrics.custoUsd(tokensIn, tokensOut, precos.entrada, precos.saida)
  const usdReal = typeof finalData?.custo_real === 'number' ? finalData.custo_real : null
  const usd = usdReal ?? usdCalculado
  const conjunto = metrics.citadosComoConjunto(citados)
  const relCitadas = new Set([...citados.relacoes, ...citados.bases])
  const rubricas = classe.avaliavel
    ? metrics.avaliarRubricas({
      texto,
      citados: conjunto,
      deve: item.deve_conter,
      naoDeve: item.nao_deve_conter,
      conhecidos,
    })
    : rubricaNaoAvaliada()
  const semLigacao = metrics.avaliarSemLigacao({
    expectativa: item.expectativa,
    texto,
    bruto,
    finalData,
    erro,
    avisos,
    arestas: metrics.arestasDe(state.lastContext ?? recorte),
    entidadesEsperadas: idsDeEntidades(item.entidades_esperadas),
  })
  const vozObrigatoria = metrics.vozExigida({
    categoria: item.categoria,
    pergunta: item.pergunta,
    explicita: item.voz_aion_obrigatoria,
  })
  return {
    http_status: response.status,
    latencia_ms: round1(lido.latenciaMs),
    eventos: events.map((event) => event.event),
    erro: erro ? { code: erro.code ?? null, message: erro.message ?? '' } : null,
    sem_base_bruto: bruto?.sem_base === true,
    recusa_fora_da_base: recusa,
    avaliavel: classe.avaliavel,
    codigo_nao_avaliavel: classe.codigo,
    grounding: { ...grounding, avaliavel: classe.avaliavel },
    citacoes: { ids_invalidos: invalidos },
    recall_entidades: classe.avaliavel
      ? metrics.recallIds(idsDeEntidades(item.entidades_esperadas), conjunto)
      : { recall: null, encontrados: [], faltaram: [] },
    recall_fontes: classe.avaliavel
      ? metrics.recallIds(item.fontes_esperadas, conjunto)
      : { recall: null, encontrados: [], faltaram: [] },
    recall_conexoes: classe.avaliavel
      ? metrics.recallIds(item.conexoes_esperadas, relCitadas)
      : { recall: null, encontrados: [], faltaram: [] },
    conter: rubricas,
    sem_ligacao: classe.avaliavel
      ? semLigacao
      : { aplicavel: false, ok: null, reconhece: null, afirma_relacao: false, relacoes: [], afirma_texto: false },
    pt_br: classe.avaliavel ? metrics.notaPtBr({ bruto, finalData, erro }) : null,
    voz: classe.avaliavel ? metrics.avaliarVoz({ bruto, finalData, erro, obrigatoria: vozObrigatoria }) : null,
    custo: classe.avaliavel ? {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      estimado,
      usd_calculado: usdCalculado,
      usd_real: usdReal,
      usd,
      brl: metrics.roundUsd(usd * precos.cambio),
    } : null,
    recorte: resumirRecorte(state.lastContext, recorte),
    final: finalData ? {
      blocos: finalData.blocos ?? [],
      fontes: finalData.fontes ?? [],
      entidades: finalData.entidades ?? [],
      avisos: finalData.avisos ?? [],
      custo_real: finalData.custo_real ?? null,
    } : null,
  }
}

function recorteEnviado(captura, state, core) {
  const parsed = captura?.system ? parseRecorte(captura.system) : null
  if (parsed) return parsed
  if (state.lastContext) {
    try {
      return JSON.parse(core.boundContextJson(state.lastContext))
    } catch {
      return state.lastContext
    }
  }
  return { raizes: [], entidades: [], relacoes: [], fontes: [] }
}

function resumirRecorte(completo, enviado) {
  const raizes = (completo?.raizes ?? enviado?.raizes ?? []).map((item) => item?.id).filter(Boolean)
  const links = completo?.ligacoes_entre_raizes ?? enviado?.ligacoes_entre_raizes ?? []
  return {
    raizes,
    n_entidades: (completo?.entidades ?? []).length,
    n_relacoes: (completo?.relacoes ?? []).length,
    n_fontes: (completo?.fontes ?? []).length,
    ligacoes: links.length,
    primeira_relacao: completo?.relacoes?.[0]?.id ?? enviado?.relacoes?.[0]?.id ?? null,
    truncado: Boolean(completo?.limites?.truncado || enviado?.truncado),
  }
}

function juntarGrounding(partes) {
  return {
    quebrado: partes.some((item) => item.quebrado),
    motivos: [...new Set(partes.flatMap((item) => item.motivos))],
    ids_fora_do_recorte: partes.flatMap((item) => item.ids_fora_do_recorte),
    citacao_removida: partes.reduce((max, item) => Math.max(max, item.citacao_removida), 0),
  }
}

function montarResultado({ args, precos, limiares, perguntas, baseModo, contagem, referencia, divergencia, avisosEsperados }) {
  const corridas = perguntas.flatMap((item) => (item.repeticoes ?? []).map((run) => ({ item, run })))
  const avaliadas = corridas.filter(({ run }) => run.avaliavel)
  const pares = avaliadas
    .filter(({ item }) => item.expectativa !== 'sem_ligacao')
    .map(({ item, run }) => ({
      esperado: item.expectativa === 'fora_da_base',
      detectado: run.recusa_fora_da_base === true,
    }))
  const fora = metrics.precisaoRevocacao(pares)
  const semLigacaoCorridas = avaliadas.filter(({ item }) => item.expectativa === 'sem_ligacao')
  const semLigacaoOk = semLigacaoCorridas.filter(({ run }) => run.sem_ligacao?.ok === true)
  const documentadas = perguntas.filter((item) => (
    item.expectativa === 'documentado'
    && !item.recorte_indisponivel
    && item.repeticoes.length > 0
    && item.repeticoes.every((run) => run.avaliavel)
  ))
  const groundingOk = documentadas.filter((item) => item.repeticoes.every((run) => !run.grounding.quebrado))
  const latencias = corridas.map(({ run }) => run.latencia_ms)
  const custos = avaliadas.map(({ run }) => run.custo).filter(Boolean)
  const comRubrica = corridas.filter(({ run }) => run.avaliavel && run.conter?.nao_avaliado !== true)
  const porClasse = metrics.contarClassesCitacao(corridas.flatMap(({ run }) => run.citacoes?.ids_invalidos ?? []))
  const agregado = {
    n_perguntas: perguntas.length,
    n_corridas: corridas.length,
    avaliaveis: avaliadas.length,
    nao_avaliaveis: corridas.length - avaliadas.length,
    grounding_documentado: documentadas.length === 0 ? null : groundingOk.length / documentadas.length,
    citacoes_invalidas: porClasse.inventado + porClasse.formato,
    citacoes_por_classe: porClasse,
    fora_da_base: fora,
    recall_entidades_medio: metrics.media(avaliadas.map(({ run }) => run.recall_entidades?.recall)),
    recall_fontes_medio: metrics.media(avaliadas.map(({ run }) => run.recall_fontes?.recall)),
    recall_conexoes_medio: metrics.media(avaliadas.map(({ run }) => run.recall_conexoes?.recall)),
    sem_ligacao: {
      n: semLigacaoCorridas.length,
      ok: semLigacaoOk.length,
      taxa: semLigacaoCorridas.length === 0 ? null : semLigacaoOk.length / semLigacaoCorridas.length,
    },
    rubricas: {
      auto_ok: comRubrica.reduce((sum, { run }) => sum + (run.conter.auto_ok?.length ?? 0), 0),
      auto_falha: comRubrica.reduce((sum, { run }) => sum + (run.conter.auto_falha?.length ?? 0), 0),
      manual: comRubrica.reduce((sum, { run }) => sum + (run.conter.rubrica_manual?.length ?? 0), 0),
    },
    pt_br_medio: metrics.media(avaliadas.map(({ run }) => run.pt_br?.nota)),
    latencia_ms: {
      p50: metrics.percentilLinear(latencias, 0.5),
      p95: metrics.percentilLinear(latencias, 0.95),
      metodo: LATENCIA_METODO,
    },
    custo: {
      usd_medio: metrics.media(custos.map((custo) => custo.usd)),
      usd_calculado_medio: metrics.media(custos.map((custo) => custo.usd_calculado)),
      usd_real_medio: metrics.media(custos.map((custo) => custo.usd_real).filter((n) => n != null)),
      custo_real_usd: somarReais(avaliadas),
      brl_medio: metrics.media(custos.map((custo) => custo.brl)),
      tokens_in: custos.reduce((sum, custo) => sum + custo.tokens_in, 0),
      tokens_out: custos.reduce((sum, custo) => sum + custo.tokens_out, 0),
    },
    recorte_indisponivel: perguntas.filter((item) => item.recorte_indisponivel).map((item) => item.id),
  }
  const avisosLimiar = calcularAlertas(agregado, limiares, corridas, avisosEsperados ?? [])
  agregado.metricas_sem_amostra = avisosLimiar.metricas_sem_amostra
  const motivosQualidade = []
  const motivosInfra = []
  for (const { item, run } of corridas) {
    if (!run.avaliavel) {
      motivosInfra.push(`${item.id}: avaliacao_nao_ocorreu (${run.codigo_nao_avaliavel})`)
      continue
    }
    const invalidos = run.citacoes?.ids_invalidos ?? []
    if (invalidos.some((cit) => cit.classe === 'inventado')) motivosQualidade.push(`${item.id}: id inventado`)
    if (invalidos.some((cit) => cit.classe === 'formato')) motivosQualidade.push(`${item.id}: citação com formato inválido`)
    if (item.expectativa === 'documentado' && run.grounding.quebrado) motivosQualidade.push(`${item.id}: grounding quebrado`)
  }
  const codigoSaida = motivosQualidade.length ? 1 : (motivosInfra.length ? 3 : 0)
  const motivos = [...motivosQualidade, ...motivosInfra]
  return {
    gerado_em: new Date().toISOString(),
    modo: args.modo,
    modelo: args.modelo,
    mock_perfil: args.mockPerfil,
    juiz: { solicitado: args.juiz != null, ativo: false, status: 'desativado' },
    cambio_brl_usado: precos.cambio,
    precos: {
      entrada_usd_por_mtok: precos.entrada,
      saida_usd_por_mtok: precos.saida,
      fonte: precos.fonte,
    },
    base_citacao: baseModo,
    referencia_ids: referencia
      ? {
        caminho: referencia.caminho,
        contagens: referencia.contagens,
        _meta: referencia.meta,
      }
      : null,
    divergencia_ids: divergencia,
    avisos_golden: avisosEsperados ?? [],
    aviso_base: avisoBase(baseModo),
    injecao_recorte: 'MemoryChatDb.prototype.chatContext delega ao PGlite (public.chat_context) ou à fixture. O HTTP passa por handleChatRequest, prepareChat, streamPrepared e sanitizeAnswer.',
    sse: 'O servidor emite delta. O harness trata delta como o fluxo de tokens e também aceita o evento token. A citação vale no texto bruto do modelo e no final: id ausente na base em qualquer um dos dois é inválida.',
    rede: {
      fetches_bloqueados: contagem.bloqueados,
      fetches_supabase: contagem.supabase,
      hosts: [...contagem.hosts],
    },
    limiares,
    alertas: avisosLimiar.alertas,
    agregado,
    codigo_saida: codigoSaida,
    motivos_saida: motivos,
    perguntas: perguntas.map(enxugarPergunta),
  }
}

function enxugarPergunta(item) {
  return {
    id: item.id,
    pergunta: item.pergunta,
    expectativa: item.expectativa,
    categoria: item.categoria ?? '',
    notas: item.notas,
    voz_aion_obrigatoria: item.voz_aion_obrigatoria ?? false,
    recorte_indisponivel: item.recorte_indisponivel,
    fixture_ignorada: item.fixture_ignorada ?? false,
    citacoes_por_classe: metrics.contarClassesCitacao(
      (item.repeticoes ?? []).flatMap((run) => run.citacoes?.ids_invalidos ?? []),
    ),
    repeticoes: item.repeticoes ?? [],
  }
}

function rubricaNaoAvaliada() {
  return {
    nao_avaliado: true,
    passa: null,
    faltou: [],
    sobrou: [],
    auto_ok: [],
    auto_falha: [],
    rubrica_manual: [],
  }
}

function calcularAlertas(agregado, limiares, corridas = [], avisosEsperados = []) {
  const alertas = []
  const metricas_sem_amostra = []
  const semAmostra = (nome, valor) => {
    if (valor == null || Number.isNaN(valor)) {
      metricas_sem_amostra.push(nome)
      return true
    }
    return false
  }
  const abaixo = (nome, valor, limiar) => {
    if (typeof limiar !== 'number') return
    if (semAmostra(nome, valor)) return
    if (valor + 1e-12 < limiar) alertas.push(`${nome}: ${fmt(valor)} abaixo de ${limiar}`)
  }
  const acima = (nome, valor, limiar) => {
    if (typeof limiar !== 'number') return
    if (semAmostra(nome, valor)) return
    if (valor > limiar + 1e-12) alertas.push(`${nome}: ${fmt(valor)} acima de ${limiar}`)
  }
  abaixo('grounding_documentado', agregado.grounding_documentado, limiares.grounding_documentado)
  abaixo('fora_da_base_revocacao', agregado.fora_da_base.revocacao, limiares.fora_da_base_revocacao)
  abaixo('fora_da_base_precisao', agregado.fora_da_base.precisao, limiares.fora_da_base_precisao)
  abaixo('entidades', agregado.recall_entidades_medio, limiares.entidades)
  abaixo('fontes', agregado.recall_fontes_medio, limiares.fontes)
  abaixo('pt_br', agregado.pt_br_medio, limiares.pt_br)
  acima('p95_ms', agregado.latencia_ms.p95, limiares.p95_ms)
  acima('p50_ms', agregado.latencia_ms.p50, limiares.p50_ms)
  acima('custo_medio_usd', agregado.custo.usd_medio, limiares.custo_medio_usd)
  if (agregado.sem_ligacao.n === 0) metricas_sem_amostra.push('sem_ligacao')
  else abaixo('sem_ligacao', agregado.sem_ligacao.taxa, limiares.sem_ligacao)
  if (agregado.recorte_indisponivel.length) {
    alertas.push(`recorte_indisponivel: ${agregado.recorte_indisponivel.join(', ')}`)
  }
  for (const { item, run } of corridas) {
    if (run.avaliavel && item.expectativa !== 'documentado' && run.grounding?.quebrado) {
      alertas.push(`${item.id}: grounding quebrado em ${item.expectativa} (registro, não altera a saída)`)
    }
    if (run.voz?.voz_aion_obrigatoria && run.voz.cumpre_obrigatoria === false) {
      alertas.push(`${item.id}: voz AION incompleta (registro, não altera a saída)`)
    }
  }
  if (avisosEsperados.length) alertas.push(`id_esperado_inexistente: ${avisosEsperados.length}`)
  return { alertas, metricas_sem_amostra }
}

function renderMd(resultado) {
  const a = resultado.agregado
  const linhas = [
    `# Resumo da avaliação`,
    ``,
    `Modo ${resultado.modo}, modelo ${resultado.modelo}, perfil do mock ${resultado.mock_perfil}. Câmbio usado: ${resultado.cambio_brl_usado}.`,
    `Base de citação: ${resultado.base_citacao}.`,
    resultado.aviso_base ? resultado.aviso_base : '',
    `Juiz: ${resultado.juiz?.status ?? 'desativado'}.`,
    `Saída ${resultado.codigo_saida}.`,
    fraseMotivoCitacao(resultado),
    ``,
    `## Agregado`,
    ``,
    `- Corridas avaliáveis: ${a.avaliaveis}. Não avaliáveis: ${a.nao_avaliaveis}.`,
    `- Grounding em perguntas documentado: ${fmt(a.grounding_documentado)}`,
    `- Citações inválidas: ${a.citacoes_invalidas} (${metrics.textoContagemCitacao(a.citacoes_por_classe)})`,
    `- Fora da base: precisão ${fmt(a.fora_da_base.precisao)}, revocação ${fmt(a.fora_da_base.revocacao)} (tp ${a.fora_da_base.tp}, fp ${a.fora_da_base.fp}, fn ${a.fora_da_base.fn}, tn ${a.fora_da_base.tn}). sem_ligacao não entra nesta conta.`,
    `- sem_ligacao: ${a.sem_ligacao.ok}/${a.sem_ligacao.n} (taxa ${fmt(a.sem_ligacao.taxa)})`,
    `- Recall médio de entidades: ${fmt(a.recall_entidades_medio)}`,
    `- Recall médio de fontes: ${fmt(a.recall_fontes_medio)}`,
    `- Recall médio de conexões: ${fmt(a.recall_conexoes_medio)}`,
    `- Rubricas automáticas: ok ${a.rubricas.auto_ok}, falha ${a.rubricas.auto_falha}, manuais ${a.rubricas.manual}`,
    `- Nota média de pt-BR: ${fmt(a.pt_br_medio)}`,
    `- Latência p50 ${fmt(a.latencia_ms.p50)} ms, p95 ${fmt(a.latencia_ms.p95)} ms. ${a.latencia_ms.metodo}`,
    `- Custo médio US$ ${fmtUsd(a.custo.usd_medio)} (R$ ${fmtUsd(a.custo.brl_medio)}). custo_real_usd somado ${fmtUsd(a.custo.custo_real_usd)}. Tokens de entrada ${a.custo.tokens_in}, de saída ${a.custo.tokens_out}.`,
    `- Métricas sem amostra: ${(a.metricas_sem_amostra ?? []).join(', ') || 'nenhuma'}.`,
    ``,
    `## Alertas`,
    ``,
    ...(resultado.alertas.length ? resultado.alertas.map((item) => `- ${item}`) : ['- Nenhum.']),
    ``,
    ...renderDivergencia(resultado),
    `## Perguntas`,
    ``,
  ]
  for (const item of resultado.perguntas) {
    linhas.push(`### ${item.id}`)
    linhas.push('')
    linhas.push(`Expectativa ${item.expectativa}. Categoria ${item.categoria || 'nenhuma'}. ${item.recorte_indisponivel ? 'Recorte indisponível.' : ''}`)
    if (item.citacoes_por_classe) linhas.push(`Citações: ${metrics.textoContagemCitacao(item.citacoes_por_classe)}.`)
    if (item.notas) linhas.push(item.notas)
    for (const [index, run] of (item.repeticoes ?? []).entries()) {
      const sl = !run.avaliavel
        ? 'nao_avaliado'
        : (run.sem_ligacao?.aplicavel ? (run.sem_ligacao.ok ? 'ok' : 'falha') : 'n/a')
      const voz = run.voz
        ? `fato ${run.voz.fato ? 'sim' : 'não'}, inferência ${run.voz.inferencia ? 'sim' : 'não'}, em aberto ${run.voz.aberto ? 'sim' : 'não'}, mistura ${run.voz.mistura_especulativa_em_documentado ? 'sim' : 'não'}, obrigatória ${run.voz.voz_aion_obrigatoria ? 'sim' : 'não'}`
        : 'nao_avaliado'
      const groundingTxt = run.avaliavel ? (run.grounding.quebrado ? 'quebrado' : 'ok') : 'nao_avaliado'
      const rubrica = (!run.avaliavel || run.conter?.nao_avaliado)
        ? 'nao_avaliado'
        : `auto ok ${run.conter.auto_ok?.length ?? 0} falha ${run.conter.auto_falha?.length ?? 0} manual ${run.conter.rubrica_manual?.length ?? 0}`
      linhas.push(`- Corrida ${index + 1}: HTTP ${run.http_status}, ${run.latencia_ms} ms, grounding ${groundingTxt}, inválidas ${run.citacoes.ids_invalidos.length}, entidades ${fmt(run.recall_entidades?.recall)}, fontes ${fmt(run.recall_fontes?.recall)}, conexões ${fmt(run.recall_conexoes?.recall)}, sem_ligacao ${sl}, pt-BR ${fmt(run.pt_br?.nota)}, rubricas ${rubrica}, recusa ${run.recusa_fora_da_base ? 'sim' : 'não'}, US$ ${fmtUsd(run.custo?.usd)}.`)
      linhas.push(`  Voz: ${voz}. Raízes: ${(run.recorte.raizes ?? []).join(', ') || 'nenhuma'}.`)
      if (run.conter.faltou?.length) linhas.push(`  Faltou: ${run.conter.faltou.join(' | ')}`)
      if (run.conter.sobrou?.length) linhas.push(`  Sobrou: ${run.conter.sobrou.join(' | ')}`)
      if (run.erro) linhas.push(`  Erro ${run.erro.code}: ${run.erro.message}`)
    }
    linhas.push('')
  }
  if (resultado.motivos_saida.length) {
    linhas.push(`## Motivos da saída ${resultado.codigo_saida}`, '')
    for (const motivo of resultado.motivos_saida) linhas.push(`- ${motivo}`)
    linhas.push('')
  }
  return linhas.filter((line) => line !== undefined).join('\n')
}

function resolverPrecos(args, core) {
  const modelo = args.modelo
  const porToken = core.CHAT_OUTPUT_USD_PER_TOKEN[modelo]
  const saidaPadrao = porToken * 1_000_000
  const entrada = args.precoEntrada ?? 0
  const saida = args.precoSaida ?? saidaPadrao
  const override = args.precoEntrada != null || args.precoSaida != null
  const fonte = override
    ? `sobrescrito na CLI; padrão de saída lido de CHAT_OUTPUT_USD_PER_TOKEN.${modelo} (${saidaPadrao}). CHAT_COST_ESTIMATE_USD.${modelo} = ${core.CHAT_COST_ESTIMATE_USD[modelo]} é a reserva, não o preço de entrada.`
    : `CHAT_OUTPUT_USD_PER_TOKEN.${modelo} convertido para US$ por milhão de tokens de saída. Entrada padrão 0: o núcleo não publica preço de entrada. CHAT_COST_ESTIMATE_USD.${modelo} = ${core.CHAT_COST_ESTIMATE_USD[modelo]}.`
  return { entrada, saida, cambio: args.cambio, fonte }
}

async function carregarFixtures(golden, atlas) {
  for (const item of golden) {
    if (!item.contexto_fixture || atlas) {
      item._fixture = null
      continue
    }
    const path = expandHome(item.contexto_fixture)
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      throw new GoldenError(`golden inválido: pergunta ${item.id}: fixture ausente`)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new GoldenError(`golden inválido: pergunta ${item.id}: fixture não é JSON`)
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entidades) || !Array.isArray(parsed.relacoes)) {
      throw new GoldenError(`golden inválido: pergunta ${item.id}: fixture sem entidades e relacoes`)
    }
    item._fixture = parsed
  }
}

function installContext(MemoryChatDb, state) {
  const original = MemoryChatDb.prototype.chatContext
  MemoryChatDb.prototype.chatContext = async function chatContext(entityIds, query) {
    if (state.fixture) {
      const ctx = structuredClone(state.fixture)
      state.lastContext = ctx
      return ctx
    }
    if (!state.atlas) {
      const empty = state.empty()
      state.lastContext = empty
      return empty
    }
    const ctx = await state.atlas.chatContext(entityIds ?? [], query ?? null)
    state.lastContext = ctx
    return ctx
  }
  return () => {
    MemoryChatDb.prototype.chatContext = original
  }
}

function installFetchGuard(modo, contagem) {
  const orig = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input instanceof URL ? input.href : input)
    let host = ''
    let protocol = ''
    try {
      const parsed = new URL(url, 'http://127.0.0.1')
      host = parsed.hostname
      protocol = parsed.protocol
    } catch {
      host = ''
    }
    const local = host === '127.0.0.1' || host === 'localhost' || protocol === 'file:' || protocol === 'data:' || protocol === 'blob:'
    const openrouter = modo === 'openrouter' && (host === 'openrouter.ai' || host.endsWith('.openrouter.ai'))
    if (!local && !openrouter) {
      contagem.bloqueados += 1
      if (host === 'supabase.co' || host.endsWith('.supabase.co')) contagem.supabase += 1
      throw new Error(`rede bloqueada para ${host || protocol || 'destino'}`)
    }
    if (host) contagem.hosts.add(host)
    return orig(input, init)
  }
  return () => {
    globalThis.fetch = orig
  }
}

async function startApp(handleChatRequest) {
  const server = createServer(async (req, res) => {
    try {
      const port = server.address().port
      const request = await nodeToRequest(req, port)
      const response = await handleChatRequest(request)
      await writeFetchResponse(res, response)
    } catch (error) {
      res.statusCode = 500
      res.end(JSON.stringify({ code: 'rede', message: 'Falha interna.' }))
      console.error(filtroSegredos(error instanceof Error ? error.message : 'falha interna'))
    }
  })
  await listen(server)
  return Object.assign(server, { port: server.address().port })
}

function nodeToRequest(req, port) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null) continue
        headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
      }
      const init = { method: req.method, headers }
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body
      resolve(new Request(`http://127.0.0.1:${port}${req.url}`, init))
    })
    req.on('error', reject)
  })
}

async function writeFetchResponse(res, response) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return
    res.setHeader(key, value)
  })
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
  } finally {
    res.end()
  }
}

async function lerCorpo(response, t0) {
  if (!response.body) return { rawBody: '', latenciaMs: performance.now() - t0 }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let end = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    if (end == null && terminalCompleto(buf)) end = performance.now()
  }
  buf += decoder.decode()
  if (end == null) end = performance.now()
  return { rawBody: buf, latenciaMs: end - t0 }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function signJwt(secret, sub) {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64(JSON.stringify({
    sub,
    role: 'authenticated',
    aud: 'authenticated',
    iss: `${SUPABASE_URL}/auth/v1`,
    exp: Math.floor(Date.now() / 1000) + 600,
  }))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)))
  let bin = ''
  for (const byte of sig) bin += String.fromCharCode(byte)
  const signature = btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return `${header}.${payload}.${signature}`
}

function b64(text) {
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function parseArgs(argv) {
  const out = {
    golden: null,
    modo: null,
    syncSql: process.env.ATLAS_SYNC_SQL || null,
    out: null,
    modelo: 'basico',
    precoEntrada: null,
    precoSaida: null,
    cambio: 5.4,
    repeticoes: 1,
    idsBase: null,
    mockPerfil: 'limpo',
    juiz: null,
  }
  const flags = new Map([
    ['--golden', 'golden'],
    ['--modo', 'modo'],
    ['--sync-sql', 'syncSql'],
    ['--out', 'out'],
    ['--modelo', 'modelo'],
    ['--preco-entrada-usd-por-mtok', 'precoEntrada'],
    ['--preco-saida-usd-por-mtok', 'precoSaida'],
    ['--cambio-brl', 'cambio'],
    ['--repeticoes', 'repeticoes'],
    ['--ids-base', 'idsBase'],
    ['--mock-perfil', 'mockPerfil'],
  ])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--juiz') {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out.juiz = next
        i += 1
      } else {
        out.juiz = 'off'
      }
      continue
    }
    const key = flags.get(flag)
    if (!key) throw new Error(`argumento inválido: ${flag}`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`argumento inválido: ${flag} sem valor`)
    out[key] = value
  }
  if (!out.golden) throw new Error('argumento inválido: falta --golden')
  if (out.modo !== 'mock' && out.modo !== 'openrouter') throw new Error('argumento inválido: --modo mock|openrouter')
  if (out.modelo !== 'basico' && out.modelo !== 'avancado') throw new Error('argumento inválido: --modelo basico|avancado')
  out.golden = resolve(expandHome(out.golden))
  if (out.syncSql) out.syncSql = resolve(expandHome(out.syncSql))
  if (out.out) out.out = resolve(expandHome(out.out))
  if (out.idsBase) out.idsBase = resolve(expandHome(out.idsBase))
  if (out.mockPerfil !== 'limpo' && out.mockPerfil !== 'ruim') {
    throw new Error('argumento inválido: --mock-perfil limpo|ruim')
  }
  out.repeticoes = Number(out.repeticoes)
  if (!Number.isInteger(out.repeticoes) || out.repeticoes < 1) throw new Error('argumento inválido: --repeticoes')
  out.cambio = Number(out.cambio)
  if (!Number.isFinite(out.cambio) || out.cambio <= 0) throw new Error('argumento inválido: --cambio-brl')
  if (out.precoEntrada != null) {
    out.precoEntrada = Number(out.precoEntrada)
    if (!Number.isFinite(out.precoEntrada) || out.precoEntrada < 0) throw new Error('argumento inválido: preço de entrada')
  }
  if (out.precoSaida != null) {
    out.precoSaida = Number(out.precoSaida)
    if (!Number.isFinite(out.precoSaida) || out.precoSaida < 0) throw new Error('argumento inválido: preço de saída')
  }
  return out
}

function unirBases(listas) {
  const entidades = new Set()
  const relacoes = new Set()
  const fontes = new Set()
  const casos = new Set()
  for (const item of listas) {
    for (const id of item.entidades ?? []) entidades.add(id)
    for (const id of item.relacoes ?? []) relacoes.add(id)
    for (const id of item.fontes ?? []) fontes.add(id)
    for (const id of item.casos ?? []) casos.add(id)
  }
  return { entidades, relacoes, fontes, casos }
}

function avisoBase(baseModo) {
  if (baseModo === 'ids_base') {
    return 'Citação válida usa --ids-base. Entidade vale se estiver em entidades ou casos. O sync, quando existe, só monta o recorte.'
  }
  if (baseModo === 'sync') return null
  return 'Sem sync SQL e sem --ids-base: citação válida usa os ids da fixture ou do recorte, não o atlas inteiro.'
}

async function lerIdsBase(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error('ids-base inválido: arquivo ausente')
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('ids-base inválido: JSON inválido')
  }
  const referencia = metrics.normalizarIdsBase(data)
  referencia.caminho = path
  return referencia
}

function somarReais(corridas) {
  const reais = corridas
    .map(({ run }) => run.custo?.usd_real)
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
  if (reais.length === 0) return null
  return metrics.roundUsd(reais.reduce((sum, n) => sum + n, 0))
}

function renderDivergencia(resultado) {
  const div = resultado.divergencia_ids
  if (!div) return []
  const linhas = ['## Divergência de ids', '', `Origem comparada: ${div.origem}. Até 50 ids de cada lado ficam no JSON.`, '']
  for (const tipo of ['entidades', 'relacoes', 'fontes', 'casos']) {
    const lado = div.tipos[tipo]
    linhas.push(`- ${tipo}: só na origem ${lado.so_na_origem.n}, só na referência ${lado.so_na_referencia.n}`)
  }
  if (resultado.avisos_golden?.length) {
    linhas.push('', `Ids esperados ausentes na referência: ${resultado.avisos_golden.length}.`)
  }
  linhas.push('')
  return linhas
}

function baseVazia(base) {
  return base.entidades.size === 0 && base.relacoes.size === 0 && base.fontes.size === 0
}

function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function fileUrlToPath(url) {
  return fileURLToPath(url)
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function fmt(value) {
  if (value == null || Number.isNaN(value)) return 'indefinido'
  if (typeof value !== 'number') return String(value)
  return String(Math.round(value * 1000) / 1000)
}

function fmtUsd(value) {
  if (value == null || Number.isNaN(value)) return 'indefinido'
  return Number(value).toFixed(6)
}

const AMBIENTE_FIXO = ['CHAT_DB', 'JWT_SECRET', 'SUPABASE_URL', 'CHAT_DAILY_BUDGET_USD', 'CHAT_EXPOSE_STATE']

export function capturarAmbiente() {
  const saved = new Map()
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OPENROUTER_') || AMBIENTE_FIXO.includes(key)) saved.set(key, process.env[key])
  }
  return saved
}

export function restaurarAmbiente(saved) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OPENROUTER_') || AMBIENTE_FIXO.includes(key)) delete process.env[key]
  }
  for (const [key, value] of saved) {
    if (typeof value === 'string') process.env[key] = value
  }
}

function instalarFiltroStderr() {
  const original = console.error
  let ativo = true
  console.error = (...args) => {
    original.apply(console, args.map((item) => {
      if (typeof item === 'string') return filtroSegredos(item)
      if (item instanceof Error) return filtroSegredos(item.stack || item.message)
      return item
    }))
  }
  return () => {
    if (!ativo) return
    ativo = false
    console.error = original
  }
}

function fraseMotivoCitacao(resultado) {
  const motivos = resultado.motivos_saida ?? []
  const inventado = motivos.filter((item) => item.endsWith(': id inventado')).length
  const formato = motivos.filter((item) => item.endsWith(': citação com formato inválido')).length
  if (!inventado && !formato) return 'Nenhuma citação inválida motivou a saída.'
  const partes = []
  if (inventado) partes.push(`id inventado em ${inventado} corrida(s)`)
  if (formato) partes.push(`citação com formato inválido em ${formato} corrida(s)`)
  return `Citação que motivou a saída: ${partes.join('; ')}. As duas continuam bloqueantes (limiar de citação inválida = 0).`
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ''
if (import.meta.url === entry) {
  main().then((code) => {
    process.exit(code)
  }).catch((error) => {
    console.error(filtroSegredos(error instanceof Error ? error.message : 'falha'))
    process.exit(3)
  })
}
