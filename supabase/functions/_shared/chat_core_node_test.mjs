// Offline runner: node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Load the local Deno modules as ESM even under the root CommonJS package.
// The memory DB also needs transformation for its TS constructor parameter property.
const sharedUrl = new URL('../', import.meta.url).href
const memoryDbUrl = new URL('./memory_db.ts', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(sharedUrl) && url.endsWith('.ts')) {
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
  async readTextFile(path) { return readFileSync(path, 'utf8') },
  env: { get: (key) => process.env[key], set: (key, value) => { process.env[key] = value }, delete: (key) => { delete process.env[key] } },
}
globalThis.fetch = () => { throw new Error('Network disabled in offline tests') }
await import('./chat_core_test.ts')
await import('./chat_fix_selecao_test.ts')
await import('./pauta_test.ts')
await import('./citation_ids_test.ts')
await import('./contrato_ux3a_test.ts')
await import('../chat/local_serve_test.ts')
await import('./sec_rate_test.ts')
await import('./sec_body_test.ts')
await import('./sec_logs_test.ts')

let passed = 0
let failed = 0
let skipped = 0
for (const { name, fn } of tests) {
  if (['402 e 403 de limite não vazam a chave', 'rate_limit traz os segundos e modelo precoce é 503', 'functions serve local sem OpenRouter real'].includes(name)) {
    console.log(`SKIP ${name}: requires Deno.serve and HTTP; offline shim provides neither`)
    skipped++
    continue
  }
  try {
    await fn()
    console.log(`PASS ${name}`)
    passed++
  } catch (error) {
    console.error(`FAIL ${name}`, error)
    failed++
  }
}
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`)
if (failed) process.exitCode = 1
