// Harness local do clone site. Migrações deste clone, a 013 e a 015.
// A 012 não entra: já é de outro trabalho e não faz parte deste PR.
// A 014 não entra: está reservada ao rascunho do Asaas.
// PGLITE_PATH aponta para o pacote WASM já instalado. Sem DSN e sem rede.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { PGlite } = await import(process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : '@electric-sql/pglite')
const db = new PGlite()
try {
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)')
  for (const role of ['atlas_reader','chat_writer','chat_fn','anon','authenticated','service_role']) await db.exec(`CREATE ROLE ${role} NOLOGIN`)
  const names = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()
  if (names.some(name => name.startsWith('012_'))) throw new Error('A 012 não pode entrar no clone site.')
  if (!names.some(name => name.startsWith('013_'))) throw new Error('Migração 013 ausente.')
  if (!names.some(name => name.startsWith('015_'))) throw new Error('Migração 015 ausente.')
  if (names.some(name => name.startsWith('014_'))) throw new Error('A 014 não pode entrar neste clone.')
  for (const file of names) await db.exec((await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')).replace(/^\\gexec\s*$/m, ';'))
  await db.exec(await readFile(new URL('013_telegram_vinculo_test.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('015_telegram_session_reopen_test.sql', import.meta.url), 'utf8'))
  const { rows: functions } = await db.query("SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='chat_private' AND p.proname LIKE 'telegram_%'")
  assert.equal(functions.length, 9)
  const revocation = 'chat_private.telegram_link_revocations'
  const { rows: revocationRls } = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid='${revocation}'::regclass`)
  assert.equal(revocationRls[0].relrowsecurity, true)
  for (const role of ['anon', 'authenticated', 'chat_fn', 'chat_writer']) {
    const { rows } = await db.query(`SELECT has_table_privilege('${role}','${revocation}','SELECT,INSERT,UPDATE,DELETE') AS allowed`)
    assert.equal(rows[0].allowed, false, role)
  }
  await db.exec('SET ROLE chat_fn')
  const { rows } = await db.query('SELECT chat_private.telegram_claim_update(999999) AS ok')
  assert.equal(rows[0].ok, true)
  await db.exec('RESET ROLE')
  console.log('PASS site SQL: 013 e 015 sobre as migrações deste clone, sem a 012 e sem a 014')
} finally { await db.close() }
