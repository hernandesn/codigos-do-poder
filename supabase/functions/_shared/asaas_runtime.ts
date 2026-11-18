// Adaptador de produção. Nunca importado pelos testes.
// Lê o ambiente na chamada, não na carga do módulo.
// Não importa chat nem o adaptador do vínculo: o webhook sandbox usa este arquivo.

import { ASAAS_SANDBOX_BASE } from './asaas_planos.ts'
import { createAsaasClient, type AsaasClient } from './asaas_client.ts'
import type { AsaasDb } from './asaas_db.ts'

function env(nome: string): string | undefined {
  const valor = Deno.env.get(nome)
  return valor ? valor : undefined
}

let banco: AsaasDb | null = null

export async function getAsaasDb(): Promise<AsaasDb> {
  const url = env('ATLAS_CHAT_DB_URL')
  if (!url) {
    const erro = new Error('configuracao_ausente') as Error & { code: string }
    erro.code = 'SEM_URL'
    throw erro
  }
  if (!banco) {
    const { createPgAsaasDb } = await import('./pg_asaas_db.ts')
    banco = createPgAsaasDb(url)
  }
  return banco
}

function clienteSandbox(): AsaasClient | null {
  const base = env('ASAAS_BASE_URL')
  const chave = env('ASAAS_API_KEY_SANDBOX')
  if (base !== ASAAS_SANDBOX_BASE || !chave) return null
  return createAsaasClient({ fetch, apiKey: chave, baseUrl: base })
}

const log = (entrada: Record<string, string>) => console.log(JSON.stringify(entrada))

export function depsCheckout() {
  return { baseUrl: () => env('ASAAS_BASE_URL'), criarAsaas: clienteSandbox, db: getAsaasDb, log }
}

export function depsCancel() {
  return { baseUrl: () => env('ASAAS_BASE_URL'), criarAsaas: clienteSandbox, db: getAsaasDb, log }
}

export function depsWebhookSandbox() {
  return { token: () => env('ASAAS_WEBHOOK_TOKEN'), baseUrl: () => env('ASAAS_BASE_URL'), db: getAsaasDb, log }
}

export function depsWebhookProducao() {
  return { token: () => env('ASAAS_WEBHOOK_TOKEN'), baseUrl: () => env('ASAAS_BASE_URL'), db: getAsaasDb, log }
}
