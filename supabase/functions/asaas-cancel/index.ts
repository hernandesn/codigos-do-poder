import { createAsaasCancelHandler } from './handler.ts'
import { authenticateUser } from '../_shared/telegram_runtime.ts'
import { depsCancel } from '../_shared/asaas_runtime.ts'

Deno.serve(createAsaasCancelHandler({ ...depsCancel(), authenticate: authenticateUser }))
