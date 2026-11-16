// Carrega o núcleo TypeScript do chat no Node, do mesmo jeito que
// supabase/functions/_shared/chat_core_node_test.mjs. Não liga o Deno.

import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

const functionsRoot = new URL('../functions/', import.meta.url).href
const memoryDbUrl = new URL('../functions/_shared/memory_db.ts', import.meta.url).href

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(functionsRoot) && url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {
          mode: url === memoryDbUrl ? 'transform' : 'strip',
        }),
      }
    }
    return nextLoad(url, context)
  },
})

export async function loadChatModules() {
  const core = await import('../functions/_shared/chat_core.ts')
  const memory = await import('../functions/_shared/memory_db.ts')
  const handler = await import('../functions/chat/handler.ts')
  return { core, memory, handler }
}
