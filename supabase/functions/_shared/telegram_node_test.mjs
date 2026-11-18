// node supabase/functions/_shared/telegram_node_test.mjs — sempre offline.
// Não lê TELEGRAM_BOT_TOKEN nem qualquer outro segredo. O fetch real está fechado.
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_LINK_PEPPER', 'OPENROUTER_API_KEY', 'ATLAS_CHAT_DB_URL']) {
  delete process.env[key]
}

const scope = new URL('../', import.meta.url).href
const memoryDbUrl = new URL('./memory_db.ts', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(scope) && url.endsWith('.ts')) {
      return {
        format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: url === memoryDbUrl ? 'transform' : 'strip' }),
      }
    }
    return nextLoad(url, context)
  },
})

const tests = []
globalThis.Deno = {
  test(name, fn) { tests.push({ name, fn }) },
  env: { get() { throw new Error('Leitura de ambiente proibida na suíte Telegram') } },
}
globalThis.fetch = () => { throw new Error('Rede real proibida na suíte Telegram') }

const files = ['./telegram_auth_test.ts', '../telegram/handler_test.ts', '../telegram-link/handler_test.ts', './chat_final_test.ts']
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
