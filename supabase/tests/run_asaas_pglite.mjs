// Harness local da 014. Aplica 001–014 deste clone em PGlite. Sem DSN e sem rede.
// PGLITE_PATH aponta para o pacote WASM já instalado. A 012 não entra.
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function moduloPglite() {
  const bruto = process.env.PGLITE_PATH
  if (!bruto) return '@electric-sql/pglite'
  const info = await stat(bruto).catch(() => null)
  const arquivo = info?.isDirectory() ? join(bruto, 'dist', 'index.js') : bruto
  return pathToFileURL(arquivo).href
}

const { PGlite } = await import(await moduloPglite())
const migrationsUrl = new URL('../migrations/', import.meta.url)
const sql014 = await readFile(new URL('../migrations/014_asaas_assinaturas.sql', import.meta.url), 'utf8')
const planos = await readFile(new URL('../functions/_shared/asaas_planos.ts', import.meta.url), 'utf8')

function limites(plano) {
  const match = planos.match(new RegExp(plano + ': \\{ basico_dia: (\\d+), avancado_ciclo: (\\d+) \\}'))
  if (!match) throw new Error('Limite ausente em asaas_planos.ts: ' + plano)
  return { basico_dia: Number(match[1]), avancado_ciclo: Number(match[2]) }
}

function conferirFonte() {
  const executavel = sql014.split('\n').filter((linha) => !/^\s*--/.test(linha)).join('\n')
  if (/\bDROP\b/i.test(executavel)) throw new Error('A 014 tem DROP executável.')
  if (/credit_balances|credit_ledger|free_quota_daily|unlimited_users/.test(sql014)) {
    throw new Error('A 014 cita tabela do chat.')
  }
  const free = limites('free')
  const basico = limites('basico')
  const plus = limites('plus')
  const precos = planos.match(/PRECO_CENTAVOS = \{ basico: (\d+), plus: (\d+) \}/)
  if (!precos) throw new Error('Preço ausente em asaas_planos.ts')
  assert.deepEqual(free, { basico_dia: 20, avancado_ciclo: 0 })
  assert.deepEqual(basico, { basico_dia: 150, avancado_ciclo: 20 })
  assert.deepEqual(plus, { basico_dia: 150, avancado_ciclo: 100 })
  assert.equal(precos[1], '990')
  assert.equal(precos[2], '2990')
  assert.match(planos, /TETO_GLOBAL_USD_DIA = 3/)
  assert.match(planos, /TRIAL_DIAS = 7/)
  assert.match(sql014, /WHEN 990 THEN 'basico' WHEN 2990 THEN 'plus'/)
  assert.match(sql014, /v_basico := 150; v_avancado := 20/)
  assert.match(sql014, /v_basico := 150; v_avancado := 100/)
  assert.match(sql014, /'basico_dia', 20, 'avancado_ciclo', 0/)
  assert.match(sql014, /trial_ate - 7/)
  assert.doesNotMatch(sql014, /\b(ALTER|DROP)\s+TABLE\s+chat_private\.(credit_|free_quota|unlimited_)/i)
}

function nomeFuncao(assinatura) {
  return assinatura.replace(/^chat_private\./, '').replace(/\(.*$/, '')
}

async function foto(db) {
  const { rows: funcoes } = await db.query(`
    SELECT p.oid::regprocedure::text AS assinatura, pg_get_functiondef(p.oid) AS definicao
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'chat_private'
    ORDER BY 1
  `)
  const { rows: colunas } = await db.query(`
    SELECT c.relname, a.attnum, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS tipo, a.attnotnull
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'chat_private' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `)
  const { rows: versoes } = await db.query('SELECT version FROM schema_migrations ORDER BY 1')
  return { funcoes, colunas, versoes: versoes.map((row) => row.version) }
}

function comparar(antes, depois) {
  const mapa = new Map(antes.funcoes.map((row) => [row.assinatura, row.definicao]))
  const novas = []
  for (const row of depois.funcoes) {
    if (!mapa.has(row.assinatura)) novas.push(nomeFuncao(row.assinatura))
    else if (mapa.get(row.assinatura) !== row.definicao) throw new Error('Função alterada: ' + row.assinatura)
  }
  for (const assinatura of mapa.keys()) {
    if (!depois.funcoes.some((row) => row.assinatura === assinatura)) throw new Error('Função removida: ' + assinatura)
  }
  assert.deepEqual(novas.sort(), [
    'asaas_aplicar_evento', 'asaas_derivar_status', 'asaas_descartar_checkout', 'asaas_falhar_cancelamento',
    'asaas_gravar_cliente', 'asaas_liberar_checkout', 'asaas_marcar_cancelamento', 'asaas_marcar_checkout_incerto',
    'asaas_obter_cliente', 'asaas_pedir_cancelamento', 'asaas_preparar_checkout', 'asaas_status',
    'asaas_vincular_assinatura_remota', 'asaas_vincular_checkout', 'plano_atual',
  ])
  const tabelasAntes = new Set(antes.colunas.map((row) => row.relname))
  const tabelasDepois = new Set(depois.colunas.map((row) => row.relname))
  const criadas = [...tabelasDepois].filter((nome) => !tabelasAntes.has(nome)).sort()
  assert.deepEqual(criadas, ['asaas_cancelamentos', 'asaas_clientes', 'asaas_eventos', 'asaas_trials', 'assinaturas'])
  for (const nome of tabelasAntes) {
    assert.deepEqual(
      depois.colunas.filter((row) => row.relname === nome),
      antes.colunas.filter((row) => row.relname === nome),
      nome,
    )
  }
  for (const versao of antes.versoes) assert.ok(depois.versoes.includes(versao), versao)
  assert.ok(depois.versoes.includes('014'))
  assert.deepEqual(depois.versoes.filter((versao) => !antes.versoes.includes(versao)), ['014'])
}

function json(valor) {
  return typeof valor === 'string' ? JSON.parse(valor) : valor
}

async function negar(db, papel, sql) {
  await db.exec('RESET ROLE')
  await db.exec('SET ROLE ' + papel)
  let bloqueou = false
  try {
    await db.query(sql)
  } catch (erro) {
    bloqueou = /permission denied/i.test(String(erro.message || erro))
  }
  await db.exec('RESET ROLE')
  assert.equal(bloqueou, true, papel + ' ' + sql)
}

const db = new PGlite()
try {
  conferirFonte()
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)')
  for (const role of ['atlas_reader', 'chat_writer', 'chat_fn', 'anon', 'authenticated', 'service_role']) {
    await db.exec(`CREATE ROLE ${role} NOLOGIN`)
  }
  const names = (await readdir(migrationsUrl)).filter((name) => name.endsWith('.sql')).sort()
  if (names.some((name) => name.startsWith('012_'))) throw new Error('A 012 não pode entrar no clone site.')
  if (!names.includes('014_asaas_assinaturas.sql')) throw new Error('Migração 014 ausente.')
  for (const file of names.filter((name) => name !== '014_asaas_assinaturas.sql')) {
    await db.exec((await readFile(new URL(file, migrationsUrl), 'utf8')).replace(/^\\gexec\s*$/m, ';'))
  }
  const antes = await foto(db)
  await db.exec(sql014)
  comparar(antes, await foto(db))
  await db.exec(await readFile(new URL('014_asaas_assinaturas_test.sql', import.meta.url), 'utf8'))
  const { rows: ok } = await db.query('SELECT ok FROM asaas_teste_ok')
  assert.equal(ok[0].ok, true)
  comparar(antes, await foto(db))

  const tabelas = ['chat_private.asaas_clientes', 'chat_private.assinaturas', 'chat_private.asaas_eventos', 'chat_private.asaas_trials', 'chat_private.asaas_cancelamentos']
  for (const tabela of tabelas) {
    const { rows } = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = '${tabela}'::regclass`)
    assert.equal(rows[0].relrowsecurity, true, tabela)
    for (const role of ['anon', 'authenticated', 'chat_fn', 'chat_writer']) {
      const priv = await db.query(`SELECT has_table_privilege('${role}', '${tabela}', 'SELECT,INSERT,UPDATE,DELETE') AS allowed`)
      assert.equal(priv.rows[0].allowed, false, role + ' ' + tabela)
    }
  }
  const { rows: funcoes } = await db.query(`
    SELECT p.proname,
           has_function_privilege('chat_fn', p.oid, 'EXECUTE') AS chat_fn,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
           has_function_privilege('chat_writer', p.oid, 'EXECUTE') AS chat_writer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'chat_private' AND (p.proname LIKE 'asaas\\_%' OR p.proname = 'plano_atual')
  `)
  assert.equal(funcoes.length, 15)
  for (const row of funcoes) {
    assert.equal(row.chat_fn, true, row.proname)
    assert.equal(row.anon, false, row.proname)
    assert.equal(row.authenticated, false, row.proname)
    assert.equal(row.chat_writer, false, row.proname)
  }

  const freeId = '11111111-1111-4111-8111-111111111111'
  const plusId = '33333333-3333-4333-8333-333333333333'
  const sandId = '22222222-2222-4222-8222-222222222222'
  const trialId = '44444444-4444-4444-8444-444444444444'
  await db.exec('SET ROLE chat_fn')
  const livre = json((await db.query(`SELECT chat_private.plano_atual('${freeId}'::uuid) AS v`)).rows[0].v)
  const plus = json((await db.query(`SELECT chat_private.plano_atual('${plusId}'::uuid) AS v`)).rows[0].v)
  const areia = json((await db.query(`SELECT chat_private.plano_atual('${sandId}'::uuid) AS v`)).rows[0].v)
  const trial = json((await db.query(`SELECT chat_private.plano_atual('${trialId}'::uuid) AS v`)).rows[0].v)
  await db.exec('RESET ROLE')
  assert.deepEqual(
    { plano: livre.plano, basico_dia: livre.basico_dia, avancado_ciclo: livre.avancado_ciclo },
    { plano: 'free', ...limites('free') },
  )
  assert.equal(livre.ciclo_inicio, null)
  assert.equal(livre.ciclo_fim, null)
  assert.deepEqual(Object.keys(livre).sort(), ['avancado_ciclo', 'basico_dia', 'ciclo_fim', 'ciclo_inicio', 'plano', 'status'])
  assert.equal(plus.plano, 'plus')
  assert.equal(plus.basico_dia, limites('plus').basico_dia)
  assert.equal(plus.avancado_ciclo, limites('plus').avancado_ciclo)
  assert.equal(trial.plano, 'basico')
  assert.equal(trial.basico_dia, limites('basico').basico_dia)
  assert.equal(trial.avancado_ciclo, limites('basico').avancado_ciclo)
  assert.equal(areia.plano, 'free')
  assert.equal(areia.basico_dia, limites('free').basico_dia)

  await negar(db, 'chat_fn', 'SELECT * FROM chat_private.assinaturas')
  await negar(db, 'anon', `SELECT chat_private.plano_atual('${freeId}'::uuid)`)
  await negar(db, 'authenticated', `SELECT chat_private.asaas_status('sandbox', '${freeId}'::uuid)`)
  await negar(db, 'chat_writer', `SELECT chat_private.plano_atual('${freeId}'::uuid)`)
  console.log('PASS site SQL: 014 aditiva, plano_atual ignora sandbox, RPCs só para chat_fn')
} finally {
  await db.close()
}
