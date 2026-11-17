// Repara só o token de citação. Não lê nem altera texto/justificativa.
// Um candidato entra se, depois da limpeza, for igual a um id do recorte.
// Nome de exibição só vale quando a string inteira é o nome de exatamente uma entidade.
// O campo segue a pertença no recorte (os conjuntos são disjuntos); fonte em inferência
// sobe para as fontes do topo. idKind classifica o formato; não aceita id ausente e
// não veta a pertença quando o prefixo discorda.

import type { ChatContextPayload } from './chat_core.ts'

export interface CitationNormalizeStats {
  prefixo: number
  json: number
  rotulo: number
  nome_exato: number
  campo: number
}

type StatKey = 'prefixo' | 'json' | 'rotulo' | 'nome_exato'
type Member = 'entidade' | 'relacao' | 'fonte' | 'caso' | 'conflict'
type Slot = 'entidades' | 'relacoes' | 'fontes'

interface Index {
  known: Set<string>
  membership: Map<string, Member>
  nomeToIds: Map<string, string[]>
}

interface Placement {
  from: string
  value: string
  to: Slot | null
  kinds: StatKey[]
  known: boolean
  rawNonString?: unknown
}

const CLOSER: Record<string, string> = {
  '"': '"',
  "'": "'",
  '`': '`',
  '[': ']',
  '{': '}',
}

const RELATION_PATTERNS: RegExp[] = [
  /^E\d+$/,
  /^PR\d+[a-z]?-E\d+$/,
  /^F\d+_C\d+$/,
  /^OP\d+_R\d+$/,
  /^ROM\d+$/,
  /^AP_E\d+$/,
  /^SOE\d+$/,
  /^ORI\d+$/,
  /^IN\d+$/,
  /^PAP\d+$/,
  /^BR\d+_BG\d+$/,
  /^BR\d+_B\d+$/,
  /^BR\d+_C\d+$/,
  /^BR\d+_G\d+$/,
  /^BR\d+_H\d+$/,
  /^LIN_K_SPOUSE\d+$/,
  /^LIN_K_F\d+$/,
  /^LIN_K_M\d+$/,
  /^LIN_R_B\d+$/,
  /^LIN_R_P\d+$/,
  /^LIN_R_I\d+$/,
]

const FONTE_PATTERNS: RegExp[] = [
  /^PR\d+[a-z]?-NF\d+$/,
  /^PR\d+-P\d+-F\d+$/,
  /^FEC\d+$/,
  /^SO\d+$/,
  /^BP\d+$/,
  /^AP\d+$/,
  /^S\d+$/,
  /^R\d+$/,
  /^B\d+$/,
  /^I\d+$/,
]

const CASO_PATTERN = /^OP(?:0[1-9]|[1-4]\d)$/
const ENTIDADE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:_C\d+)?$/
const LABEL_SEP = / \u00B7 | \u2014 | - |:/

export function idKind(id: string): 'entidade' | 'relacao' | 'fonte' | 'caso' | null {
  if (RELATION_PATTERNS.some((pattern) => pattern.test(id))) return 'relacao'
  if (FONTE_PATTERNS.some((pattern) => pattern.test(id))) return 'fonte'
  if (CASO_PATTERN.test(id)) return 'caso'
  if (ENTIDADE_PATTERN.test(id)) return 'entidade'
  return null
}

function emptyStats(): CitationNormalizeStats {
  return { prefixo: 0, json: 0, rotulo: 0, nome_exato: 0, campo: 0 }
}

function looseSpaces(value: string): string {
  return value.trim().replace(/[ \t]+/g, ' ')
}

function peelWrappers(input: string): string {
  let s = input.trim()
  for (let i = 0; i < 8 && s.length >= 2; i++) {
    const close = CLOSER[s[0]]
    if (!close || s[s.length - 1] !== close) break
    s = s.slice(1, -1).trim()
  }
  return s
}

function extractJsonId(value: string): string | null {
  const objectForm = value.match(/^\{\s*"id"\s*:\s*"([^"]*)"\s*\}$/i)
  const fragment = objectForm ?? value.match(/^id"\s*:\s*"([^"]*)"\s*$/i)
  if (!fragment) return null
  const id = fragment[1].trim()
  return id ? id : null
}

function stripPrefix(value: string): string | null {
  const match = value.match(/^id\s*[:=]\s*([\s\S]*)$/i)
  if (!match) return null
  return match[1].trim()
}

function labelPieces(value: string): string[] {
  const pieces: string[] = []
  let saw = false
  const without = value.replace(/\(([^)]*)\)/g, (_match, inner: string) => {
    saw = true
    pieces.push(inner)
    return '\n'
  })
  const parts = without.split(LABEL_SEP)
  if (parts.length > 1) saw = true
  if (!saw) return []
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed) pieces.push(trimmed)
  }
  return pieces
}

function cleanPiece(piece: string): string {
  let s = peelWrappers(piece.trim())
  const json = extractJsonId(s)
  if (json) return peelWrappers(json)
  const pref = stripPrefix(s)
  if (pref) return peelWrappers(pref)
  return s
}

function addMember(index: Index, id: unknown, kind: Member) {
  if (typeof id !== 'string' || !id) return
  index.known.add(id)
  const prev = index.membership.get(id)
  if (!prev) {
    index.membership.set(id, kind)
    return
  }
  if (prev === kind || prev === 'conflict') return
  const slot = (member: Member) => (member === 'entidade' || member === 'caso' ? 'entidades' : member)
  if (slot(prev) !== slot(kind)) index.membership.set(id, 'conflict')
}

function addNome(index: Index, id: string, nome: unknown) {
  if (typeof nome !== 'string') return
  const key = looseSpaces(nome)
  if (!key) return
  const list = index.nomeToIds.get(key)
  if (!list) index.nomeToIds.set(key, [id])
  else if (!list.includes(id)) list.push(id)
}

function buildIndex(ctx: ChatContextPayload): Index {
  const index: Index = { known: new Set(), membership: new Map(), nomeToIds: new Map() }
  for (const item of [...(ctx.raizes ?? []), ...(ctx.entidades ?? [])]) {
    if (!item || typeof item !== 'object') continue
    addMember(index, item.id, 'entidade')
    if (typeof item.id === 'string') addNome(index, item.id, item.nome)
  }
  for (const rel of ctx.relacoes ?? []) addMember(index, rel?.id, 'relacao')
  for (const fonte of ctx.fontes ?? []) addMember(index, fonte?.id, 'fonte')
  for (const caso of ctx.casos ?? []) {
    if (caso && typeof caso === 'object' && 'id' in caso) addMember(index, (caso as { id?: unknown }).id, 'caso')
  }
  return index
}

function resolveCitation(original: string, index: Index): { value: string; kinds: StatKey[] } {
  const kinds: StatKey[] = []
  let current = original.trim()
  const json = extractJsonId(current)
  if (json) {
    current = peelWrappers(json)
    kinds.push('json')
  } else {
    current = peelWrappers(current)
    const peeledJson = extractJsonId(current)
    if (peeledJson) {
      current = peelWrappers(peeledJson)
      kinds.push('json')
    } else {
      const pref = stripPrefix(current)
      if (pref !== null) {
        current = peelWrappers(pref)
        kinds.push('prefixo')
      }
    }
  }

  if (index.known.has(current)) return { value: current, kinds }
  const nomeIds = index.nomeToIds.get(looseSpaces(current))
  if (nomeIds && nomeIds.length === 1) return { value: nomeIds[0], kinds: [...kinds, 'nome_exato'] }

  const pieces = labelPieces(current)
  if (pieces.length) {
    const matched = new Set<string>()
    for (const piece of pieces) {
      const cleaned = cleanPiece(piece)
      if (index.known.has(cleaned)) matched.add(cleaned)
    }
    if (matched.size === 1) return { value: [...matched][0], kinds: [...kinds, 'rotulo'] }
  }
  return { value: original, kinds: [] }
}

function destOf(id: string, index: Index): Slot | null {
  const member = index.membership.get(id)
  if (member === 'relacao') return 'relacoes'
  if (member === 'fonte') return 'fontes'
  if (member === 'entidade' || member === 'caso') return 'entidades'
  return null
}

function collect(
  row: Record<string, unknown>,
  fields: readonly string[],
  destFn: (id: string, index: Index) => Slot | null,
  index: Index,
): Placement[] {
  const out: Placement[] = []
  for (const from of fields) {
    const arr = row[from]
    if (!Array.isArray(arr)) continue
    for (const item of arr) {
      if (typeof item !== 'string') {
        out.push({ from, value: '', to: null, kinds: [], known: false, rawNonString: item })
        continue
      }
      const hit = resolveCitation(item, index)
      const known = index.known.has(hit.value)
      out.push({
        from,
        value: known ? hit.value : item,
        to: known ? destFn(hit.value, index) : null,
        kinds: known ? hit.kinds : [],
        known,
      })
    }
  }
  return out
}

function applyPlacements(
  fields: readonly string[],
  placements: Placement[],
  stats: CitationNormalizeStats,
  move: boolean,
): Record<string, unknown[]> {
  const buckets: Record<string, unknown[]> = {}
  const seen: Record<string, Set<string>> = {}
  for (const field of fields) {
    buckets[field] = []
    seen[field] = new Set()
  }
  const push = (field: string, value: string) => {
    if (!buckets[field] || seen[field].has(value)) return
    seen[field].add(value)
    buckets[field].push(value)
  }
  for (const placement of placements) {
    if (placement.rawNonString !== undefined) {
      buckets[placement.from]?.push(placement.rawNonString)
      continue
    }
    const stays = !move || !placement.to || placement.to === placement.from
    if (!stays) continue
    push(placement.from, placement.value)
    if (placement.known) {
      for (const kind of placement.kinds) stats[kind] += 1
    }
  }
  if (!move) return buckets
  for (const placement of placements) {
    if (placement.rawNonString !== undefined || !placement.known || !placement.to || placement.to === placement.from) continue
    push(placement.to, placement.value)
    for (const kind of placement.kinds) stats[kind] += 1
    stats.campo += 1
  }
  return buckets
}

// Inferência não tem campo de fonte: fonte do recorte citada em base (ou no campo legado
// fontes do bloco) sobe para as fontes do topo. Só pertença no recorte; conflito fica.
function liftInferenceFontes(next: Record<string, unknown>, index: Index, lifted: string[], stats: CitationNormalizeStats) {
  for (const field of ['base', 'fontes'] as const) {
    const arr = next[field]
    if (!Array.isArray(arr)) continue
    const keep: unknown[] = []
    for (const item of arr) {
      if (typeof item === 'string' && index.membership.get(item) === 'fonte') {
        if (!lifted.includes(item)) lifted.push(item)
        stats.campo += 1
        continue
      }
      keep.push(item)
    }
    next[field] = keep
  }
}

function normalizeBloco(bloco: unknown, index: Index, stats: CitationNormalizeStats, lifted: string[] = []): unknown {
  if (!bloco || typeof bloco !== 'object' || Array.isArray(bloco)) return bloco
  const row = bloco as Record<string, unknown>
  const next: Record<string, unknown> = { ...row }
  if (row.tipo === 'documentado') {
    const fields = ['entidades', 'relacoes', 'fontes'] as const
    const buckets = applyPlacements(fields, collect(row, fields, destOf, index), stats, true)
    next.entidades = buckets.entidades
    next.relacoes = buckets.relacoes
    next.fontes = buckets.fontes
    return next
  }
  const fields = (['entidades', 'relacoes', 'fontes', 'base'] as const).filter((field) => Array.isArray(row[field]))
  if (!fields.length) return next
  const buckets = applyPlacements(fields, collect(row, fields, () => null, index), stats, false)
  for (const field of fields) next[field] = buckets[field]
  if (row.tipo === 'inferencia') liftInferenceFontes(next, index, lifted, stats)
  return next
}

function normalizeTop(record: Record<string, unknown>, index: Index, stats: CitationNormalizeStats) {
  const present = (['entidades', 'fontes'] as const).filter((field) => Array.isArray(record[field]))
  if (!present.length) return
  const fields = ['entidades', 'fontes'] as const
  const destTop = (id: string, ctx: Index): Slot | null => {
    const dest = destOf(id, ctx)
    return dest === 'relacoes' ? null : dest
  }
  const buckets = applyPlacements(fields, collect(record, present, destTop, index), stats, true)
  record.entidades = buckets.entidades
  record.fontes = buckets.fontes
}

export function normalizeCitations(raw: unknown, ctx: ChatContextPayload): { raw: unknown; stats: CitationNormalizeStats } {
  const stats = emptyStats()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { raw, stats }
  const index = buildIndex(ctx)
  const record = { ...(raw as Record<string, unknown>) }
  const lifted: string[] = []
  if (Array.isArray(record.blocos)) {
    record.blocos = record.blocos.map((bloco) => normalizeBloco(bloco, index, stats, lifted))
  }
  normalizeTop(record, index, stats)
  if (lifted.length) {
    const top = Array.isArray(record.fontes) ? [...record.fontes] : []
    const has = (id: string) => top.some((item) => item === id || (!!item && typeof item === 'object' && (item as { id?: unknown }).id === id))
    for (const id of lifted) if (!has(id)) top.push(id)
    record.fontes = top
  }
  return { raw: record, stats }
}
