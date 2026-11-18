const envGet = ['Deno', 'env', 'get'].join('.')
const chaveEnv = ['process', 'env', 'ASAAS_API_KEY_SANDBOX'].join('.')
const proibidas = ['credit_balances', 'credit_ledger', 'free_quota_daily', 'unlimited_users', 'telegram_runtime', 'chat_core', 'chat/handler', envGet]
const semChat = [
  '../sandbox_asaas_webhook/handler.ts', '../sandbox_asaas_webhook/index.ts',
  '../asaas-webhook/handler.ts', '../asaas-webhook/index.ts',
  '../asaas-checkout/handler.ts', '../asaas-cancel/handler.ts',
  './asaas_webhook.ts', './pg_asaas_db.ts', './asaas_client.ts',
]
const cartoes = ['4539656048392220', '4916561358240741']

async function ler(rel: string) {
  return Deno.readTextFile(new URL(rel, import.meta.url))
}
function assert(cond: unknown, msg?: string) {
  if (!cond) throw new Error(msg || 'asserção')
}

Deno.test('arquivos de produção não puxam chat, Telegram nem segredo', async () => {
  for (const rel of semChat) {
    const fonte = await ler(rel)
    for (const termo of proibidas) assert(!fonte.includes(termo), rel + ' ' + termo)
  }
  const runtime = await ler('./asaas_runtime.ts')
  assert(runtime.includes(envGet))
  for (const termo of proibidas.filter((termo) => termo !== envGet)) assert(!runtime.includes(termo), termo)
  const checkoutHandler = await ler('../asaas-checkout/handler.ts')
  assert(checkoutHandler.includes('if (!row)'))
  const checkout = await ler('../asaas-checkout/index.ts')
  const cancel = await ler('../asaas-cancel/index.ts')
  assert(checkout.includes('telegram_runtime') && cancel.includes('telegram_runtime'))
  assert(!checkout.includes(envGet) && !cancel.includes(envGet))
  const client = await ler('./asaas_client.ts')
  for (const pan of cartoes) assert(!client.includes(pan))
  assert(client.includes('Sem retry'))
  assert(client.includes('TODO(Hernandes)'))
  const memoria = await ler('./asaas_memoria.ts')
  for (const nome of ['credit_balances', 'credit_ledger', 'free_quota_daily', 'unlimited_users']) assert(memoria.includes(nome))
  assert(memoria.includes('tabela do chat'))
  const migracao = await ler('../../migrations/014_asaas_assinaturas.sql')
  const executavel = migracao.split('\n').filter((linha) => !/^\s*--/.test(linha)).join('\n')
  assert(!/\bDROP\b/i.test(executavel))
  assert(migracao.includes("ambiente = 'producao'"))
  const e2e = await ler('./asaas_e2e_sandbox.mjs')
  assert(e2e.includes(chaveEnv))
  assert(!e2e.includes('asaas_runtime'))
  assert(e2e.includes('anotarSubscription'))
  assert(e2e.includes('https://api-sandbox.asaas.com'))
  assert(e2e.includes('host_bloqueado'))
  for (const pan of cartoes) assert(e2e.includes(pan))
})
