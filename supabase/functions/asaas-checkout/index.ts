import { createAsaasCheckoutHandler } from './handler.ts'
import { authenticateUser } from '../_shared/telegram_runtime.ts'
import { depsCheckout } from '../_shared/asaas_runtime.ts'

Deno.serve(createAsaasCheckoutHandler({ ...depsCheckout(), authenticate: authenticateUser }))
