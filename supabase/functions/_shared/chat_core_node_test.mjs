// Offline runner: node --experimental-strip-types supabase/functions/_shared/chat_core_node_test.mjs
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// The existing memory DB uses a TS constructor parameter property, which strip-only
// mode cannot erase. Transform just that module in memory, leaving the source intact.
const memoryDbUrl = new URL('./memory_db.ts', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url === memoryDbUrl) {
      return {
        format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
      }
    }
    return nextLoad(url, context)
  },
})

const tests = []
globalThis.Deno = {
  test(name, fn) { tests.push({ name, fn }) },
  env: { get: (key) => process.env[key] },
}
globalThis.fetch = () => { throw new Error('Network disabled in offline tests') }
await import('./chat_core_test.ts')

let passed = 0
let failed = 0
let skipped = 0
for (const { name, fn } of tests) {
  if (name === '402 e 403 de limite não vazam a chave') {
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
