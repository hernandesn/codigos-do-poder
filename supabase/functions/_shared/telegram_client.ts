export function splitTelegramText(text: string): string[] {
  const chunks: string[]=[]
  let chunk=''
  // Conta unidades UTF-16 e preserva pares de surrogate; nunca excede 4096.
  for (const char of text) {
    if (chunk.length+char.length>4096) { chunks.push(chunk);chunk='' }
    chunk+=char
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

const PT_WORDS=new Set(['não','nao','você','voce','vocês','voces','também','tambem','porque','pelo','pela','isso','isto','obrigado','obrigada'])
const ES_WORDS=new Set(['qué','cómo','dónde','también','usted','ustedes','investigación','investigando'])
const EN_WORDS=new Set(['the','what','who','where','when','why','how','does','did','please','about','which','searching'])

/** Idioma só do aviso. Não identifica a pessoa. Texto claro ganha do language_code; senão o código; senão pt. */
export function noticeLanguage(text: string, languageCode?: string | null): 'pt' | 'en' | 'es' {
  const sample=String(text||'')
  const folded=sample.toLowerCase()
  const words=folded.match(/[a-záéíóúàâêôãõçñü]+/g)||[]
  let pt=0,es=0,en=0
  if (/[ãõ]/.test(folded)||/ç/.test(folded)) pt+=2
  if (/ñ/.test(folded)) es+=2
  if (/[¿¡]/.test(sample)) es+=2
  for (const word of words) {
    if (PT_WORDS.has(word)) pt++
    if (ES_WORDS.has(word)) es++
    if (EN_WORDS.has(word)) en++
  }
  const ranked:(['pt'|'en'|'es',number])[]=[['pt',pt],['en',en],['es',es]]
  ranked.sort((a,b)=>b[1]-a[1])
  if (ranked[0][1]>ranked[1][1]) return ranked[0][0]
  const code=String(languageCode||'').toLowerCase()
  if (code.startsWith('pt')) return 'pt'
  if (code.startsWith('en')) return 'en'
  if (code.startsWith('es')) return 'es'
  return 'pt'
}

export function searchingLabel(text: string, languageCode?: string | null): string {
  const lang=noticeLanguage(text,languageCode)
  if (lang==='en') return 'Searching…'
  if (lang==='es') return 'Investigando…'
  return 'Pesquisando…'
}

export interface TelegramBotApi {
  sendMessage(chatId: string, text: string): Promise<number | null>
  sendChatAction(chatId: string): Promise<void>
  editMessageText(chatId: string, messageId: number, text: string): Promise<void>
  deleteMessage(chatId: string, messageId: number): Promise<void>
}

function previewBody(chatId: string, text: string, extra: Record<string, unknown>={}) {
  return {chat_id:chatId,text,disable_web_page_preview:true,link_preview_options:{is_disabled:true},...extra}
}

export function createTelegramClient(token: string, fetchImpl: typeof fetch): TelegramBotApi {
  // Formato fechado impede alterar host/path/query até por configuração acidental.
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('configuracao_ausente')
  async function call(method: string, body: Record<string, unknown>): Promise<{result?: {message_id?: unknown}}> {
    const url=`https://api.telegram.org/bot${token}/${method}`
    let response: Response
    try {
      response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)})
    } catch { throw new Error('telegram_envio_falhou') }
    // Nunca imprime URL, exceção do fetch ou corpo remoto.
    if (!response.ok) { void response.body?.cancel().catch(()=>{});throw new Error('telegram_envio_falhou') }
    try {
      const data=await response.json()
      if (!data || data.ok!==true) throw new Error('telegram_envio_falhou')
      return data
    } catch (error) {
      if (error instanceof Error && error.message==='telegram_envio_falhou') throw error
      throw new Error('telegram_envio_falhou')
    }
  }
  return {
    async sendMessage(chatId, text) {
      let first: number | null=null
      for (const part of splitTelegramText(text)) {
        const data=await call('sendMessage',previewBody(chatId,part))
        const id=data.result?.message_id
        if (first==null && typeof id==='number' && Number.isSafeInteger(id)) first=id
      }
      return first
    },
    async sendChatAction(chatId) {
      await call('sendChatAction',{chat_id:chatId,action:'typing'})
    },
    async editMessageText(chatId, messageId, text) {
      await call('editMessageText',previewBody(chatId,text,{message_id:messageId}))
    },
    async deleteMessage(chatId, messageId) {
      await call('deleteMessage',{chat_id:chatId,message_id:messageId})
    },
  }
}

export function createTelegramSender(token: string, fetchImpl: typeof fetch) {
  const client=createTelegramClient(token,fetchImpl)
  return async (chatId: string, text: string): Promise<void> => { await client.sendMessage(chatId,text) }
}
