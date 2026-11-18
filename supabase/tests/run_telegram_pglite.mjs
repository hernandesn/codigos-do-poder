// Somente banco WASM descartável. PGLITE_PATH aponta para pacote já instalado na box.
// Não lê DSN, não abre rede e não aplica nada em produção.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { PGlite } = await import(process.env.PGLITE_PATH ? pathToFileURL(process.env.PGLITE_PATH).href : '@electric-sql/pglite')
const db = new PGlite()
try {
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)')
  // service_role é apenas um papel vazio exigido pelas migrações antigas; não há chave.
  for (const role of ['atlas_reader','chat_writer','chat_fn','anon','authenticated','service_role']) await db.exec(`CREATE ROLE ${role} NOLOGIN`)
  const files = ['001_initial_knowledge_graph.sql','002_chat_context.sql','003_endurecer_acesso.sql','004_chat_funcao.sql','005_chat_context_texto_livre.sql','007_chat_unlimited_users.sql','008_chat_context_temas.sql','009_chat_context_genericos.sql','010_chat_rate_touch_no_overflow.sql','012_limites_ip_contas_novas.sql','013_telegram_vinculo.sql']
  for (const file of files) await db.exec((await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).replace(/^\\gexec\s*$/m,';'))
  await db.exec(await readFile(new URL('013_telegram_vinculo_test.sql',import.meta.url),'utf8'))
  const tables = ['telegram_links','telegram_link_codes','telegram_link_revocations','telegram_updates','telegram_rate','telegram_initdata_replay']
  for (const table of tables) {
    const {rows} = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid='chat_private.${table}'::regclass`)
    assert.equal(rows[0].relrowsecurity,true)
    for (const role of ['anon','authenticated','chat_fn','chat_writer']) {
      const {rows} = await db.query(`SELECT has_table_privilege('${role}','chat_private.${table}','SELECT,INSERT,UPDATE,DELETE') AS allowed`)
      assert.equal(rows[0].allowed,false,`${role}/${table}`)
    }
  }
  const {rows: functions} = await db.query("SELECT p.oid::regprocedure::text AS signature,prosecdef,proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='chat_private' AND p.proname LIKE 'telegram_%'")
  assert.equal(functions.length,9)
  for (const fn of functions) {
    assert.equal(fn.prosecdef,true)
    assert.deepEqual(fn.proconfig,['search_path=pg_catalog, chat_private'])
    for (const role of ['anon','authenticated','chat_writer','chat_fn']) {
      const {rows} = await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',[role,fn.signature])
      assert.equal(rows[0].allowed,role==='chat_fn',`${role}/${fn.signature}`)
    }
  }
  // Exercita a RPC realmente sob o papel da Edge Function.
  await db.exec('SET ROLE chat_fn')
  const {rows} = await db.query('SELECT chat_private.telegram_claim_update(999999) AS ok')
  assert.equal(rows[0].ok,true)
  await db.exec('RESET ROLE')
  for (const role of ['anon','authenticated']) {
    await db.exec(`SET ROLE ${role}`)
    await assert.rejects(db.query('SELECT * FROM chat_private.telegram_links'), /permission denied/)
    await assert.rejects(db.query('SELECT chat_private.telegram_claim_update(888888)'), /permission denied/)
    await db.exec('RESET ROLE')
  }
  console.log('PASS Telegram SQL: vínculo, rebind, expiração, uso único, revogação, rate sem overflow, replay, RLS e ACL')
} finally { await db.close() }
