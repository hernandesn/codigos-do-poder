// Golden set: JSONL (linhas vazias e // ignoradas) ou JSON (array).
// entidades_esperadas aceita string ou {id, id_pendente?}.

const EXPECTATIVAS = new Set(['documentado', 'inferencia', 'sem_ligacao', 'fora_da_base'])
const ENTITY_RE = /^[A-Za-z0-9_.:-]{1,120}$/

export class GoldenError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GoldenError'
  }
}

export function parseGolden(text, filename = 'golden') {
  const trimmed = String(text).replace(/^\uFEFF/, '')
  const lower = filename.toLowerCase()
  const items = lower.endsWith('.json') && !lower.endsWith('.jsonl')
    ? parseJson(trimmed)
    : parseJsonl(trimmed)
  if (items.length === 0) throw new GoldenError('golden inválido: nenhuma pergunta')
  const ids = new Set()
  return items.map((item, index) => normalizeItem(item, index + 1, ids))
}

export function idsDeEntidades(lista) {
  return (lista ?? []).map((item) => (typeof item === 'string' ? item : item.id))
}

function parseJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new GoldenError('golden inválido: JSON inválido')
  }
  if (!Array.isArray(data)) throw new GoldenError('golden inválido: o JSON precisa ser um array')
  return data
}

function parseJsonl(text) {
  const items = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('//')) continue
    try {
      items.push(JSON.parse(line))
    } catch {
      throw new GoldenError(`golden inválido: linha ${i + 1}: JSON inválido`)
    }
  }
  return items
}

function normalizeItem(item, ordem, ids) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new GoldenError(`golden inválido: pergunta ${ordem}: objeto esperado`)
  }
  const id = requiredString(item.id, `pergunta ${ordem}: id`)
  if (ids.has(id)) throw new GoldenError(`golden inválido: id repetido ${id}`)
  ids.add(id)
  const pergunta = requiredString(item.pergunta, `pergunta ${id}: pergunta`)
  if (!EXPECTATIVAS.has(item.expectativa)) {
    throw new GoldenError(`golden inválido: pergunta ${id}: expectativa deve ser documentado, inferencia, sem_ligacao ou fora_da_base`)
  }
  const entidadesContexto = stringArray(item.entidades_contexto, `pergunta ${id}: entidades_contexto`)
  if (entidadesContexto.length > 3) {
    throw new GoldenError(`golden inválido: pergunta ${id}: no máximo 3 entidades_contexto`)
  }
  for (const entityId of entidadesContexto) {
    if (!ENTITY_RE.test(entityId)) {
      throw new GoldenError(`golden inválido: pergunta ${id}: entidade_contexto ${entityId}`)
    }
  }
  if (item.voz_aion_obrigatoria !== undefined && typeof item.voz_aion_obrigatoria !== 'boolean') {
    throw new GoldenError(`golden inválido: pergunta ${id}: voz_aion_obrigatoria deve ser boolean`)
  }
  if (item.categoria !== undefined && item.categoria !== null && typeof item.categoria !== 'string') {
    throw new GoldenError(`golden inválido: pergunta ${id}: categoria deve ser texto`)
  }
  if (item.contexto_fixture !== undefined && typeof item.contexto_fixture !== 'string') {
    throw new GoldenError(`golden inválido: pergunta ${id}: contexto_fixture deve ser caminho`)
  }
  if (item.notas !== undefined && typeof item.notas !== 'string') {
    throw new GoldenError(`golden inválido: pergunta ${id}: notas deve ser texto`)
  }
  if (item.mock_resposta !== undefined && item.mock_resposta !== null) {
    if (typeof item.mock_resposta !== 'object' || Array.isArray(item.mock_resposta)) {
      throw new GoldenError(`golden inválido: pergunta ${id}: mock_resposta deve ser objeto`)
    }
  }
  return {
    id,
    pergunta,
    expectativa: item.expectativa,
    categoria: typeof item.categoria === 'string' ? item.categoria.trim() : '',
    entidades_esperadas: entidadesEsperadas(item.entidades_esperadas, `pergunta ${id}: entidades_esperadas`),
    fontes_esperadas: stringArray(item.fontes_esperadas, `pergunta ${id}: fontes_esperadas`),
    conexoes_esperadas: stringArray(item.conexoes_esperadas, `pergunta ${id}: conexoes_esperadas`),
    deve_conter: stringArray(item.deve_conter, `pergunta ${id}: deve_conter`),
    nao_deve_conter: stringArray(item.nao_deve_conter, `pergunta ${id}: nao_deve_conter`),
    entidades_contexto: entidadesContexto,
    voz_aion_obrigatoria: item.voz_aion_obrigatoria === true,
    contexto_fixture: typeof item.contexto_fixture === 'string' ? item.contexto_fixture : null,
    mock_resposta: item.mock_resposta ?? null,
    notas: typeof item.notas === 'string' ? item.notas : '',
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new GoldenError(`golden inválido: ${label} ausente`)
  return value.trim()
}

function stringArray(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new GoldenError(`golden inválido: ${label} deve ser lista de strings`)
  }
  return value
}

function entidadesEsperadas(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new GoldenError(`golden inválido: ${label} deve ser lista`)
  return value.map((item, index) => {
    if (typeof item === 'string') {
      if (!item.trim()) throw new GoldenError(`golden inválido: ${label} item ${index + 1} vazio`)
      return { id: item.trim(), id_pendente: null }
    }
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim()) {
      throw new GoldenError(`golden inválido: ${label} item ${index + 1} deve ser string ou {id}`)
    }
    const pendente = item.id_pendente
    if (pendente !== undefined && pendente !== null && typeof pendente !== 'boolean' && typeof pendente !== 'string' && typeof pendente !== 'number') {
      throw new GoldenError(`golden inválido: ${label} item ${index + 1}: id_pendente inválido`)
    }
    return { id: item.id.trim(), id_pendente: pendente === undefined ? null : pendente }
  })
}
