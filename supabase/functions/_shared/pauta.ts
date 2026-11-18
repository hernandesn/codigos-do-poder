// Pautas: recuperação limitada e texto público ancorado nas afirmações da RPC.
// O modelo só pode escrever ganchos de título e a pergunta final; sua prosa não vira Fato.
import type { ChatContextPayload, ChatContextRelation, ChatContextFonte, ChatDb, SanitizedAnswer } from './chat_core.ts'

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
const OFF_TOPIC = /\b(receita|bolo|cozinhar|futebol|esporte|placar|horoscopo|clima|previsao do tempo|sentido da vida)\b/
export function isPautaRequest(text: string): boolean {
  const q = fold(text)
  if (OFF_TOPIC.test(q) || /politica atual|presidente atual|eleicoes? (?:de )?202[6-9]/.test(q)) return false
  return /\b(sugira|sugere|sugerir|sugest(?:ao|oes)|ideias?|me d[ae]|quais|o que|que)\b/.test(q)
    && /\b(temas?|pautas?|angulos?|assuntos?|investigar|investigacao|explorar|ideias?)\b/.test(q)
}
export function isIllegalPressure(text: string): boolean {
  const q = fold(text)
  return /\b(diga|afirme|admita|entao|prove)\b/.test(q) && /\b(ilegal\w*|crime\w*|culpa\w*|conspir\w*|lavagem|fraude\w*)\b/.test(q)
}
export function pautaSearchQuery(text: string): string {
  return fold(text).replace(/[^a-z0-9 ]/g, ' ').split(/ +/).filter(w => w && !new Set([
    'sugira','sugere','sugerir','sugestao','sugestoes','pra','para','mim','me','da','de','do','dos','das','os','as','um','uma','uns','umas','o','a','e','em','no','na','nos','nas','com','sobre','entre','por','quais','que','eu','posso',
    'tema','temas','pauta','pautas','ideia','ideias','angulo','angulos','assunto','assuntos','bem','muito','forte','fortes','polemico','polemicos','polemica','polemicas','instigante','investigar','investigacao','explorar','ligada','ligadas','dessas','familias',
  ]).has(w) && !/^[1-5]$/.test(w)).join(' ')
}
// Não altera ids de nó/fonte; esta função só trata prosa pública.
export function publicChatText(text: string): string {
  return text.replace(/Epstein\s*[×x]\s*(?:fam[ií]lia\s+)?Rothschild/gi, 'vínculos documentados')
    .replace(/\b(?:t\d{2}_\w+|(?:pauta|rodada|caso op)[-_ ]?\d+[\w.-]*)\b/gi, 'recorte')
    .replace(/\b[\w-]+\.(?:md|jsonl?|csv|sql|ts|mjs|cjs|py|txt)\b/gi, 'documento')
    .replace(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g, 'registro')
}
export function safePublicClaim(text: string, ctx: ChatContextPayload, ids: string[]): boolean {
  const terms = text.match(/\b(?:escândalo\w*|esquema\w*|lavagem|crime\w*|criminos\w*|ilegal\w*|il[ií]cit\w*|fraude\w*|conspira\w*|culpad\w*|corrup\w*|corrompe\w*|subor\w*|propina\w*)\b/giu) || []
  if (!terms.length) return true
  const sourceText = ctx.fontes.filter(f => ids.includes(f.id)).map(f => JSON.stringify(f)).join(' ')
  return terms.every(term => (text.includes(`“${term}”`) || text.includes(`«${term}»`) || text.includes(`"${term}"`)) && fold(sourceText).includes(fold(term)))
}
const INTERNAL = /proposta[_\s-]*interna|pend[eê]ncia(?:[_\s-]*interna)?|rascunho|nota de trabalho/i
const PROCESS_NOTE = /n[aã]o conferid|usar o pdf|p[aá]gina devolveu|http\s*\d{3}|curl retornou/i
const LIST_DATE_EN = /as of\s+([a-z]+)\s+(\d{1,2}),\s+(\d{4})/i
const LIST_DATE_BR = /(\d{1,2})\/(\d{1,2})\/(\d{4})/
const MONTH_EN: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
}

export function isInternalText(...parts: Array<string | null | undefined>): boolean {
  return INTERNAL.test(fold(parts.filter((p): p is string => !!p).join(' ')))
}

export function isInternalSource(f: ChatContextFonte): boolean {
  return isInternalText(f.tipo, f.titulo, f.acesso)
}

export function isInternalRelation(r: ChatContextRelation): boolean {
  return isInternalText(r.tipo, r.estado)
}

const UNVERIFIED_FONTES = new WeakSet<ChatContextFonte>()

export function isUnverifiedSource(f: ChatContextFonte): boolean {
  if (UNVERIFIED_FONTES.has(f)) return true
  return PROCESS_NOTE.test([f.localizador, f.titulo, f.acesso, f.tipo].filter(Boolean).join(' '))
}

export function isCitableSource(f: ChatContextFonte): boolean {
  return !isInternalSource(f) && !isUnverifiedSource(f)
}

export function publicAccessNote(text?: string | null): string {
  const raw = (text || '').trim()
  if (!raw) return ''
  if (PROCESS_NOTE.test(raw) || INTERNAL.test(fold(raw))) return ''
  return publicChatText(raw)
}

export function sanitizePublicFonte(f: ChatContextFonte, entityNames: string[] = []): ChatContextFonte {
  const wasUnverified = isUnverifiedSource(f)
  const next: ChatContextFonte = { ...f }
  const loc = next.localizador ? relevantLocator(next.localizador, entityNames) : ''
  if (loc) next.localizador = loc
  else delete next.localizador
  const acesso = publicAccessNote(next.acesso)
  if (acesso) next.acesso = acesso
  else delete next.acesso
  if (wasUnverified) UNVERIFIED_FONTES.add(next)
  return next
}

export function contextEntityNames(ctx: ChatContextPayload, ids: Array<string | null | undefined> = []): string[] {
  const wanted = new Set(ids.filter((id): id is string => !!id))
  const names: string[] = []
  for (const item of [...(ctx.raizes || []), ...(ctx.entidades || [])]) {
    if (wanted.size && !wanted.has(item.id)) continue
    const nome = (item.nome || '').trim()
    if (nome && !names.includes(nome)) names.push(nome)
  }
  return names
}

export function namesCitingFonte(ctx: ChatContextPayload, fonteId: string, onlyRelations?: Set<string>): string[] {
  const ids: string[] = []
  for (const r of ctx.relacoes || []) {
    if (onlyRelations && !onlyRelations.has(r.id)) continue
    if (!(r.fontes || []).includes(fonteId)) continue
    for (const id of [r.origem, r.destino]) if (id && !ids.includes(id)) ids.push(id)
  }
  return contextEntityNames(ctx, ids)
}

export function sanitizePublicContext(ctx: ChatContextPayload): ChatContextPayload {
  const fontes = (ctx.fontes || []).filter((f) => !isInternalSource(f)).map((f) => sanitizePublicFonte(f, namesCitingFonte(ctx, f.id)))
  const allowed = new Set(fontes.map((f) => f.id))
  const relacoes = (ctx.relacoes || []).filter((r) => !isInternalRelation(r)).map((r) => ({
    ...r,
    fontes: (r.fontes || []).filter((id) => allowed.has(id)),
  }))
  return { ...ctx, fontes, relacoes }
}

function quotesBalanced(s: string): boolean {
  const pairs: Array<[string, string]> = [['«', '»'], ['“', '”'], ['‘', '’']]
  for (const [open, close] of pairs) {
    let depth = 0
    for (const ch of s) {
      if (ch === open) depth++
      else if (ch === close) depth = Math.max(0, depth - 1)
    }
    if (depth !== 0) return false
  }
  if ((s.match(/"/g) || []).length % 2 !== 0) return false
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "'") continue
    const prev = s[i - 1] || ''
    const next = s[i + 1] || ''
    const letterish = /[A-Za-zÀ-ÿ]/
    if (letterish.test(prev) && letterish.test(next)) continue
    depth ^= 1
  }
  return depth === 0
}

export function publicLocator(text: string, max = 140): string {
  const original = text || ''
  // Localizador que é, no todo, um registro de conferência falha: só o título/id vai à UI.
  if (/n[aã]o conferid|usar o pdf|p[aá]gina devolveu/i.test(original)) return ''
  let raw = original.replace(/\((?:[^()]*?(?:n[aã]o conferid|usar o pdf|p[aá]gina devolveu|http\s*\d{3}|curl retornou)[^()]*)\)/gi, '')
  raw = raw.replace(/[;,]?\s*(?:curl retornou|http\s*\d{3}).*$/gi, '')
  raw = raw.replace(/[—–-]\s*(?:n[aã]o conferid|usar o pdf).*$/gi, '')
  raw = raw.replace(PROCESS_NOTE, '')
  raw = raw.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').trim()
  if (!raw) return ''
  return clipLocator(raw, max)
}

export function clipLocator(text: string, max: number): string {
  const raw = text.trim()
  if (raw.length <= max && quotesBalanced(raw)) return raw
  const window = raw.slice(0, Math.max(max, 0))
  let safe = -1
  for (let i = 0; i < window.length; i++) {
    const ch = window[i]
    const next = window[i + 1] || ''
    if ((ch === '.' || ch === ';') && (next === '' || /\s/.test(next))) {
      const cand = window.slice(0, i + 1)
      if (quotesBalanced(cand)) safe = i + 1
    } else if ((ch === "'" || ch === '"' || ch === '»' || ch === '”' || ch === '’') && (next === '' || /[\s,.;]/.test(next))) {
      const cand = window.slice(0, i + 1)
      if (quotesBalanced(cand)) safe = i + 1
    }
  }
  if (safe >= Math.min(40, window.length * 0.4)) return window.slice(0, safe).trim()
  for (let i = window.length; i >= 40; i--) {
    const cand = window.slice(0, i).trim()
    if (quotesBalanced(cand) && /[.;'"»”’]$/.test(cand)) return cand
  }
  const fallback = window.replace(/\s+\S*$/, '').trim()
  return quotesBalanced(fallback) ? fallback : fallback.replace(/\s*'[^']*$/, '').trim()
}

export function splitLocatorParts(text: string): string[] {
  const parts: string[] = []
  let buf = ''
  let quote = ''
  for (const ch of text) {
    if (quote) {
      buf += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '«' || ch === '“' || ch === '‘') {
      quote = ch === '«' ? '»' : ch === '“' ? '”' : ch === '‘' ? '’' : ch
      buf += ch
      continue
    }
    if (ch === ';') {
      if (buf.trim()) parts.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) parts.push(buf.trim())
  return parts
}

const DATE_PAGE = /\bp\.\s*\d|\bp[aá]gina\b|\bas of\b|\bas at\b|\bem\s+\d{1,2}\/\d{1,2}\/\d{4}|\bfunda[cç][aã]o em\s+\d/i
const QUOTED_PERSON = /^['«“‘](?:founder|cofounder|chairman|member|director|president|dr\.?|sir|lord)?\s*[A-ZÁÉÍÓÚÂÊÔÃÕÀ][a-zà-ÿ'’]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÀ][a-zà-ÿ'’-]+)+(?:\s*,\s*[A-Za-zÀ-ÿ. ]+)?['»”’]$/i

export function isDatePageLocator(part: string): boolean {
  return DATE_PAGE.test(part)
}

export function isQuotedPersonLocator(part: string): boolean {
  return QUOTED_PERSON.test(part.trim())
}

function mentionsEntity(part: string, names: string[]): boolean {
  const hay = fold(part)
  for (const name of names) {
    const n = fold(name).trim()
    if (n.length < 3) continue
    if (hay.includes(n)) return true
  }
  return false
}

/** Recorte exibido: trechos com entidade da ligação, mais data/página. Nomes de terceiros entre aspas saem. */
export function relevantLocator(text: string, entityNames: string[] = [], max = 140): string {
  const cleaned = publicLocator(text, max)
  if (!cleaned) return ''
  const names = entityNames.map((n) => n.trim()).filter((n) => n.length >= 3)
  if (!names.length) return cleaned
  const parts = splitLocatorParts(cleaned)
  if (parts.length <= 1) return cleaned
  const kept = parts.filter((part) => isDatePageLocator(part) || mentionsEntity(part, names) || !isQuotedPersonLocator(part))
  if (kept.length) return kept.join('; ')
  // Só restavam nomes de terceiros não casados: cai para título/id.
  return ''
}

function pad2(n: string | number): string {
  return String(n).padStart(2, '0')
}

export function formatListDate(raw: string): string | undefined {
  const iso = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`
  const br = raw.match(LIST_DATE_BR)
  if (br) return `${pad2(br[1])}/${pad2(br[2])}/${br[3]}`
  const en = raw.match(LIST_DATE_EN)
  if (en) {
    const month = MONTH_EN[en[1].toLowerCase()]
    if (month) return `${pad2(en[2])}/${month}/${en[3]}`
  }
  return undefined
}

export function listDateFromSources(fontes: ChatContextFonte[]): string | undefined {
  for (const f of fontes) {
    if (f.publicado_em) {
      const d = formatListDate(f.publicado_em)
      if (d) return d
    }
    if (f.localizador) {
      const d = formatListDate(f.localizador)
      if (d) return d
    }
    if (f.titulo) {
      const d = formatListDate(f.titulo)
      if (d) return d
    }
  }
  return undefined
}

export function isHistoricalPeriod(periodo?: string | null): boolean {
  const years = [...new Set((periodo || '').match(/\b(?:1[89]\d{2}|20\d{2})\b/g) || [])].map(Number)
  if (!years.length) return false
  return Math.max(...years) < 2026
}

export function factText(r: ChatContextRelation, fontes: ChatContextFonte[]): string {
  let claim = publicChatText(r.afirmacao!)
  const date = listDateFromSources(fontes)
  if (date) {
    claim = claim.replace(/na lista atual(?: do CIAC)?/gi, (m) => /ciac/i.test(m) ? `na lista de ${date} do CIAC` : `na lista de ${date}`)
    claim = claim.replace(/lista atual/gi, `lista de ${date}`)
  }
  if (isHistoricalPeriod(r.periodo)) {
    claim = claim.replace(/\s+atual(?=[\s.,;:]|$)/gi, '')
  }
  const periodo = r.periodo ? ` Período: ${publicChatText(r.periodo)}.` : ''
  return `Fato documentado: ${claim}${periodo}`
}

export function pautaAxis(query: string): RegExp | null {
  const q = fold(query)
  if (/petroleo/.test(q)) return /petroleo|oil|esso|concessao/
  if (/educacao/.test(q)) return /educa|education|univers|ensino/
  if (/saude/.test(q)) return /saude|health|medic|malaria/
  if (/fundacao/.test(q)) return /fundacao|foundation|fund|estabeleceu/
  return null
}
export function pautaRelations(ctx: ChatContextPayload, query = ''): ChatContextRelation[] {
  const sources = new Map(ctx.fontes.filter(isCitableSource).map(f => [f.id, f]))
  const seen = new Set<string>()
  const axis = pautaAxis(query)
  const names = new Map([...ctx.raizes, ...ctx.entidades].map(e => [e.id, e.nome || '']))
  return ctx.relacoes.filter(r => {
    const key = [r.origem, r.destino].sort().join('|')
    if (isInternalRelation(r)) return false
    if (axis && !axis.test(fold(`${r.afirmacao} ${r.tipo} ${names.get(r.origem || '')} ${names.get(r.destino || '')}`))) return false
    if (!safePublicClaim(r.afirmacao || '', ctx, r.fontes || [])) return false
    if (seen.has(key) || !r.afirmacao?.trim() || /(?:\.\.\.|…)$/.test(r.afirmacao.trim()) || r.afirmacao.length > 450
      || /parentesco|casamento|indice|identificacao/.test(r.tipo || '') || r.estado === 'rascunho'
      || r.confianca === 'baixa' || !r.fontes?.some(id => sources.has(id)) || INTERNAL.test(fold(r.afirmacao))) return false
    seen.add(key)
    return true
  })
}

export type PautaThemeType = 'dinheiro' | 'instituicao' | 'decisao' | 'data'
const TIPO_DINHEIRO = /participacao|financiamento|doacao|subscricao|subscritor|aquisicao|recapitaliz|intermediacao_financeira|contrato_comercial|intermediario_privado|veiculo_familiar|transferencia/
const TIPO_INSTITUICAO = /fundacao|fundador|vinculo_institucional|vinculo_empresarial|cargo|direcao|governanca/
const TIPO_DECISAO = /controle|incorporacao|decisao_judicial|reorganizacao|correspondencia_diplomatica/

export function periodoYears(periodo?: string | null): number[] {
  const years = [...new Set((periodo || '').match(/\b(?:1[89]\d{2}|20\d{2})\b/g) || [])].map(Number).sort((a, b) => a - b)
  return years
}
export function themeType(r: ChatContextRelation): PautaThemeType {
  if (periodoYears(r.periodo).length >= 2) return 'data'
  const tipo = fold(r.tipo || '')
  if (TIPO_DECISAO.test(tipo)) return 'decisao'
  if (TIPO_INSTITUICAO.test(tipo)) return 'instituicao'
  if (TIPO_DINHEIRO.test(tipo)) return 'dinheiro'
  return 'instituicao'
}
const CLUSTER_RCM = /\b(?:rfs|rcm|rockco|rit|viking|igm|mousse|trust_familia|rfs_opco|rcm_gp)\b/
const CLUSTER_STANDARD = /\b(?:standard|standard_nj|esso)\b/
const CLUSTER_FUND = /\b(?:rf|rfcc|geapp_llc|geb|rock_univ|rbf|rock_museum)\b/
const CLUSTER_CARGO = /\b(?:chase|cfr|trilateral|moma|ociaa)\b/
export function clusterKey(r: ChatContextRelation): string {
  const ids = `${r.origem || ''} ${r.destino || ''}`
  if (CLUSTER_RCM.test(ids)) return 'rcm-rfs'
  if (CLUSTER_STANDARD.test(ids)) return 'standard'
  if (CLUSTER_FUND.test(ids)) return 'fundacao'
  if (CLUSTER_CARGO.test(ids)) return 'cargo-instituicao'
  return r.destino || r.origem || r.id
}

export function tensionScore(r: ChatContextRelation): number {
  const limite = r.limite?.trim() || ''
  let score = 0
  if (limite) score += 4
  if (periodoYears(r.periodo).length >= 2) score += 3
  if ((r.fontes?.length || 0) >= 2) score += 2
  if (/diverg|conflit|nao equivale|não equivale|nao divulga|não divulga|sem percentual|nao quantifica|não quantifica/i.test(limite)) score += 2
  return score
}

const MAX_SAME_TYPE = 2
const MAX_THEMES = 5
const MIN_THEMES = 3

export function selectPautaRelations(ctx: ChatContextPayload, query = '', prefer: string[] = [], pressure = false): ChatContextRelation[] {
  const rows = pautaRelations(ctx, query)
  const rank = (id: string) => { const i = prefer.indexOf(id); return i === -1 ? 0 : (prefer.length - i) * 0.1 }
  const ordered = [...rows].sort((a, b) => (tensionScore(b) + rank(b.id)) - (tensionScore(a) + rank(a.id)))
  if (pressure) return ordered.slice(0, 1)
  const typeCounts: Record<PautaThemeType, number> = { dinheiro: 0, instituicao: 0, decisao: 0, data: 0 }
  const clusterCounts = new Map<string, number>()
  const chosen: ChatContextRelation[] = []
  const take = (r: ChatContextRelation, opts: { typeCap: boolean; clusterCap: boolean }) => {
    if (chosen.some(c => c.id === r.id)) return false
    const tipo = themeType(r)
    const cluster = clusterKey(r)
    if (opts.typeCap && typeCounts[tipo] >= MAX_SAME_TYPE) return false
    if (opts.clusterCap && (clusterCounts.get(cluster) || 0) >= MAX_SAME_TYPE) return false
    chosen.push(r)
    typeCounts[tipo]++
    clusterCounts.set(cluster, (clusterCounts.get(cluster) || 0) + 1)
    return true
  }
  // Primeiro, um de cada tipo, preferindo um núcleo ainda não usado.
  const types: PautaThemeType[] = ['dinheiro', 'instituicao', 'decisao', 'data']
  for (const tipo of types) {
    const options = ordered.filter(r => themeType(r) === tipo)
    const fresh = options.find(r => (clusterCounts.get(clusterKey(r)) || 0) < MAX_SAME_TYPE)
    if (fresh) take(fresh, { typeCap: true, clusterCap: true })
  }
  for (const tipo of types) {
    if (typeCounts[tipo] > 0 || chosen.length >= MAX_THEMES) continue
    const hit = ordered.find(r => themeType(r) === tipo && !chosen.some(c => c.id === r.id))
    if (hit) take(hit, { typeCap: true, clusterCap: false })
  }
  for (const r of ordered) {
    if (chosen.length >= MAX_THEMES) break
    take(r, { typeCap: true, clusterCap: true })
  }
  if (chosen.length < MIN_THEMES) {
    for (const r of ordered) {
      if (take(r, { typeCap: false, clusterCap: false }) && chosen.length >= MIN_THEMES) break
    }
  }
  return chosen
}

function entityName(entities: Map<string, { nome?: string }>, id?: string): string {
  return publicChatText(entities.get(id || '')?.nome || 'Instituição')
}

export function hookTitle(r: ChatContextRelation, entities: Map<string, { nome?: string }>, fontes: ChatContextFonte[] = []): string {
  const origem = entityName(entities, r.origem)
  const destino = entityName(entities, r.destino)
  const periodo = r.periodo ? publicChatText(r.periodo) : ''
  const year = (r.periodo || '').match(/\b(?:1[89]\d{2}|20\d{2})\b/)?.[0]
  const tipo = fold(r.tipo || '')
  const af = fold(r.afirmacao || '')
  const date = listDateFromSources(fontes)
  const tipoLabel = publicChatText((r.tipo || '').replace(/_/g, ' ')).trim()
  if (/controle/.test(tipo)) {
    return year || periodo ? `Quem controlava a ${destino} em ${year || periodo}` : `Quem a fonte indica como controladora de ${destino}`
  }
  if (/participacao_em_acoes_sem_voto|acoes_sem_voto/.test(tipo)) {
    return periodo ? `As ações sem voto de ${destino} detidas por ${origem}, ${periodo}` : `As ações sem voto de ${destino} detidas por ${origem}`
  }
  if (/decisao_judicial/.test(tipo)) {
    return periodo ? `${destino}, ${periodo}: a decisão judicial documentada` : `${destino}: a decisão judicial documentada`
  }
  if (/incorporacao|reorganizacao/.test(tipo)) {
    return periodo ? `${destino}, ${periodo}: a ${tipoLabel} documentada` : `${destino}: a ${tipoLabel} documentada`
  }
  if (/cargo|direcao|governanca/.test(tipo)) {
    return periodo ? `${origem} em ${destino}, ${periodo}` : `${origem} em ${destino}`
  }
  if (/financiamento|doacao|subscricao|subscritor|transferencia/.test(tipo)) {
    return periodo ? `${origem} e ${destino}: ${tipoLabel}, ${periodo}` : `${origem} e ${destino}: ${tipoLabel}`
  }
  if (/vinculo_empresarial/.test(tipo)) {
    return periodo ? `${destino} no grupo, ${periodo}` : `${destino}: o vínculo empresarial documentado`
  }
  if (/fundac[aã]o/.test(tipo) && /estabeleceu|fundou|criou/.test(af)) {
    return year || periodo ? `A fundação que ${origem} estabeleceu em ${year || periodo}` : `A fundação que ${origem} estabeleceu`
  }
  if (/lista|ciac/.test(af) && /founder|fundador/.test(af)) {
    return date ? `${origem} na lista da ${destino} de ${date}` : `${origem} na lista da ${destino}`
  }
  if (/fundac[aã]o/.test(tipo) && /cofundador|fundador/.test(af)) {
    const papel = /cofundador/.test(af) ? 'cofundador' : 'fundador'
    return year || periodo ? `${origem}, ${papel} de ${destino} em ${year || periodo}` : `${origem}, ${papel} de ${destino}`
  }
  if (tipoLabel && periodo) return `${origem} e ${destino}, ${periodo}`
  if (tipoLabel) return `${origem} e ${destino}`
  return periodo ? `${origem} e ${destino}, ${periodo}` : `${origem} e ${destino}`
}

export function ensureGapSentence(text: string): string {
  let s = (text || '').trim()
  if (!s) return 'A base não mostra todos os termos desse vínculo.'
  s = s[0]!.toUpperCase() + s.slice(1)
  if (!/[.!?]$/.test(s)) s += '.'
  return s
}

export function limiteToGap(r: ChatContextRelation): string {
  const raw = (r.limite || '').trim().replace(/\s*[—–-]\s*ver lacuna\.?$/i, '').trim()
  if (!raw) return 'A base não mostra todos os termos desse vínculo.'
  const lim = fold(raw)
  const af = r.afirmacao || ''
  if (/diverg/.test(lim)) {
    const jan = /janeiro|january/i.test(af)
    const rcm = raw.match(/(\d{1,2}º?\/\d{2}\/\d{4})/)
    if (jan && rcm) {
      return `A RIT diz que a venda terminou em janeiro de 2018; a RCM registra o fechamento em ${rcm[1]}; a base não explica a diferença.`
    }
    return /base n[aã]o/.test(lim) ? ensureGapSentence(raw) : ensureGapSentence(`${raw}. A base não explica a diferença`.replace(/\.\./g, '.'))
  }
  if ((/lista|cabe[cç]alho|as of october|founder|fundador/.test(lim)) && !/n[aã]o (mostra|demonstra|individualiza|equivale|divulga)/.test(lim)) {
    return 'A lista diz que ele consta como fundador; a base não mostra o que isso implica hoje.'
  }
  if (/^retrato\b/.test(lim) || (/retrato da estrutura/.test(lim) && !/n[aã]o mostra/.test(lim))) {
    const body = raw.replace(/^Retrato da\s+/i, '').replace(/\.$/, '')
    return `A fonte retrata a ${body}; a base não mostra o que mudou depois.`
  }
  return ensureGapSentence(publicChatText(raw))
}

export function gapText(r: ChatContextRelation, pressure = false): string {
  const legal = 'A base não mostra prova de ilegalidade nesse vínculo.'
  const gap = limiteToGap(r)
  if (pressure) return r.limite?.trim() ? `${gap} ${legal}` : legal
  return gap
}

export function nextStep(r: ChatContextRelation, fonte?: ChatContextFonte, pressure = false): string {
  if (pressure) return 'Procurar o documento que decidiria a legalidade desse vínculo.'
  const limite = fold(r.limite || '')
  const bruto = fonte?.titulo ? publicChatText(fonte.titulo).split(' · ')[0].trim() : ''
  const titulo = bruto.length <= 70 ? bruto : (bruto.slice(0, 67).replace(/\s+\S*$/, '') + '…')
  const conferir = titulo && (titulo.match(/\(/g) || []).length === (titulo.match(/\)/g) || []).length && !titulo.endsWith('…')
    ? `Conferir ${titulo}` : ''
  const tipo = fold(r.tipo || '')
  if (/diverg|conflit|data de conclus/.test(limite)) {
    return conferir ? `${conferir} e confrontar as datas das fontes.` : 'Confrontar as datas e as versões das fontes citadas.'
  }
  if (/percentual|quantifica|nao divulga|não divulga|fatia|30,8|votos/.test(limite) && /particip|acion|controle|veiculo/.test(tipo + ' ' + limite)) {
    return conferir ? `${conferir} e a tabela de participações com os percentuais.` : 'Procurar a tabela de participações e os percentuais de cada parte.'
  }
  if (/liquidado|compromisso nao equivale|compromisso não equivale|desembolso/.test(limite)) {
    return conferir ? `${conferir} e o comprovante do valor liquidado.` : 'Procurar o comprovante do valor liquidado em caixa.'
  }
  if (/fundacao|fundador/.test(tipo) || /controle atual|beneficiario|beneficiário/.test(limite)) {
    return conferir ? `${conferir} e os relatórios recentes sobre o que a fonte ainda demonstra.` : 'Procurar os relatórios recentes da instituição e o que ainda é demonstrado hoje.'
  }
  if (/controle|nao equivale a controle|não equivale a controle/.test(limite) || /controle/.test(tipo)) {
    return conferir ? `${conferir} e o acordo de acionistas com os percentuais de controle.` : 'Procurar o acordo de acionistas e os percentuais de controle.'
  }
  if (/instrumento|nao se leu|não se leu|nao verific/.test(limite)) {
    return conferir ? `${conferir} e o instrumento societário citado.` : 'Procurar o instrumento societário citado e seus termos.'
  }
  if (conferir) return `${conferir} no ponto em que a fonte descreve o vínculo.`
  if (/financ|doa|subscr|particip|acion|propriedade|controle/.test(tipo)) return 'Procurar o contrato ou relatório de participação e seus termos.'
  if (/fund|criacao/.test(tipo)) return 'Procurar o estatuto e as atas de criação.'
  return 'Procurar o documento original e a correspondência sobre o vínculo.'
}

function hookSuffix(title: string): string {
  return title.includes(':') ? title.slice(title.indexOf(':') + 1).trim() : title
}

function uniqueTitles(rows: ChatContextRelation[], entities: Map<string, { nome?: string }>, fontesById?: Map<string, ChatContextFonte>): string[] {
  const of = (r: ChatContextRelation) => (r.fontes || []).map(id => fontesById?.get(id)).filter((f): f is ChatContextFonte => !!f)
  const used = new Set<string>()
  const usedHooks = new Set<string>()
  return rows.map((r) => {
    let title = hookTitle(r, entities, of(r))
    if (used.has(fold(title)) || usedHooks.has(fold(hookSuffix(title)))) {
      const tipo = publicChatText((r.tipo || 'vínculo').replace(/_/g, ' '))
      const base = `${entityName(entities, r.origem)} e ${entityName(entities, r.destino)}${r.periodo ? ', ' + publicChatText(r.periodo) : ''}`
      title = tipo ? `${base}: ${tipo}` : base
    }
    if ((used.has(fold(title)) || usedHooks.has(fold(hookSuffix(title)))) && r.periodo) {
      title = `${entityName(entities, r.origem)} e ${entityName(entities, r.destino)}, ${publicChatText(r.periodo)}`
    }
    used.add(fold(title))
    usedHooks.add(fold(hookSuffix(title)))
    return title
  })
}

function mergeContext(a: ChatContextPayload, b: ChatContextPayload): ChatContextPayload {
  const union = <T extends { id: string }>(x: T[], y: T[], max: number): T[] => [...new Map([...x, ...y].map(v => [v.id, v])).values()].slice(0, max)
  return { ...a, raizes: a.raizes.length ? a.raizes : b.raizes, entidades: union(a.entidades, b.entidades, 300), relacoes: union(a.relacoes, b.relacoes, 300), fontes: union(a.fontes, b.fontes, 200), casos: [] }
}
export interface PautaPlan { avisos: string[]; query?: string }
export interface PautaHooks { titulos: string[]; pergunta: string }
export async function expandPautaContext(db: ChatDb, initial: ChatContextPayload, query: string, restantes = Number.POSITIVE_INFINITY): Promise<{ context: ChatContextPayload; plan: PautaPlan }> {
  let context = initial
  const plan: PautaPlan = { avisos: [], query }
  let usadas = 0
  const enough = () => pautaRelations(context, query).length >= 3
  // (a) O chamador já consultou nome/aliases na mesma RPC de produção.
  // `restantes` é o saldo do teto da requisição. Sem saldo, não consulta.
  if (!enough()) {
    const related = context.entidades.filter(e => /familia|fundacao|instituicao|associacao/.test(e.tipo || '')).slice(0, 3).map(e => e.id)
    if (related.length && usadas < restantes) {
      usadas += 1
      context = mergeContext(context, await db.chatContext(related, null))
      plan.avisos.push('Ampliei para a família e instituições ligadas.')
    }
  }
  if (!enough()) {
    const roots = new Set(context.raizes.map(e => e.id))
    const neighbors = [...new Set(context.relacoes.filter(r => roots.has(r.origem || '') || roots.has(r.destino || '')).flatMap(r => [r.origem, r.destino]))].filter((id): id is string => !!id && !roots.has(id)).slice(0, 3)
    if (neighbors.length && usadas < restantes) {
      usadas += 1
      context = mergeContext(context, await db.chatContext(neighbors, null))
      plan.avisos.push('Ampliei para vizinhos a um salto.')
    }
  }
  if (!enough()) {
    const axis = fold(query).match(/\b(petroleo|educacao|saude|financiamento|bancos?|museu|divida|fundacao)\b/)?.[0] || ''
    const families = ['rockefeller', 'rothschild', 'morgan'].filter(name => !fold(query).includes(name))
    // Uma consulta por família; o número de fontes/relações e o envelope do prompt continuam limitados.
    let buscouFamilia = false
    for (const name of families) {
      if (usadas >= restantes) break
      usadas += 1
      buscouFamilia = true
      const other = await db.chatContext([], `${name} ${axis}`.trim())
      context = mergeContext(context, other)
      if (enough()) break
    }
    if (buscouFamilia || families.length === 0) {
      plan.avisos.push(initial.raizes.length ? 'Saí do recorte pedido e ampliei o mesmo eixo para outras famílias da base.' : 'A base não tem material nesse recorte. Ofereço alternativas documentadas de outras famílias da base.')
    }
  }
  const relacoes = selectPautaRelations(context, query)
  const entityIds = new Set([...context.raizes.map(e => e.id), ...relacoes.flatMap(r => [r.origem, r.destino])])
  const sourceIds = new Set(relacoes.flatMap(r => r.fontes || []))
  context = { raizes: context.raizes.slice(0, 3), entidades: context.entidades.filter(e => entityIds.has(e.id)), relacoes,
    fontes: context.fontes.filter(f => sourceIds.has(f.id)).slice(0, 12), casos: [] }
  return { context: sanitizePublicContext(context), plan }
}

const ACCUSATION = /\b(?:inculpa\w*|conspir\w*|lavagem|fraud[ae]\w*|culpad\w*|suborn\w*|soneg\w*|esquema\w*|esc[aâ]ndalo\w*|ocultou|acusad[oa]s? de|lucraram(?:\s+\w+){0,4}\s+ilegal|(?:cometeram|cometer)\s+crime|agiu ilegalmente)\b/i
const INTERNAL_PUBLIC = /t14_epstein|Epstein\s*[×x]|pauta[-_ ]?\d+|\.md\b|relationship_id|research_cluster/i
const SNAKE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/
const LABEL_DUP = /o que ainda [eé] hip[oó]tese\s*\/\s*lacuna/i

export function parsePautaHooks(raw: unknown, count: number): PautaHooks | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as { titulos?: unknown; pergunta?: unknown; hooks?: unknown }
  const source = Array.isArray(row.titulos) ? row : (row.hooks && typeof row.hooks === 'object' ? row.hooks as { titulos?: unknown; pergunta?: unknown } : null)
  if (!source || !Array.isArray(source.titulos) || typeof source.pergunta !== 'string') return null
  const titulos = source.titulos.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(t => t.trim())
  const pergunta = source.pergunta.trim()
  if (titulos.length < Math.min(count, 1) || !pergunta.endsWith('?')) return null
  return { titulos: titulos.slice(0, count), pergunta: pergunta.slice(0, 300) }
}

export function validatePautaAnswer(answer: SanitizedAnswer, ctx: ChatContextPayload): { ok: boolean; motivos: string[] } {
  const motivos: string[] = []
  const knownSources = new Set(ctx.fontes.map(f => f.id))
  const facts = answer.blocos.filter(b => b.tipo === 'documentado')
  const hyps = answer.blocos.filter(b => b.tipo === 'hipotese')
  const titles: string[] = []
  for (const b of facts) {
    for (const id of b.fontes) if (!knownSources.has(id)) motivos.push(`fonte ausente do contexto: ${id}`)
    if (!b.texto.includes('Fato documentado:') || !b.texto.includes('Fonte:')) motivos.push('formato do Fato incompleto')
    const title = (b.texto.split('\n')[0] || '').replace(/^\d+\.\s*/, '')
    titles.push(fold(title))
  }
  if (new Set(titles).size !== titles.length) motivos.push('títulos repetidos')
  const hookKeys = titles.map(t => fold(t.includes(':') ? t.slice(t.indexOf(':') + 1).trim() : t))
  if (new Set(hookKeys).size !== hookKeys.length) motivos.push('ganchos repetidos')
  for (const b of hyps) {
    if (!b.texto.includes('Próximo passo:')) motivos.push('formato da Hipótese incompleto')
    if (LABEL_DUP.test(b.texto)) motivos.push('rótulo de hipótese/lacuna duplicado no texto')
    const comprovado = b.texto.match(/Não comprovado na base/g) || []
    if (comprovado.length > 1) motivos.push('«Não comprovado na base» repetido')
    const gapLine = (b.texto.split('\n')[0] || '').trim()
    if (gapLine && !/^[A-ZÁÉÍÓÚÂÊÔÃÕÀ0-9«“"]/.test(gapLine)) motivos.push('lacuna sem maiúscula inicial')
    if (gapLine && !/[.!?]$/.test(gapLine)) motivos.push('lacuna sem ponto final')
  }
  const prose = [...answer.blocos.map(b => b.texto), answer.em_aberto || '', ...answer.avisos.map(a => a.texto)].join('\n')
  if (PROCESS_NOTE.test(prose) || /usar o PDF/i.test(prose)) motivos.push('nota de processo no texto público')
  const forAcc = prose.replace(/A base não mostra prova de ilegalidade nesse vínculo\./g, '')
  if (ACCUSATION.test(forAcc) && !/[«“"].{0,40}\b(?:ilegal|crime|lavagem|esquema|esc[aâ]ndalo)/i.test(forAcc)) motivos.push('verbo de acusação no texto público')
  if (INTERNAL_PUBLIC.test(prose) || SNAKE.test(prose)) motivos.push('id interno ou snake_case no texto público')
  if (!pressureHasQuestion(answer) && facts.length > 0 && !((answer.em_aberto || '') + (answer.blocos.at(-1)?.texto || '')).includes('?')) {
    motivos.push('falta a pergunta final')
  }
  return { ok: motivos.length === 0, motivos }
}
function pressureHasQuestion(answer: SanitizedAnswer): boolean {
  return /\?\s*$/.test((answer.em_aberto || '') + (answer.blocos.at(-1)?.texto || ''))
}

export function applyPautaHooks(answer: SanitizedAnswer, hooks: PautaHooks, ctx: ChatContextPayload): { answer: SanitizedAnswer; used: boolean; motivos: string[] } {
  const facts = answer.blocos.filter(b => b.tipo === 'documentado')
  const titulos = hooks.titulos.slice(0, facts.length)
  const motivos: string[] = []
  if (titulos.length !== facts.length) motivos.push('número de ganchos diferente do número de temas')
  const folded = titulos.map(t => fold(t))
  if (new Set(folded).size !== folded.length) motivos.push('ganchos repetidos')
  for (const t of titulos) {
    if (ACCUSATION.test(t) || INTERNAL_PUBLIC.test(t) || SNAKE.test(t) || t.length > 180) motivos.push('gancho inválido')
  }
  if (!hooks.pergunta.endsWith('?') || ACCUSATION.test(hooks.pergunta) || INTERNAL_PUBLIC.test(hooks.pergunta) || SNAKE.test(hooks.pergunta)) {
    motivos.push('pergunta final inválida')
  }
  if (motivos.length) return { answer, used: false, motivos }
  const blocos = answer.blocos.map((b, _i) => {
    if (b.tipo !== 'documentado') return b
    const factIndex = facts.indexOf(b)
    const hook = titulos[factIndex]
    if (!hook) return b
    const lines = b.texto.split('\n')
    const prefix = lines[0].match(/^\d+\.\s*/)?.[0] || `${factIndex + 1}. `
    lines[0] = `${prefix}${hook.replace(/^\d+\.\s*/, '')}`
    return { ...b, texto: lines.join('\n') }
  })
  const next: SanitizedAnswer = { ...answer, blocos, em_aberto: hooks.pergunta }
  const check = validatePautaAnswer(next, ctx)
  if (!check.ok) return { answer, used: false, motivos: check.motivos }
  return { answer: next, used: true, motivos: [] }
}

export function buildPautaAnswer(ctx: ChatContextPayload, plan: PautaPlan, raw?: unknown, pressure = false, hooks?: PautaHooks | null): SanitizedAnswer {
  ctx = sanitizePublicContext(ctx)
  const requested = raw && typeof raw === 'object' && Array.isArray((raw as { blocos?: unknown[] }).blocos)
    ? ((raw as { blocos: Array<{ relacoes?: string[] }> }).blocos).flatMap(b => Array.isArray(b?.relacoes) ? b.relacoes : []) : []
  const chosen = selectPautaRelations(ctx, plan.query, requested, pressure)
  const sources = new Map(ctx.fontes.filter(isCitableSource).map(f => [f.id, f]))
  const entities = new Map([...ctx.raizes, ...ctx.entidades].map(e => [e.id, e]))
  const titles = uniqueTitles(chosen, entities, sources)
  const answer: SanitizedAnswer = { blocos: [], fontes: [], fontes_detalhe: {}, entidades: [], avisos: plan.avisos.map(texto => ({ tipo: 'outro', texto })), sem_base: chosen.length === 0, em_aberto: pressure ? 'Qual documento devemos conferir primeiro?' : 'Qual desses temas você quer aprofundar?' }
  for (const [i, r] of chosen.entries()) {
    const ids = (r.fontes || []).filter(id => sources.has(id)).slice(0, 2)
    const ends = [r.origem, r.destino].filter((id): id is string => !!id && entities.has(id))
    const names = contextEntityNames(ctx, [r.origem, r.destino])
    const locator = ids.map(id => {
      const loc = sources.get(id)?.localizador
      const clipped = loc ? relevantLocator(loc, names) : ''
      return clipped ? `${id} · ${clipped}` : id
    }).join('; ')
    const title = `${i + 1}. ${titles[i]}`
    const fonte = ids[0] ? sources.get(ids[0]) : undefined
    const cited = ids.map(id => sources.get(id)!).filter(Boolean)
    answer.blocos.push({ tipo: 'documentado', texto: `${title}\n${factText(r, cited)}\nFonte: ${locator}`, entidades: ends, relacoes: [r.id], fontes: ids })
    answer.blocos.push({ tipo: 'hipotese', texto: `${gapText(r, pressure)}\nPróximo passo: ${nextStep(r, fonte, pressure)}`, base: [], justificativa: 'Lacuna; não é uma acusação.' })
    for (const id of ids) if (!answer.fontes.includes(id)) {
      answer.fontes.push(id)
      const f = sources.get(id)!
      const detalheLoc = f.localizador ? relevantLocator(f.localizador, names) : ''
      answer.fontes_detalhe[id] = { titulo: publicChatText(f.titulo || id), ...(f.url ? { url: f.url } : {}), ...(detalheLoc ? { localizador: detalheLoc } : {}) }
    }
    for (const id of ends) if (!answer.entidades.some(e => e.id === id)) answer.entidades.push({ id, nome: publicChatText(entities.get(id)?.nome || id) })
  }
  if (!pressure && chosen.length < 3) answer.avisos.push({ tipo: 'outro', texto: 'A base ainda é curta nesse tema; estes são os vínculos com fonte disponíveis.' })
  const parsed = hooks || parsePautaHooks(raw, chosen.length)
  if (parsed) {
    const applied = applyPautaHooks(answer, parsed, ctx)
    if (applied.used) return applied.answer
  }
  return answer
}
