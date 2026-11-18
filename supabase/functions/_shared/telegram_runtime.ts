// Adaptador de produção, nunca importado pelos testes. Leitura tardia de ambiente.
import { readEnv,loadProjectJwks } from '../chat/handler.ts'
import { userIdFromAuthorization,supabaseIssuer,resolveDailyBudgetUsd,loadInferenceKeyAssessment,OPENROUTER_KEY_URL,OPENROUTER_URL,type ChatDb } from './chat_core.ts'
import { collectChatFinal } from './chat_final.ts'
import { createFetchOpenRouter } from './openrouter_stream.ts'
import { createTelegramSender } from './telegram_client.ts'
import { webhookSecretValue } from './telegram_auth.ts'
import type { TelegramDb } from './telegram_db.ts'
import type { TelegramDeps } from '../telegram/handler.ts'
let telegramDb:TelegramDb|null=null
let coreDb:ChatDb|null=null
export async function getTelegramDb():Promise<TelegramDb> {
  if (!telegramDb) {
    const url=readEnv('ATLAS_CHAT_DB_URL')
    if (!url) throw new Error('configuracao_ausente')
    const {createPgTelegramDb}=await import('./pg_telegram_db.ts')
    telegramDb=createPgTelegramDb(url)
  }
  return telegramDb
}
export const linkPepper=()=>readEnv('TELEGRAM_LINK_PEPPER')
export const structuredLog=(entry:Record<string,string>)=>console.log(JSON.stringify(entry))
export const authenticateUser=(header:string|null)=>userIdFromAuthorization(header,{
  jwtSecret:readEnv('JWT_SECRET')||readEnv('SUPABASE_JWT_SECRET'),loadJwks:loadProjectJwks,
  issuer:supabaseIssuer(readEnv('SUPABASE_URL')),audience:'authenticated',
})
export function productionTelegramDeps():TelegramDeps {
  return {
    webhookSecret:()=>webhookSecretValue(readEnv('TELEGRAM_WEBHOOK_SECRET')),botToken:()=>readEnv('TELEGRAM_BOT_TOKEN'),linkPepper,db:getTelegramDb,log:structuredLog,
    async send(id,text) {
      const token=readEnv('TELEGRAM_BOT_TOKEN')
      if (!token) throw new Error('configuracao_ausente')
      await createTelegramSender(token,fetch)(id,text)
    },
    async ask(userId,body,signal) {
      const budget=resolveDailyBudgetUsd(readEnv('CHAT_DAILY_BUDGET_USD'))
      if (budget===null) return {status:503,code:'orcamento_esgotado',message:'Chat temporariamente indisponível.'}
      if (!coreDb) {
        const url=readEnv('ATLAS_CHAT_DB_URL')
        if (!url) throw new Error('configuracao_ausente')
        const {createPgChatDb}=await import('./pg_chat_db.ts')
        coreDb=createPgChatDb(url)
      }
      return collectChatFinal({userId,body,db:coreDb,budgetUsd:budget,signal,
        loadInferenceKey:()=>loadInferenceKeyAssessment({apiKey:readEnv('OPENROUTER_API_KEY')??'',url:readEnv('OPENROUTER_KEY_URL')||OPENROUTER_KEY_URL}),
        openrouter:createFetchOpenRouter({apiKey:readEnv('OPENROUTER_API_KEY')??'',url:readEnv('OPENROUTER_URL')||OPENROUTER_URL}),
      })
    },
  }
}
