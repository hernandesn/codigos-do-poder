import { corsHeaders,isAllowedOrigin } from '../_shared/chat_core.ts'
import { generateLinkCode,hashLinkCode } from '../_shared/telegram_auth.ts'
import type { TelegramDb } from '../_shared/telegram_db.ts'
import { JsonBodyReadError,readJsonWithByteLimit } from '../_shared/read_json.ts'

function base64UrlBytes(value:string):Uint8Array|null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const padded=value+'='.repeat((4-(value.length%4))%4)
    const binary=atob(padded.replaceAll('-','+').replaceAll('_','/'))
    const bytes=new Uint8Array(binary.length)
    for (let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i)
    return bytes
  } catch { return null }
}

// iat do mesmo header que authenticate já aceitou. O corpo não entra nessa conta.
function issuedAtFromAuthorization(header:string|null):number|null {
  if (!header?.startsWith('Bearer ')) return null
  const parts=header.slice('Bearer '.length).trim().split('.')
  if (parts.length!==3) return null
  const bytes=base64UrlBytes(parts[1])
  if (!bytes) return null
  try {
    const payload=JSON.parse(new TextDecoder().decode(bytes)) as {iat?:unknown}
    const iat=payload.iat
    if (typeof iat!=='number' || !Number.isSafeInteger(iat) || iat<=0) return null
    return iat
  } catch { return null }
}

export function createTelegramLinkHandler(d:{authenticate:(header:string|null)=>Promise<string|null>;pepper:()=>string|undefined;db:()=>Promise<TelegramDb>;log?:(entry:Record<string,string>)=>void}) {
  return async (req:Request):Promise<Response>=>{
    const headers={...corsHeaders(req.headers.get('origin')),'cache-control':'no-store','referrer-policy':'no-referrer'}
    const json=(value:unknown,status=200)=>Response.json(value,{status,headers})
    const origin=req.headers.get('origin')
    if (origin&&!isAllowedOrigin(origin)) return json({code:'origem_recusada',message:'Origem não permitida.'},403)
    if (req.method==='OPTIONS') return new Response(null,{status:204,headers})
    if (req.method!=='POST') return json({code:'pedido_invalido',message:'Use POST.'},405)
    const authorization=req.headers.get('authorization')
    const userId=await d.authenticate(authorization)
    if (!userId) return json({code:'sem_login',message:'Entre na sua conta para gerar o código.'},401)
    try {
      const body=await readJsonWithByteLimit(req) // Nenhum user_id nem iat do corpo é usado.
      const row=body!==null&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:null
      if (row?.revogar===true) {
        await (await d.db()).revokeCodes(userId)
        return json({revogado:true})
      }
      const code=generateLinkCode()
      const hash=await hashLinkCode(code,d.pepper())
      if (!hash) return json({code:'configuracao_ausente',message:'Vínculo temporariamente indisponível.'},503)
      const issuedAt=issuedAtFromAuthorization(authorization)
      if (issuedAt===null) return json({code:'sem_login',message:'Entre na sua conta para gerar o código.'},401)
      if (!await (await d.db()).issueCode(userId,hash,issuedAt)) return json({code:'rate_limit',message:'Aguarde 30 segundos antes de gerar outro código.'},429)
      return json({code,expires_in:600,bot:'@aion_codigosdopoder_bot'})
    } catch (e) {
      if (e instanceof JsonBodyReadError || e instanceof SyntaxError || e instanceof TypeError) return json({code:'pedido_invalido',message:'Corpo inválido ou muito grande.'},e instanceof JsonBodyReadError?e.status:400)
      d.log?.({evento:'telegram_link',classificacao:'falha_interna',pedido_id:crypto.randomUUID()})
      return json({code:'rede',message:'Não foi possível gerar o código.'},502)
    }
  }
}
