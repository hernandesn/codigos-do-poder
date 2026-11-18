// node supabase/functions/_shared/asaas_node_test.mjs — sempre offline.
// Não lê ASAAS_API_KEY_SANDBOX nem qualquer outro segredo. O fetch real está fechado.
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

for (const key of ['ASAAS_API_KEY_SANDBOX', 'ASAAS_WEBHOOK_TOKEN', 'ASAAS_BASE_URL', 'ATLAS_CHAT_DB_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'OPENROUTER_API_KEY']) {
  delete process.env[key]
}

const scope = new URL('../', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(scope) && url.endsWith('.ts')) {
      return {
        format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }),
      }
    }
    return nextLoad(url, context)
  },
})

const tests = []
globalThis.Deno = {
  test(name, fn) { tests.push({ name, fn }) },
  env: { get() { throw new Error('Leitura de ambiente proibida na suíte Asaas') } },
  readTextFile(path) { return Promise.resolve(readFileSync(path, 'utf8')) },
}
globalThis.fetch = () => { throw new Error('Rede real proibida na suíte Asaas') }

const files = ['./asaas_unit_test.ts', './asaas_handlers_test.ts', './asaas_static_test.ts']
for (const file of files) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  if (/process\.env|Deno\.env/.test(source)) throw new Error('Teste deve receber configuração sintética injetada: ' + file)
  await import(file)
}

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log('PASS ' + name)
  } catch (error) {
    failed++
    console.error('FAIL ' + name)
    console.error(error)
  }
}
console.log(`${tests.length - failed} passaram; ${failed} falharam; zero rede real`)
if (failed) process.exitCode = 1
