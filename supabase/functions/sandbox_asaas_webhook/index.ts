import { createSandboxWebhookHandler } from './handler.ts'
import { depsWebhookSandbox } from '../_shared/asaas_runtime.ts'

Deno.serve(createSandboxWebhookHandler(depsWebhookSandbox()))
