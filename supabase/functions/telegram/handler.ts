import { corsHeaders,isAllowedOrigin } from '../_shared/chat_core.ts'
import { constantTimeTextEqual,hashLinkCode,newSessionProof,sha256,validateInitData } from '../_shared/telegram_auth.ts'
import type { TelegramDb } from '../_shared/telegram_db.ts'
import { finalPlainText,type FinalResult } from '../_shared/chat_final.ts'
import { JsonBodyReadError,readJsonWithByteLimit } from '../_shared/read_json.ts'

export const LINK_INSTRUCTIONS='Para vincular sua conta ao @aion_codigosdopoder_bot, abra https://aion.hernandesnogueira.com.br/vincular.html, entre na sua conta e gere um código. Depois envie aqui /start <código>. Não criamos contas pelo Telegram.'
export interface TelegramDeps {
  webhookSecret:()=>string|undefined
  botToken:()=>string|undefined
  linkPepper:()=>string|undefined
  db:()=>Promise<TelegramDb>
  send:(telegramId:string,text:string)=>Promise<void>
  ask:(userId:string,body:unknown,signal?:AbortSignal)=>Promise<FinalResult>
  log?:(entry:{evento:string;classificacao:string;pedido_id:string})=>void
  now?:()=>number
}
const object=(x:unknown):Record<string,unknown>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null
const id=(x:unknown):string|null=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0?String(x):null

export function createTelegramHandler(d:TelegramDeps) {
  return async (req:Request):Promise<Response>=>{
    const requestId=crypto.randomUUID()
    const log=(classification:string)=>d.log?.({evento:'telegram_pedido',classificacao:classification,pedido_id:requestId})
    const path=new URL(req.url).pathname.replace(/\/$/,'')
    const app=path.match(/\/app\/(session|status|chat)$/)?.[1]
    const headers:Record<string,string>={...corsHeaders(req.headers.get('origin')),'cache-control':'no-store','referrer-policy':'no-referrer'}
    if (app) {
      headers['access-control-allow-headers']='authorization, content-type, apikey, x-telegram-app-session'
      headers['access-control-allow-methods']='POST, OPTIONS'
    }
    const json=(value:unknown,status=200)=>Response.json(value,{status,headers})
    const error=(code:string,message:string,status:number)=>json({code,message},status)
    if (app) {
      const origin=req.headers.get('origin')
      if (origin&&!isAllowedOrigin(origin)) return error('origem_recusada','Origem não permitida.',403)
      if (req.method==='OPTIONS') return new Response(null,{status:204,headers})
      if (req.method!=='POST') return error('pedido_invalido','Use POST.',405)
      const auth=await validateInitData(req.headers.get('authorization'),d.botToken(),d.now?.())
      if (!auth) { log('initdata_recusado');return error('sem_login','Abra o mini app pelo @aion_codigosdopoder_bot. A sessão pode ter expirado.',401) }
      try {
        // SEC-03 também vale nas rotas autenticadas do mini app.
        const body=await readJsonWithByteLimit(req)
        const db=await d.db()
        if (app==='session') {
          if (!await db.rateTouch(auth.telegramId)) return error('rate_limit','Muitas tentativas. Aguarde um minuto.',429)
          const proof=newSessionProof()
          if (!await db.beginSession(auth.hash,auth.telegramId,await sha256(proof),auth.expiresAt)) {
            log('replay');return error('replay','Esta abertura já foi usada. Feche e abra novamente pelo bot.',401)
          }
          const session=await db.sessionUser(auth.hash,auth.telegramId,await sha256(proof))
          if (!session.ok) return error('sem_login','O vínculo mudou. Feche e abra novamente pelo bot.',401)
          return json({session:proof,expires_at:auth.expiresAt,linked:!!session.userId,instructions:LINK_INSTRUCTIONS})
        }
        const proof=req.headers.get('x-telegram-app-session')??''
        if (!/^[a-f0-9]{64}$/.test(proof)) return error('sem_login','Feche e abra novamente o mini app pelo bot.',401)
        const session=await db.sessionUser(auth.hash,auth.telegramId,await sha256(proof))
        if (!session.ok) {
          return error('sem_login','Feche e abra novamente o mini app pelo bot.',401)
        }
        if (!await db.rateTouch(auth.telegramId)) return error('rate_limit','Muitas perguntas seguidas. Aguarde um minuto.',429)
        const userId=session.userId
        if (!userId) return json({code:'sem_vinculo',linked:false,message:LINK_INSTRUCTIONS},403)
        if (app==='status') return json({linked:true})
        const row=object(body)
        const message=row?.mensagem
        if (typeof message!=='string'||message.trim().length>2000) return error('pedido_invalido','Envie uma pergunta de até 2000 caracteres.',400)
        // Só mensagem/modelo entram no núcleo. IDs, contexto e conversa do cliente são descartados.
        const result=await d.ask(userId,{mensagem:message,modelo:row?.modelo??'basico',contexto:{entidades:[]}},req.signal)
        log(result.final?'final':'recusa_chat')
        return json(result.final?{final:result.final}:{code:result.code,message:result.message},result.status)
      } catch (e) {
        if (e instanceof JsonBodyReadError || e instanceof SyntaxError || e instanceof TypeError) return error('pedido_invalido','Corpo inválido ou muito grande.',e instanceof JsonBodyReadError?e.status:400)
        log('falha_interna');return error('rede','Serviço indisponível. Tente novamente.',502)
      }
    }
    // Só a raiz do webhook; nenhuma rota arbitrária dispara o transporte.
    if (path!==''&&!path.endsWith('/telegram')) return error('nao_encontrado','Rota não encontrada.',404)
    const secret=d.webhookSecret()
    const supplied=req.headers.get('x-telegram-bot-api-secret-token')??''
    // A decisão 401 acontece ANTES de ler corpo, obter DB ou verificar método.
    if (!secret||!await constantTimeTextEqual(supplied,secret)) {
      log('secret_recusado');return error('sem_autorizacao','Não autorizado.',401)
    }
    if (req.method!=='POST') return error('pedido_invalido','Use POST.',405)
    let update:Record<string,unknown>|null
    try { update=object(await readJsonWithByteLimit(req)) }
    catch (e) { return error('pedido_invalido','Corpo inválido ou muito grande.',e instanceof JsonBodyReadError?e.status:400) }
    const message=object(update?.message)
    const chat=object(message?.chat)
    const from=object(message?.from)
    const telegramId=id(from?.id)
    const updateId=update?.update_id
    // Ignora canais, grupos, edições, callbacks, membros e mídia. Sem DB/send.
    if (!message||chat?.type!=='private'||!telegramId||from?.is_bot===true||id(chat.id)!==telegramId||typeof message.text!=='string'||typeof updateId!=='number'||!Number.isSafeInteger(updateId)||updateId<0) {
      return new Response(null,{status:200,headers})
    }
    try {
      // Token ausente: 503 depois do secret e antes do claim, para não gastar cota nem update_id.
      if (!d.botToken()) { log('configuracao_ausente');return error('rede','Serviço indisponível.',503) }
      const db=await d.db()
      if (!await db.claimUpdate(updateId)) { log('duplicado');return new Response(null,{status:200,headers}) }
      const text=message.text.trim()
      const command=text.length<=2000?text.match(/^\/(start|desvincular)(?:@aion_codigosdopoder_bot)?(?:\s+([\s\S]*))?$/i):null
      // /desvincular segue com o rate esgotado. Não chama o modelo nem grava rate (nem overflow).
      if (command?.[1].toLowerCase()==='desvincular') {
        await db.unlink(telegramId)
        await d.send(telegramId,'Vínculo removido do @aion_codigosdopoder_bot. Para vincular novamente, gere outro código na página de vínculo.')
        log('processado')
        return new Response(null,{status:200,headers})
      }
      // Bloqueios não gravam evento de rate nem geram nova resposta (evita amplificação).
      if (!await db.rateTouch(telegramId)) { log('rate_limit');return new Response(null,{status:200,headers}) }
      let reply:string
      if (text.length>2000) reply='A mensagem ultrapassa 2000 caracteres. Envie uma pergunta de até 2000 caracteres para consultar a base.'
      else if (command?.[1].toLowerCase()==='start') {
        if (!command[2]) reply=`Bem-vindo ao @aion_codigosdopoder_bot. ${LINK_INSTRUCTIONS}`
        else {
          const hash=await hashLinkCode(command[2].trim(),d.linkPepper())
          reply=hash&&await db.consumeCode(telegramId,hash)
            ?'Conta vinculada ao @aion_codigosdopoder_bot. Faça uma pergunta sobre a base do Códigos do Poder (até 2000 caracteres). Sua cota é a mesma do site. Use /desvincular para remover o vínculo.'
            :'Código inválido, expirado ou já usado. Gere outro em https://aion.hernandesnogueira.com.br/vincular.html e envie /start <código> ao @aion_codigosdopoder_bot.'
        }
      } else {
        const userId=await db.linkedUser(telegramId)
        reply=userId?finalPlainText(await d.ask(userId,{mensagem:text,modelo:'basico',contexto:{entidades:[]}})):LINK_INSTRUCTIONS
      }
      await d.send(telegramId,reply)
      log('processado')
      return new Response(null,{status:200,headers})
    } catch {
      // At-most-once: após claim, uma repetição não chama modelo nem envia novamente.
      log('falha_interna');return error('rede','Serviço indisponível.',502)
    }
  }
}
