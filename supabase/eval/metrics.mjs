// Métricas puras do harness. Sem rede e sem banco.

const PT_STOP = new Set(`que nao com para uma por em os as um se na no dos das de da do ao aos foi
como mais mas seu sua ele ela sobre este esta isso essa esse sao esta pela pelo tambem quando onde
quem qual sem ha uns umas pela pelo num numa ja ou ate seus suas pela nos nas entre desde porque`.split(/\s+/).filter(Boolean))

const EN_STOP = new Set(`the of and to in is that for with on by from this was are be or an it its
at not have has were which their they you your from into about than then them`.split(/\s+/).filter(Boolean))

const SPECULATIVE = /\b(provavelmente|talvez|sugere|sugerem|sugeria|possivelmente)\b/i
const REFUSAL_TEXT = /não há fonte|nao ha fonte|não encontrei|nao encontrei/i
const OPEN_TEXT = /não há fonte|nao ha fonte|em aberto|não encontrei|nao encontrei/i
const ACCENT = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/

export function roundUsd(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000
}

export function fold(text) {
  return String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Percentil inclusivo, o mesmo critério do Excel PERCENTILE.INC.
 * Ordena a amostra. A posição é p * (n - 1), com p em [0, 1].
 * O valor é a interpolação linear entre os dois vizinhos.
 * n = 0 devolve null. n = 1 devolve o único valor.
 */
export function percentilLinear(valores, p) {
  const nums = [...valores].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (nums.length === 0) return null
  if (nums.length === 1) return nums[0]
  const clamped = Math.min(1, Math.max(0, p))
  const pos = clamped * (nums.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return nums[lo]
  return nums[lo] + (nums[hi] - nums[lo]) * (pos - lo)
}

/** Positivo = esperado true. Precisão e revocação são null quando o denominador é zero. */
export function precisaoRevocacao(pares) {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  for (const par of pares) {
    if (par.esperado && par.detectado) tp += 1
    else if (!par.esperado && par.detectado) fp += 1
    else if (par.esperado && !par.detectado) fn += 1
    else tn += 1
  }
  return {
    tp, fp, fn, tn,
    precisao: tp + fp === 0 ? null : tp / (tp + fp),
    revocacao: tp + fn === 0 ? null : tp / (tp + fn),
  }
}

export function recallIds(esperados, citados) {
  const lista = Array.isArray(esperados) ? esperados : []
  if (lista.length === 0) return { recall: null, encontrados: [], faltaram: [] }
  const got = new Set(citados)
  const encontrados = lista.filter((id) => got.has(id))
  const faltaram = lista.filter((id) => !got.has(id))
  return { recall: encontrados.length / lista.length, encontrados, faltaram }
}

export function media(nums) {
  const ok = nums.filter((n) => typeof n === 'number' && Number.isFinite(n))
  if (ok.length === 0) return null
  return ok.reduce((sum, n) => sum + n, 0) / ok.length
}

export function estimarTokens(chars) {
  const n = Math.max(0, Number(chars) || 0)
  return Math.ceil(n / 4)
}

export function custoUsd(tokensIn, tokensOut, precoEntradaMtok, precoSaidaMtok) {
  const entrada = (Number(tokensIn) || 0) / 1_000_000 * Number(precoEntradaMtok)
  const saida = (Number(tokensOut) || 0) / 1_000_000 * Number(precoSaidaMtok)
  return roundUsd(entrada + saida)
}

export function indexarRecorte(ctx) {
  const entidades = new Set()
  const relacoes = new Set()
  const fontes = new Set()
  if (!ctx || typeof ctx !== 'object') return { entidades, relacoes, fontes }
  for (const item of [...(ctx.raizes ?? []), ...(ctx.entidades ?? [])]) {
    if (item?.id) entidades.add(item.id)
  }
  for (const rel of ctx.relacoes ?? []) {
    if (!rel || typeof rel !== 'object') continue
    if (rel.id) relacoes.add(rel.id)
    if (rel.origem) entidades.add(rel.origem)
    if (rel.destino) entidades.add(rel.destino)
    for (const fonte of rel.fontes ?? []) if (typeof fonte === 'string' && fonte) fontes.add(fonte)
  }
  for (const fonte of ctx.fontes ?? []) if (fonte?.id) fontes.add(fonte.id)
  for (const link of ctx.ligacoes_entre_raizes ?? []) {
    if (!link || typeof link !== 'object') continue
    if (link.de) entidades.add(link.de)
    if (link.para) entidades.add(link.para)
    if (link.via) entidades.add(link.via)
    for (const id of link.relacoes ?? []) if (id) relacoes.add(id)
  }
  return { entidades, relacoes, fontes }
}

function asStrings(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item)
}

export function idsDoModelo(raw) {
  const entidades = []
  const relacoes = []
  const fontes = []
  const bases = []
  if (!raw || typeof raw !== 'object') return { entidades, relacoes, fontes, bases }
  entidades.push(...asStrings(raw.entidades))
  relacoes.push(...asStrings(raw.relacoes))
  fontes.push(...asStrings(raw.fontes))
  for (const bloco of Array.isArray(raw.blocos) ? raw.blocos : []) {
    if (!bloco || typeof bloco !== 'object') continue
    if (bloco.tipo === 'inferencia') {
      bases.push(...asStrings(bloco.base))
      continue
    }
    entidades.push(...asStrings(bloco.entidades))
    relacoes.push(...asStrings(bloco.relacoes))
    fontes.push(...asStrings(bloco.fontes))
  }
  return { entidades, relacoes, fontes, bases }
}

export function idsDoFinal(finalData) {
  if (!finalData || typeof finalData !== 'object') return { entidades: [], relacoes: [], fontes: [], bases: [] }
  const fromBlocos = idsDoModelo(finalData)
  for (const item of finalData.entidades ?? []) {
    if (item && typeof item === 'object' && typeof item.id === 'string') fromBlocos.entidades.push(item.id)
    else if (typeof item === 'string') fromBlocos.entidades.push(item)
  }
  fromBlocos.fontes.push(...asStrings(finalData.fontes))
  return fromBlocos
}

const ID_FORMATO = /^[A-Za-z0-9_.:-]{1,120}$/

function formatoQuebrado(id) {
  return typeof id !== 'string' || !ID_FORMATO.test(id) || id.startsWith('id_') || id === 'id'
}

function idExisteNaBase(id, base) {
  return base.entidades.has(id)
    || base.relacoes.has(id)
    || base.fontes.has(id)
    || Boolean(base.casos?.has?.(id))
}

/** formato_quebrado ganha de campo_errado e de inexistente. As três continuam inválidas. */
function classificarIdInvalido(id, base) {
  if (formatoQuebrado(id)) return 'formato_quebrado'
  return idExisteNaBase(id, base) ? 'campo_errado' : 'inexistente'
}

export function citacoesInvalidas(citados, base) {
  const invalidos = []
  const push = (campo, id, ok) => {
    if (!formatoQuebrado(id) && ok) return
    invalidos.push({ campo, id, motivo: classificarIdInvalido(id, base) })
  }
  for (const id of citados.entidades) push('entidade', id, base.entidades.has(id))
  for (const id of citados.relacoes) push('relacao', id, base.relacoes.has(id))
  for (const id of citados.fontes) push('fonte', id, base.fontes.has(id))
  for (const id of citados.bases) {
    push('base', id, base.entidades.has(id) || base.relacoes.has(id))
  }
  const vistos = new Set()
  return invalidos.filter((item) => {
    const key = `${item.campo}|${item.id}`
    if (vistos.has(key)) return false
    vistos.add(key)
    return true
  })
}

const CODIGOS_NAO_AVALIAVEIS = new Set([
  'chave_recusada',
  'sem_login',
  'orcamento_esgotado',
  'rede',
  'sem_evento',
  'modelo_indisponivel',
  'modelo_ocupado',
  'limite_chave',
  'rate_limit',
])

/**
 * fora_da_base é resposta válida.
 * HTTP diferente de 200, os códigos de infra e o JSON do modelo que não parseia
 * ficam de fora da nota. codigo entra no motivo avaliacao_nao_ocorreu.
 */
export function classificarAvaliacao({ httpStatus, erroCode, textosModelo, bruto }) {
  if (erroCode === 'fora_da_base') return { avaliavel: true, codigo: null }
  if (typeof erroCode === 'string' && CODIGOS_NAO_AVALIAVEIS.has(erroCode)) {
    return { avaliavel: false, codigo: erroCode }
  }
  if (httpStatus !== 200) {
    const codigo = typeof erroCode === 'string' && erroCode ? erroCode : `http_${httpStatus}`
    return { avaliavel: false, codigo }
  }
  const textos = (Array.isArray(textosModelo) ? textosModelo : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
  if (textos.length > 0 && bruto == null) return { avaliavel: false, codigo: 'json_invalido' }
  return { avaliavel: true, codigo: null }
}

function blocoSemFonteNoRecorte(bloco, recorte) {
  const fontes = asStrings(bloco.fontes).filter((id) => recorte.fontes.has(id))
  return fontes.length === 0
}

/** Lacuna do fallback: bloco documentado sem ids e com a frase de ausência de ligação. */
function ehLacunaSemLigacao(bloco) {
  if (!bloco || bloco.tipo !== 'documentado') return false
  if (asStrings(bloco.entidades).length || asStrings(bloco.relacoes).length || asStrings(bloco.fontes).length) return false
  return /não documenta ligação|nao documenta ligacao|não há fonte|nao ha fonte/i.test(bloco.texto ?? '')
}

export function avaliarGrounding({ bruto, finalData, recorte, avisos }) {
  const motivos = []
  const fora = []
  const blocosFinais = Array.isArray(finalData?.blocos) ? finalData.blocos : []
  for (const bloco of blocosFinais) {
    if (!bloco || typeof bloco !== 'object') continue
    if (bloco.tipo === 'inferencia') {
      for (const id of asStrings(bloco.base)) {
        if (!recorte.entidades.has(id) && !recorte.relacoes.has(id)) {
          fora.push({ campo: 'base', id })
        }
      }
      continue
    }
    if (bloco.tipo !== 'documentado' || ehLacunaSemLigacao(bloco)) continue
    for (const id of asStrings(bloco.entidades)) {
      if (!recorte.entidades.has(id)) fora.push({ campo: 'entidade', id })
    }
    for (const id of asStrings(bloco.relacoes)) {
      if (!recorte.relacoes.has(id)) fora.push({ campo: 'relacao', id })
    }
    for (const id of asStrings(bloco.fontes)) {
      if (!recorte.fontes.has(id)) fora.push({ campo: 'fonte', id })
    }
    if (blocoSemFonteNoRecorte(bloco, recorte)) motivos.push('bloco_documentado_sem_fonte')
  }
  const blocosBrutos = Array.isArray(bruto?.blocos) ? bruto.blocos : []
  for (const bloco of blocosBrutos) {
    if (bloco?.tipo === 'documentado' && !ehLacunaSemLigacao(bloco) && blocoSemFonteNoRecorte(bloco, recorte)) {
      motivos.push('bloco_documentado_sem_fonte')
    }
  }
  const citacaoRemovida = (avisos ?? []).filter((aviso) => aviso?.tipo === 'citacao_removida').length
  if (citacaoRemovida > 0) motivos.push('citacao_removida')
  if (fora.length > 0) motivos.push('id_fora_do_recorte')
  return {
    quebrado: motivos.length > 0,
    motivos: [...new Set(motivos)],
    ids_fora_do_recorte: fora,
    citacao_removida: citacaoRemovida,
  }
}

export function textoResposta({ bruto, finalData, erro }) {
  const parts = []
  const blocos = [
    ...(Array.isArray(bruto?.blocos) ? bruto.blocos : []),
    ...(Array.isArray(finalData?.blocos) ? finalData.blocos : []),
  ]
  for (const bloco of blocos) {
    if (!bloco || typeof bloco !== 'object') continue
    if (typeof bloco.texto === 'string') parts.push(bloco.texto)
    if (typeof bloco.justificativa === 'string') parts.push(bloco.justificativa)
  }
  for (const aviso of finalData?.avisos ?? []) {
    if (typeof aviso === 'string') parts.push(aviso)
    else if (aviso && typeof aviso.texto === 'string') parts.push(aviso.texto)
  }
  if (typeof erro?.message === 'string') parts.push(erro.message)
  if (Array.isArray(bruto?.sugestoes)) {
    for (const item of bruto.sugestoes) if (typeof item === 'string') parts.push(item)
  }
  return parts.join('\n')
}

export function detectarRecusa({ bruto, finalData, erro, texto }) {
  if (erro?.code === 'fora_da_base') return true
  if (finalData && Array.isArray(finalData.blocos) && finalData.blocos.length === 0) return true
  if (bruto && typeof bruto === 'object' && bruto.sem_base === true) return true
  if (bruto && Array.isArray(bruto.blocos) && bruto.blocos.length === 0 && !finalData) return true
  return REFUSAL_TEXT.test(texto ?? '')
}

export function conter(texto, deve, naoDeve) {
  const folded = fold(texto ?? '')
  const faltou = []
  const sobrou = []
  for (const item of deve ?? []) {
    if (!folded.includes(fold(item))) faltou.push(item)
  }
  for (const item of naoDeve ?? []) {
    if (folded.includes(fold(item))) sobrou.push(item)
  }
  return {
    passa: faltou.length === 0 && sobrou.length === 0,
    faltou,
    sobrou,
  }
}

function tokens(text) {
  return fold(text).match(/[a-z0-9]+/g) ?? []
}

function stopCounts(text) {
  let pt = 0
  let en = 0
  for (const word of tokens(text)) {
    if (PT_STOP.has(word)) pt += 1
    else if (EN_STOP.has(word)) en += 1
  }
  return { pt, en }
}

export function notaPtBr({ bruto, finalData, erro }) {
  const blocos = [
    ...(Array.isArray(finalData?.blocos) ? finalData.blocos : []),
    ...(Array.isArray(finalData?.blocos) ? [] : (Array.isArray(bruto?.blocos) ? bruto.blocos : [])),
  ]
  const textos = []
  for (const bloco of blocos) {
    if (typeof bloco?.texto === 'string') textos.push(bloco.texto)
    if (typeof bloco?.justificativa === 'string' && bloco.justificativa) textos.push(bloco.justificativa)
  }
  if (textos.length === 0 && typeof erro?.message === 'string') textos.push(erro.message)
  const texto = textos.join('\n').trim()
  const checks = []
  checks.push({ id: 'texto_nao_vazio', ok: texto.length > 0 })
  const counts = stopCounts(texto)
  const ptGanha = counts.pt > counts.en || (counts.pt === 0 && counts.en === 0 && (ACCENT.test(texto) || texto.length < 40))
  checks.push({ id: 'stopwords_pt_maior_que_en', ok: ptGanha, pt: counts.pt, en: counts.en })
  const longo = texto.length > 80
  checks.push({ id: 'acentuacao_em_texto_longo', ok: !longo || ACCENT.test(texto), longo })
  let blocoIngles = false
  const alvos = blocos.length > 0 ? blocos : [{ texto }]
  for (const bloco of alvos) {
    const sample = `${bloco?.texto ?? ''} ${bloco?.justificativa ?? ''}`.trim()
    if (!sample) continue
    const c = stopCounts(sample)
    if (c.en > c.pt && c.en >= 3) blocoIngles = true
  }
  checks.push({ id: 'nenhum_bloco_majoritariamente_ingles', ok: !blocoIngles })
  const pensamento = /<\/?think>/i.test(texto)
  checks.push({ id: 'sem_chain_of_thought', ok: !pensamento })
  const nota = checks.filter((item) => item.ok).length / checks.length
  return { nota, checks }
}

export function avaliarVoz({ bruto, finalData, erro, obrigatoria }) {
  const blocos = Array.isArray(finalData?.blocos) && finalData.blocos.length
    ? finalData.blocos
    : (Array.isArray(bruto?.blocos) ? bruto.blocos : [])
  const fato = blocos.some((bloco) => bloco?.tipo === 'documentado' && asStrings(bloco.fontes).length > 0)
  const inferencia = blocos.some((bloco) => (
    bloco?.tipo === 'inferencia'
    && asStrings(bloco.base).length > 0
    && typeof bloco.justificativa === 'string'
    && bloco.justificativa.trim().length > 0
  ))
  const textos = blocos.map((bloco) => `${bloco?.texto ?? ''}\n${bloco?.justificativa ?? ''}`).join('\n')
  const erroTxt = typeof erro?.message === 'string' ? erro.message : ''
  const sugestoes = Array.isArray(bruto?.sugestoes) ? bruto.sugestoes.filter((item) => typeof item === 'string' && item.trim()) : []
  const aberto = textos.includes('?') || sugestoes.length > 0 || OPEN_TEXT.test(`${textos}\n${erroTxt}`)
  const mistura = blocos.some((bloco) => bloco?.tipo === 'documentado' && SPECULATIVE.test(bloco.texto ?? ''))
  const presentes = { fato, inferencia, aberto }
  const separados = !mistura
  const cumpre = obrigatoria ? fato && inferencia && aberto && separados : null
  return { ...presentes, mistura_especulativa_em_documentado: mistura, separados, voz_aion_obrigatoria: Boolean(obrigatoria), cumpre_obrigatoria: cumpre }
}

export function unirCitados(...listas) {
  const entidades = []
  const relacoes = []
  const fontes = []
  const bases = []
  for (const item of listas) {
    if (!item) continue
    entidades.push(...item.entidades)
    relacoes.push(...item.relacoes)
    fontes.push(...item.fontes)
    bases.push(...item.bases)
  }
  return { entidades, relacoes, fontes, bases }
}

export function citadosComoConjunto(citados) {
  return new Set([
    ...citados.entidades,
    ...citados.relacoes,
    ...citados.fontes,
    ...citados.bases,
  ])
}

const TOKEN_RE = /[A-Za-z0-9_.:-]+/g
const LISTA_IGNORAR = new Set(`alta baixa media fato fatos limite base fonte fontes id ids citar como para com sem
que por uma uns nao não entre sobre este esta isso mais mas seu sua ele ela dos das nos nas ou e de da do a o
the and se em no na os as um`.split(/\s+/))

function pareceIdEstrutural(tok) {
  if (!/^[A-Za-z0-9_.:-]{2,120}$/.test(tok)) return false
  if (/^\d+(?:\.\d+)?$/.test(tok)) return false
  if (tok.includes('_')) return true
  if (/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,6}$/.test(tok) && /\d/.test(tok)) return true
  if (/^[A-Z][A-Za-z0-9]*\d[A-Za-z0-9]*$/.test(tok)) return true
  return false
}

function pareceId(tok, conhecidos) {
  if (conhecidos?.has(tok)) return true
  return pareceIdEstrutural(tok)
}

function tokenCurto(tok) {
  return tok.length < 6 && !/[\d_-]/.test(tok)
}

/** Item cuja única palavra é o id, depois de tirar aspas. Lista e prosa devolvem vazio. */
function tokenDoItemInteiro(texto) {
  const bruto = String(texto ?? '').trim()
  if (!bruto || /[\s,;]/.test(bruto)) return ''
  return bruto.replace(/^[("'`[{]+|[)"'`.\]}]+$/g, '')
}

/**
 * Ids citados numa rubrica em linguagem natural.
 * Entra token que existe no conjunto do banco (caixa sensível) ou id estrutural
 * (underscore, hífen com dígito, ou sigla maiúscula com dígito). Número puro não entra.
 * A lista de palavras a ignorar vale neste laço, não só no vizinho.
 * Token curto (menos de 6 caracteres, sem _, - ou dígito) só entra se for o item
 * inteiro ou vizinho explícito de uma lista. E219 e PR3-E056 continuam.
 * Numa lista separada por vírgula ou «ou», o vizinho de um id (ex.: heitor) também entra.
 */
export function extrairIdsRubrica(item, conhecidos) {
  const texto = String(item ?? '')
  const ids = []
  const inteiro = tokenDoItemInteiro(texto)
  const add = (tok) => {
    const limpo = String(tok ?? '').replace(/^[("'`[{]+|[)"'`.\]}]+$/g, '')
    if (!limpo || ids.includes(limpo)) return
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(limpo)) return
    ids.push(limpo)
  }
  for (const tok of texto.match(TOKEN_RE) ?? []) {
    if (LISTA_IGNORAR.has(fold(tok))) continue
    if (tokenCurto(tok) && tok !== inteiro) continue
    if (pareceId(tok, conhecidos)) add(tok)
  }
  const partes = texto.split(/\s*(?:,|;|\bou\b)\s*/i)
  const listaDeIds = partes.some((parte) => {
    const tok = parte.trim().replace(/^[("'`[{]+|[)"'`.\]}]+$/g, '')
    return parte.trim().split(/\s+/).length === 1 && pareceId(tok, conhecidos)
  })
  if (listaDeIds) {
    for (const parte of partes) {
      const palavras = parte.trim().split(/\s+/).filter(Boolean)
      if (palavras.length !== 1) continue
      const tok = palavras[0].replace(/^[("'`[{]+|[)"'`.\]}]+$/g, '')
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{1,119}$/.test(tok)) continue
      if (LISTA_IGNORAR.has(fold(tok))) continue
      add(tok)
    }
  }
  return ids
}

function palavrasRubrica(item) {
  return String(item ?? '').trim().split(/\s+/).filter(Boolean)
}

/**
 * deve_conter / nao_deve_conter são rubricas.
 * Id extraído precisa estar citado (ou ausente, no nao_deve_conter).
 * Item curto sem id (até 3 palavras) é checagem literal normalizada.
 * O resto fica em rubrica_manual com status nao_avaliado_automaticamente e não reprova.
 */
export function avaliarRubricas({ texto, citados, deve, naoDeve, conhecidos }) {
  const citado = citados instanceof Set ? citados : new Set(citados ?? [])
  const conhecidosSet = conhecidos instanceof Set ? conhecidos : new Set(conhecidos ?? [])
  const folded = fold(texto ?? '')
  const auto = []
  const manual = []
  const faltou = []
  const sobrou = []

  const avaliarLado = (itens, campo) => {
    for (const item of itens ?? []) {
      const ids = extrairIdsRubrica(item, conhecidosSet)
      const curto = palavrasRubrica(item).length <= 3
      if (ids.length === 0 && curto) {
        const presente = folded.includes(fold(item))
        const ok = campo === 'deve_conter' ? presente : !presente
        auto.push({ campo, tipo: 'literal', item, ok })
        if (!ok && campo === 'deve_conter') faltou.push(item)
        if (!ok && campo === 'nao_deve_conter') sobrou.push(item)
        continue
      }
      for (const id of ids) {
        const presente = citado.has(id)
        const ok = campo === 'deve_conter' ? presente : !presente
        auto.push({ campo, tipo: 'id', item, id, ok })
        if (!ok && campo === 'deve_conter') faltou.push(id)
        if (!ok && campo === 'nao_deve_conter') sobrou.push(id)
      }
      const soIds = ids.length > 0 && palavrasRubrica(item).every((palavra) => {
        const limpa = palavra.replace(/^[("'`[{,;]+|[)"'`.\]},;]+$/g, '')
        return ids.includes(limpa) || LISTA_IGNORAR.has(fold(limpa)) || !/[A-Za-zÀ-ÿ0-9]/.test(limpa)
      })
      if (!soIds) {
        manual.push({ campo, item, status: 'nao_avaliado_automaticamente' })
      }
    }
  }
  avaliarLado(deve, 'deve_conter')
  avaliarLado(naoDeve, 'nao_deve_conter')
  const autoOk = auto.filter((item) => item.ok)
  const autoFalha = auto.filter((item) => !item.ok)
  return {
    passa: autoFalha.length === 0,
    faltou,
    sobrou,
    auto_ok: autoOk,
    auto_falha: autoFalha,
    rubrica_manual: manual,
  }
}

export function vozExigida({ categoria, pergunta, explicita }) {
  if (categoria === 'voz_aion') return true
  const t = fold(pergunta ?? '')
  if (/separe\s+(o\s+que\s+e\s+)?fato/.test(t)) return true
  if (/fato\s*,\s*inferencia/.test(t)) return true
  if (/\bfato\b.*\binferencia\b/.test(t) && /separe|quero|separei/.test(t)) return true
  return explicita === true
}

export function arestasDe(ctx) {
  const lista = []
  for (const rel of ctx?.relacoes ?? []) {
    if (!rel || typeof rel !== 'object') continue
    if (!rel.id || !rel.origem || !rel.destino) continue
    lista.push({ id: String(rel.id), origem: String(rel.origem), destino: String(rel.destino) })
  }
  return lista
}

export function relacoesCitadasNosBlocos(bruto, finalData) {
  const ids = new Set()
  const blocos = [
    ...(Array.isArray(bruto?.blocos) ? bruto.blocos : []),
    ...(Array.isArray(finalData?.blocos) ? finalData.blocos : []),
  ]
  for (const bloco of blocos) {
    if (!bloco || typeof bloco !== 'object') continue
    if (bloco.tipo === 'documentado') {
      for (const id of asStrings(bloco.relacoes)) ids.add(id)
    } else if (bloco.tipo === 'inferencia') {
      for (const id of asStrings(bloco.base)) ids.add(id)
      for (const id of asStrings(bloco.relacoes)) ids.add(id)
    }
  }
  return ids
}

const AFIRMA_LIGACAO = /\b(h[aá] liga[cç][aã]o|existe liga[cç][aã]o|liga[cç][aã]o direta|est[aã]o ligados|est[aá] ligado|h[aá] conex[aã]o|existe conex[aã]o|h[aá] parentesco|s[aã]o parentes|parentesco comprovado)\b/i
const NEGACAO = /\b(n[aã]o|nao|sem|nenhum|nenhuma|aus[eê]ncia)\b/i

export function textoAfirmaLigacao(texto) {
  const frases = String(texto ?? '').split(/[\n.!?]+/)
  for (const frase of frases) {
    if (!AFIRMA_LIGACAO.test(frase)) continue
    if (NEGACAO.test(frase)) continue
    return true
  }
  return false
}

export function reconheceSemLigacao({ texto, bruto, erro, avisos }) {
  if (bruto?.sem_base === true) return true
  const partes = [texto ?? '']
  if (typeof erro?.message === 'string') partes.push(erro.message)
  for (const aviso of avisos ?? []) {
    if (typeof aviso === 'string') partes.push(aviso)
    else if (typeof aviso?.texto === 'string') partes.push(aviso.texto)
  }
  const corpus = partes.join('\n')
  return /não documenta ligação|nao documenta ligacao|não há fonte|nao ha fonte|liga[cç][aã]o pedida n[aã]o est[aá] documentada/i.test(corpus)
}

/**
 * sem_ligacao passa se a resposta reconhece a ausência de ligação e não afirma uma.
 * Afirma se um bloco documentado ou inferencia cita relação que liga as entidades
 * esperadas direto ou por um intermediário, ou se o texto afirma a ligação.
 */
export function avaliarSemLigacao({ expectativa, texto, bruto, finalData, erro, avisos, arestas, entidadesEsperadas }) {
  if (expectativa !== 'sem_ligacao') {
    return { aplicavel: false, ok: null, reconhece: null, afirma_relacao: false, relacoes: [], afirma_texto: false }
  }
  const esperados = [...new Set((entidadesEsperadas ?? []).filter(Boolean))]
  const citadas = relacoesCitadasNosBlocos(bruto, finalData)
  const porId = new Map()
  for (const aresta of arestas ?? []) {
    if (!porId.has(aresta.id)) porId.set(aresta.id, [])
    porId.get(aresta.id).push(aresta)
  }
  const edges = []
  for (const id of citadas) {
    for (const aresta of porId.get(id) ?? []) edges.push(aresta)
  }
  const relacoes = ligamEsperadas(edges, esperados)
  const afirmaRelacao = relacoes.length > 0
  const afirmaTexto = textoAfirmaLigacao(texto)
  const reconhece = reconheceSemLigacao({ texto, bruto, erro, avisos })
  return {
    aplicavel: true,
    ok: reconhece && !afirmaRelacao && !afirmaTexto,
    reconhece,
    afirma_relacao: afirmaRelacao,
    relacoes,
    afirma_texto: afirmaTexto,
  }
}

function ligamEsperadas(edges, esperados) {
  const esp = new Set(esperados)
  if (esp.size < 2) return []
  const ruins = new Set()
  const adj = new Map()
  const add = (de, para, id) => {
    if (!adj.has(de)) adj.set(de, [])
    adj.get(de).push({ no: para, id })
  }
  for (const edge of edges) {
    if (edge.origem !== edge.destino && esp.has(edge.origem) && esp.has(edge.destino)) ruins.add(edge.id)
    add(edge.origem, edge.destino, edge.id)
    add(edge.destino, edge.origem, edge.id)
  }
  const lista = [...esp]
  for (let i = 0; i < lista.length; i++) {
    for (let j = i + 1; j < lista.length; j++) {
      const a = lista[i]
      const b = lista[j]
      for (const hop of adj.get(a) ?? []) {
        if (hop.no === b) continue
        if ((adj.get(hop.no) ?? []).some((viz) => viz.no === b)) ruins.add(hop.id)
      }
    }
  }
  return [...ruins]
}

export function normalizarIdsBase(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('ids-base inválido: objeto esperado')
  }
  const ler = (campo) => {
    const value = data[campo]
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
      throw new Error(`ids-base inválido: ${campo} deve ser lista de strings`)
    }
    return new Set(value)
  }
  const entidades = ler('entidades')
  const relacoes = ler('relacoes')
  const fontes = ler('fontes')
  const casos = ler('casos')
  return {
    entidades,
    relacoes,
    fontes,
    casos,
    meta: data._meta && typeof data._meta === 'object' ? data._meta : null,
    contagens: {
      entidades: entidades.size,
      relacoes: relacoes.size,
      fontes: fontes.size,
      casos: casos.size,
    },
  }
}

export function baseCitacaoDe(ids) {
  return {
    entidades: new Set([...(ids?.entidades ?? []), ...(ids?.casos ?? [])]),
    relacoes: new Set(ids?.relacoes ?? []),
    fontes: new Set(ids?.fontes ?? []),
    casos: new Set(ids?.casos ?? []),
  }
}

export function conhecidosDe(ids) {
  return new Set([
    ...(ids?.entidades ?? []),
    ...(ids?.casos ?? []),
    ...(ids?.relacoes ?? []),
    ...(ids?.fontes ?? []),
  ])
}

const DIVERGENCIA_LIMITE = 50

export function divergenciaIds(origem, referencia) {
  const tipos = ['entidades', 'relacoes', 'fontes', 'casos']
  const out = {}
  for (const tipo of tipos) {
    const a = origem?.[tipo] instanceof Set ? origem[tipo] : new Set(origem?.[tipo] ?? [])
    const b = referencia?.[tipo] instanceof Set ? referencia[tipo] : new Set(referencia?.[tipo] ?? [])
    out[tipo] = {
      so_na_origem: recortarDiff(a, b),
      so_na_referencia: recortarDiff(b, a),
    }
  }
  return out
}

function recortarDiff(tem, naoTem) {
  const ids = [...tem].filter((id) => !naoTem.has(id)).sort()
  return { n: ids.length, ids: ids.slice(0, DIVERGENCIA_LIMITE) }
}

export function avisosIdsEsperados(itens, referencia) {
  if (!referencia) return []
  const entidades = new Set([...(referencia.entidades ?? []), ...(referencia.casos ?? [])])
  const avisos = []
  for (const item of itens ?? []) {
    for (const entidade of item.entidades_esperadas ?? []) {
      const id = typeof entidade === 'string' ? entidade : entidade?.id
      if (!id || entidades.has(id)) continue
      avisos.push({
        tipo: 'id_esperado_inexistente',
        pergunta: item.id,
        campo: 'entidade',
        id,
        id_pendente: typeof entidade === 'object' ? entidade.id_pendente ?? null : null,
      })
    }
    for (const id of item.fontes_esperadas ?? []) {
      if (!referencia.fontes.has(id)) {
        avisos.push({ tipo: 'id_esperado_inexistente', pergunta: item.id, campo: 'fonte', id })
      }
    }
    for (const id of item.conexoes_esperadas ?? []) {
      if (!referencia.relacoes.has(id)) {
        avisos.push({ tipo: 'id_esperado_inexistente', pergunta: item.id, campo: 'relacao', id })
      }
    }
  }
  return avisos
}
