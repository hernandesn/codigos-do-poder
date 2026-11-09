// PGlite em memória com as migrações 001–005, o sync do atlas e a 008.
// Espelha supabase/tests/run_pglite.mjs. Não abre socket nem fala com o Supabase.

import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const MIGRATIONS = [
  '001_initial_knowledge_graph.sql',
  '002_chat_context.sql',
  '003_endurecer_acesso.sql',
  '004_chat_funcao.sql',
  '005_chat_context_texto_livre.sql',
]

const ROLES = ['atlas_reader', 'chat_writer', 'chat_fn', 'service_role', 'anon', 'authenticated']

const EMPTY_CONTEXT = {
  raizes: [],
  entidades: [],
  relacoes: [],
  fontes: [],
  casos: [],
  limites: { relacoes: 0, fontes: 0, truncado: false },
}

function repoRoot() {
  return new URL('../../', import.meta.url)
}

function stripGexec(sql) {
  return sql.replace(/^\\gexec\s*$/gm, ';')
}

export async function openAtlas(syncPath) {
  const db = new PGlite()
  const root = repoRoot()
  try {
    for (const role of ROLES) {
      await db.exec(`CREATE ROLE ${role} NOLOGIN`)
    }
    for (const file of MIGRATIONS) {
      const sql = stripGexec(await readFile(new URL(`supabase/migrations/${file}`, root), 'utf8'))
      await db.exec(sql)
    }
    await db.exec(stripGexec(await readFile(syncPath, 'utf8')))
    const migration008 = await readFile(new URL('supabase/migrations/008_chat_context_temas.sql', root), 'utf8')
    await db.exec(migration008)
    await db.exec('ANALYZE')
    const ids = await loadIds(db)
    return {
      ids,
      emptyContext: () => structuredClone(EMPTY_CONTEXT),
      async chatContext(entityIds, query) {
        const idsArg = Array.isArray(entityIds) ? entityIds : []
        const q = query == null ? null : String(query)
        const result = await db.query(
          'SELECT public.chat_context($1::text[], $2::text, 60, 40) AS ctx',
          [idsArg, q],
        )
        const raw = result.rows[0]?.ctx
        if (raw == null) return structuredClone(EMPTY_CONTEXT)
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        return parsed ?? structuredClone(EMPTY_CONTEXT)
      },
      async close() {
        await db.close()
      },
    }
  } catch (error) {
    await db.close().catch(() => {})
    const message = error instanceof Error ? error.message : 'falha ao abrir o atlas'
    const wrapped = new Error(`falha ao carregar o sync SQL: ${message}`)
    throw wrapped
  }
}

async function loadIds(db) {
  const entidades = new Set(await column(db, 'SELECT entity_id FROM entities'))
  const relacoes = new Set(await column(db, 'SELECT relationship_id FROM relationships'))
  const fontes = new Set(await column(db, 'SELECT source_id FROM sources'))
  const casos = new Set(await column(db, 'SELECT case_id FROM investigation_cases'))
  return { entidades, relacoes, fontes, casos }
}

async function column(db, sql) {
  const result = await db.query(sql)
  const key = Object.keys(result.rows[0] ?? {})[0]
  if (!key) return []
  return result.rows.map((row) => String(row[key]))
}

export function idsFromContext(ctx) {
  const entidades = new Set()
  const relacoes = new Set()
  const fontes = new Set()
  for (const item of [...(ctx?.raizes ?? []), ...(ctx?.entidades ?? [])]) {
    if (item?.id) entidades.add(item.id)
  }
  for (const rel of ctx?.relacoes ?? []) {
    if (rel?.id) relacoes.add(rel.id)
    if (rel?.origem) entidades.add(rel.origem)
    if (rel?.destino) entidades.add(rel.destino)
    for (const fonte of rel?.fontes ?? []) if (fonte) fontes.add(fonte)
  }
  for (const fonte of ctx?.fontes ?? []) if (fonte?.id) fontes.add(fonte.id)
  for (const link of ctx?.ligacoes_entre_raizes ?? []) {
    if (link?.de) entidades.add(link.de)
    if (link?.para) entidades.add(link.para)
    if (link?.via) entidades.add(link.via)
    for (const id of link?.relacoes ?? []) if (id) relacoes.add(id)
  }
  const casos = new Set()
  for (const caso of ctx?.casos ?? []) {
    if (typeof caso === 'string' && caso) casos.add(caso)
    else if (caso?.id) casos.add(caso.id)
  }
  return { entidades, relacoes, fontes, casos }
}
