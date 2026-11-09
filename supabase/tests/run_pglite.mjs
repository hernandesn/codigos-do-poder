// Offline, in-memory PostgreSQL. No credentials, sockets or persistent database.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { PGlite } from '@electric-sql/pglite'

// Import the same pure core used by the edge function, without Deno or network.
const coreUrl = new URL('../../supabase/functions/_shared/chat_core.ts', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url === coreUrl) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')),
    }
    return nextLoad(url, context)
  },
})
const { boundContextJson } = await import(coreUrl)
const db = new PGlite()
const root = new URL('../../', import.meta.url)
try {
  for (const role of ['atlas_reader', 'chat_writer', 'chat_fn', 'service_role', 'anon', 'authenticated']) {
    await db.exec(`CREATE ROLE ${role} NOLOGIN`)
  }
  for (const file of [
    '001_initial_knowledge_graph.sql', '002_chat_context.sql', '003_endurecer_acesso.sql',
    '004_chat_funcao.sql', '005_chat_context_texto_livre.sql',
  ]) {
    // 002's only psql directive creates the two roles already created above.
    const sql = (await readFile(new URL(`supabase/migrations/${file}`, root), 'utf8'))
      .replace(/^\\gexec\s*$/m, ';')
    await db.exec(sql)
    console.log(`APPLY ${file}`)
  }
  await db.exec(await readFile(process.env.ATLAS_SYNC_SQL ?? new URL('dados/006_sync_atlas_dataset.sql', root), 'utf8'))
  console.log('APPLY 006_sync_atlas_dataset.sql')
  console.log('SKIP 007_chat_unlimited_users.sql: requires Supabase auth.users; unrelated to chat_context')
  await db.exec(`
    CREATE TEMP TABLE spec3_explicit_before AS
    SELECT ids, q, rel_cap, src_cap, public.chat_context(ids, q, rel_cap, src_cap) AS context
    FROM (VALUES
      (ARRAY['walther_ms'], NULL::text, 60, 40),
      (ARRAY['david_r', 'golpe64', 'rockefeller'], 'ignored query', 60, 40),
      (ARRAY[' walther_ms ', 'walther_ms', 'absent', 'rockefeller'], 'rockefeller', 5, 2),
      (ARRAY['absent'], 'rockefeller golpe de 64', 0, 0)
    ) t(ids, q, rel_cap, src_cap);
    GRANT SELECT ON spec3_explicit_before TO atlas_reader;
  `)
  const migration = await readFile(new URL('supabase/migrations/008_chat_context_temas.sql', root), 'utf8')
  await db.exec(migration)
  await db.exec(migration)
  console.log('APPLY 008_chat_context_temas.sql (twice: idempotence)')
  await db.exec('ANALYZE')
  for (const file of ['008_chat_context_temas_test.sql', '005_chat_context_test.sql']) {
    await db.exec('BEGIN; SET LOCAL ROLE atlas_reader;')
    try {
      await db.exec(await readFile(new URL(`supabase/tests/${file}`, root), 'utf8'))
      console.log(`PASS ${file}`)
      if (file.startsWith('008')) {
        for (const q of ['qual a relação dos Rockefeller com o golpe de 64', 'rockefeller rothschild soros']) {
          const { rows: [{ context }] } = await db.query(
            'SELECT pg_temp.timed_context($1, q => $1) AS context', [q],
          )
          const bounded = boundContextJson(context)
          const parsed = JSON.parse(bounded)
          assert.ok(bounded.length <= 8000, `integrated context too large: ${bounded.length}`)
          assert.ok(!parsed.truncado, 'rooted SQL context became a stub')
          assert.deepEqual(parsed.raizes, context.raizes)
          assert.deepEqual(parsed.ligacoes_entre_raizes, context.ligacoes_entre_raizes)
          assert.ok(parsed.ligacoes_entre_raizes.length <= 3, 'at most one representative per root pair')
          for (const path of parsed.ligacoes_entre_raizes) {
            for (const id of path.relacoes) assert.ok(parsed.relacoes.some((r) => r.id === id))
            if (path.via) assert.ok(parsed.entidades.some((e) => e.id === path.via))
          }
          console.log(`BOUND ${q}: ${JSON.stringify(context).length} -> ${bounded.length} chars; roots=${parsed.raizes.map((r) => r.id).join(',')}; paths=${parsed.ligacoes_entre_raizes.length}; first_relations=${parsed.relacoes.slice(0, 3).map((r) => r.id).join(',')}`)
        }
        const { rows } = await db.query('SELECT label, elapsed_ms FROM spec3_timings ORDER BY ordinal')
        for (const row of rows) console.log(`TIME ${row.label}: ${Number(row.elapsed_ms).toFixed(3)} ms`)
        const max = Math.max(...rows.map((row) => Number(row.elapsed_ms)))
        console.log(`${rows.length} timed calls; max ${max.toFixed(3)} ms; all < 500 ms`)
      }
    } finally {
      await db.exec('ROLLBACK')
    }
  }
  console.log('PGlite: 2 SQL suites passed, 0 failed')
} catch (error) {
  // Avoid dumping a complete migration/dataset through the driver's error object.
  console.error(`FAIL PGlite: ${error.message}`)
  if (error.detail) console.error(`DETAIL ${error.detail}`)
  if (error.where) console.error(`WHERE ${error.where}`)
  process.exitCode = 1
} finally {
  await db.close()
}
