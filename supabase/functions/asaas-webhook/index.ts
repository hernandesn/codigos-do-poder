import { createAsaasWebhookHandler } from './handler.ts'
import { depsWebhookProducao } from '../_shared/asaas_runtime.ts'

Deno.serve(createAsaasWebhookHandler(depsWebhookProducao()))
