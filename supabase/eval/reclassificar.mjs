// Reclassifica ids inválidos de um resultados_*.json já gravado.
// Não chama modelo, banco nem rede. Nomes, se precisarem, saem do SQL local.

import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as metrics from './metrics.mjs'
import { filtroSegredos } from './redact.mjs'

const NOTA_LITERAL = 'literal_id é formato sem id real: o literal id, ou vazio depois de normalizar. id_normalizado fica nulo.'

function installFetchGuard() {
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input instanceof URL ? input.href : input)
    throw new Error(`rede bloqueada para ${url}`)
  }
}

export function nomesDoSyncSql(sql) {
  const entradas = []
  let dentro = false
  for (const line of String(sql).split('\n')) {
    if (/^INSERT INTO entities\b/i.test(line)) {
      dentro = true
      continue
    }
    if (!dentro) continue
    const trimmed = line.trim()
    if (trimmed.startsWith('(')) {
      const strings = sqlStrings(trimmed)
      if (strings.length >= 2 && strings[0]) {
        entradas.push({
          id: strings[0],
          nome: strings[1],
          normalizado: strings[2] || '',
        })
      }
    }
    if (trimmed.endsWith(';')) dentro = false
  }
  return entradas
}

function sqlStrings(line) {
  const out = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "'") continue
    let j = i + 1
    let buf = ''
    while (j < line.length) {
      if (line[j] === "'" && line[j + 1] === "'") {
        buf += "'"
        j += 2
        continue
      }
      if (line[j] === "'") {
        j += 1
        break
      }
      buf += line[j]
      j += 1
    }
    out.push(buf)
    i = j - 1
  }
  return out
}

function avaliavelDe(run) {
  if (typeof run?.avaliavel === 'boolean') return run.avaliavel
  return run?.http_status == null || run.http_status === 200
}

function preferirDe(run) {
  const ids = new Set()
  for (const id of run?.recorte?.raizes ?? []) {
    if (typeof id === 'string' && id) ids.add(id)
  }
  for (const item of metrics.nomesDeContexto(run?.recorte)) ids.add(item.id)
  for (const item of metrics.nomesDeContexto(run?.final)) ids.add(item.id)
  return ids
}

function nomesDaCorrida(run, nomesSql) {
  return [
    ...nomesSql,
    ...metrics.nomesDeContexto(run?.recorte),
    ...metrics.nomesDeContexto(run?.final),
  ]
}

export function reclassificarResultado(resultado, base, nomesSql = []) {
  let removidas = 0
  const perguntas = (resultado.perguntas ?? []).map((item) => {
    const repeticoes = (item.repeticoes ?? []).map((run) => {
      const indice = metrics.indiceNomes(nomesDaCorrida(run, nomesSql), preferirDe(run))
      const ids = []
      for (const bruto of run.citacoes?.ids_invalidos ?? []) {
        const cls = metrics.classificarIdCitado(bruto.campo, bruto.id, base, indice)
        if (!cls) {
          removidas += 1
          continue
        }
        const saida = { campo: bruto.campo, id: bruto.id, ...cls }
        if (bruto.motivo) saida.motivo_anterior = bruto.motivo
        ids.push(saida)
      }
      return {
        avaliavel: avaliavelDe(run),
        codigo_nao_avaliavel: run.codigo_nao_avaliavel ?? null,
        grounding_quebrado: run.grounding?.quebrado === true,
        ids_invalidos: ids,
      }
    })
    return {
      id: item.id,
      expectativa: item.expectativa,
      citacoes_por_classe: metrics.contarClassesCitacao(repeticoes.flatMap((run) => run.ids_invalidos)),
      repeticoes,
    }
  })
  const porClasse = metrics.somarContagens(perguntas.map((item) => item.citacoes_por_classe))
  const motivosQualidade = []
  const motivosInfra = []
  for (const item of perguntas) {
    for (const run of item.repeticoes) {
      if (!run.avaliavel) {
        motivosInfra.push(`${item.id}: avaliacao_nao_ocorreu (${run.codigo_nao_avaliavel ?? 'desconhecido'})`)
        continue
      }
      if (run.ids_invalidos.some((cit) => cit.classe === 'inventado')) motivosQualidade.push(`${item.id}: id inventado`)
      if (run.ids_invalidos.some((cit) => cit.classe === 'formato')) motivosQualidade.push(`${item.id}: citação com formato inválido`)
      if (item.expectativa === 'documentado' && run.grounding_quebrado) motivosQualidade.push(`${item.id}: grounding quebrado`)
    }
  }
  const codigo = motivosQualidade.length ? 1 : (motivosInfra.length ? 3 : 0)
  return {
    origem_gerado_em: resultado.gerado_em ?? null,
    nota_literal_id: NOTA_LITERAL,
    nomes_carregados: nomesSql.length,
    removidas_por_reclassificacao: removidas,
    agregado: {
      n_perguntas: perguntas.length,
      n_corridas: perguntas.reduce((sum, item) => sum + item.repeticoes.length, 0),
      citacoes_invalidas: porClasse.inventado + porClasse.formato,
      citacoes_por_classe: porClasse,
    },
    codigo_saida: codigo,
    motivos_saida: [...motivosQualidade, ...motivosInfra],
    perguntas,
  }
}

function renderMd(relatorio) {
  const a = relatorio.agregado
  const linhas = [
    '# Reclassificação de citações',
    '',
    `Saída ${relatorio.codigo_saida}.`,
    fraseMotivo(relatorio.motivos_saida),
    NOTA_LITERAL,
    '',
    '## Agregado',
    '',
    `- Citações inválidas: ${a.citacoes_invalidas} (${metrics.textoContagemCitacao(a.citacoes_por_classe)})`,
    `- Removidas porque a classificação nova as considera válidas: ${relatorio.removidas_por_reclassificacao}.`,
    '',
    '## Por pergunta',
    '',
    '| pergunta | inventado | formato | prefixo_id | rotulo_exibicao | rotulo_ambiguo | json_vazado | campo_errado | literal_id |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const item of relatorio.perguntas) {
    const s = item.citacoes_por_classe.formato_por_subtipo
    const c = item.citacoes_por_classe
    linhas.push(`| ${item.id} | ${c.inventado} | ${c.formato} | ${s.prefixo_id} | ${s.rotulo_exibicao} | ${s.rotulo_ambiguo} | ${s.json_vazado} | ${s.campo_errado} | ${s.literal_id} |`)
  }
  const s = a.citacoes_por_classe.formato_por_subtipo
  const c = a.citacoes_por_classe
  linhas.push(`| agregado | ${c.inventado} | ${c.formato} | ${s.prefixo_id} | ${s.rotulo_exibicao} | ${s.rotulo_ambiguo} | ${s.json_vazado} | ${s.campo_errado} | ${s.literal_id} |`)
  linhas.push('')
  if (relatorio.motivos_saida.length) {
    linhas.push(`## Motivos da saída ${relatorio.codigo_saida}`, '')
    for (const motivo of relatorio.motivos_saida) linhas.push(`- ${motivo}`)
    linhas.push('')
  }
  return linhas.join('\n')
}

function fraseMotivo(motivos) {
  const inventado = motivos.filter((item) => item.endsWith(': id inventado')).length
  const formato = motivos.filter((item) => item.endsWith(': citação com formato inválido')).length
  if (!inventado && !formato) return 'Nenhuma citação inválida motivou a saída.'
  const partes = []
  if (inventado) partes.push(`id inventado em ${inventado} corrida(s)`)
  if (formato) partes.push(`citação com formato inválido em ${formato} corrida(s)`)
  return `Citação que motivou a saída: ${partes.join('; ')}. As duas continuam bloqueantes (limiar de citação inválida = 0).`
}

function parseArgs(argv) {
  const out = { resultados: null, idsBase: null, syncSql: null, out: null }
  const flags = new Map([
    ['--resultados', 'resultados'],
    ['--ids-base', 'idsBase'],
    ['--sync-sql', 'syncSql'],
    ['--out', 'out'],
  ])
  for (let i = 0; i < argv.length; i++) {
    const key = flags.get(argv[i])
    if (!key) throw new Error(`argumento inválido: ${argv[i]}`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`argumento inválido: ${argv[i - 1]} sem valor`)
    out[key] = value
  }
  if (!out.resultados) throw new Error('argumento inválido: falta --resultados')
  if (!out.idsBase) throw new Error('argumento inválido: falta --ids-base')
  if (!out.out) throw new Error('argumento inválido: falta --out')
  out.resultados = resolve(out.resultados)
  out.idsBase = resolve(out.idsBase)
  if (out.syncSql) out.syncSql = resolve(out.syncSql)
  out.out = resolve(out.out)
  return out
}

function stampDe(path) {
  const nome = basename(path)
  const match = /^resultados_(.+)\.json$/.exec(nome)
  if (match) return match[1]
  return new Date().toISOString().replace(/[:.]/g, '')
}

export async function main(argv = process.argv.slice(2)) {
  installFetchGuard()
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(filtroSegredos(error instanceof Error ? error.message : 'argumento inválido'))
    return 2
  }
  let resultado
  let referencia
  let nomesSql = []
  try {
    resultado = JSON.parse(await readFile(args.resultados, 'utf8'))
    referencia = metrics.normalizarIdsBase(JSON.parse(await readFile(args.idsBase, 'utf8')))
    if (args.syncSql) nomesSql = nomesDoSyncSql(await readFile(args.syncSql, 'utf8'))
  } catch (error) {
    console.error(filtroSegredos(error instanceof Error ? error.message : 'entrada inválida'))
    return 2
  }
  const base = metrics.baseCitacaoDe(referencia)
  const relatorio = reclassificarResultado(resultado, base, nomesSql)
  relatorio.origem = args.resultados
  relatorio.ids_base = args.idsBase
  relatorio.sync_sql = args.syncSql
  relatorio.gerado_em = new Date().toISOString()
  const stamp = stampDe(args.resultados)
  await mkdir(args.out, { recursive: true })
  const jsonPath = resolve(args.out, `reclassificado_${stamp}.json`)
  const mdPath = resolve(args.out, `reclassificado_${stamp}.md`)
  await writeFile(jsonPath, filtroSegredos(JSON.stringify(relatorio, null, 2)))
  await writeFile(mdPath, filtroSegredos(renderMd(relatorio)))
  console.log(`reclassificado ${jsonPath}`)
  console.log(`resumo ${mdPath}`)
  console.log(`saida ${relatorio.codigo_saida}`)
  return relatorio.codigo_saida
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
