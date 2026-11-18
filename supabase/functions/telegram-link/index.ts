import { createTelegramLinkHandler } from './handler.ts'
import { authenticateUser,getTelegramDb,linkPepper,structuredLog } from '../_shared/telegram_runtime.ts'
Deno.serve(createTelegramLinkHandler({authenticate:authenticateUser,db:getTelegramDb,pepper:linkPepper,log:structuredLog}))
