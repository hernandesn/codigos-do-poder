import { createTelegramHandler } from './handler.ts'
import { productionTelegramDeps } from '../_shared/telegram_runtime.ts'
Deno.serve(createTelegramHandler(productionTelegramDeps()))
