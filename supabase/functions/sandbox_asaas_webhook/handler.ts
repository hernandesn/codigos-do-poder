import { createWebhookHttp, type DepsWebhook } from '../_shared/asaas_webhook.ts'

type Deps = Omit<DepsWebhook, 'ambiente'>

// Único webhook que vai ao ar nesta etapa. Ambiente fixo em sandbox.
// Se o banco ou a RPC da 014 não existirem, responde 200 em modo só log.
export function createSandboxWebhookHandler(d: Deps) {
  return createWebhookHttp({ ...d, ambiente: 'sandbox' })
}
