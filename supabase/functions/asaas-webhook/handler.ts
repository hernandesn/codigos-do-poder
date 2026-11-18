import { createWebhookHttp, type DepsWebhook } from '../_shared/asaas_webhook.ts'

type Deps = Omit<DepsWebhook, 'ambiente'>

// Produção responde 503 depois do token. Não lê o corpo e não toca no banco.
export function createAsaasWebhookHandler(d: Deps) {
  return createWebhookHttp({ ...d, ambiente: 'producao' })
}
