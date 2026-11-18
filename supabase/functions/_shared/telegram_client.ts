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
export function createTelegramSender(token: string, fetchImpl: typeof fetch) {
  // Formato fechado impede alterar host/path/query até por configuração acidental.
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('configuracao_ausente')
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  return async (chatId: string,text: string): Promise<void> => {
    for (const part of splitTelegramText(text)) {
      let response: Response
      try {
        response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text:part,disable_web_page_preview:true,link_preview_options:{is_disabled:true}}),signal:AbortSignal.timeout(10_000)})
      } catch { throw new Error('telegram_envio_falhou') }
      // Nunca imprime URL, exceção do fetch ou corpo remoto.
      if (!response.ok) { void response.body?.cancel().catch(()=>{});throw new Error('telegram_envio_falhou') }
      let ok=false
      try { ok=(await response.json()).ok===true } catch { /* fecha sem dados remotos */ }
      if (!ok) throw new Error('telegram_envio_falhou')
    }
  }
}
