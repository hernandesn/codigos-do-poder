// Adaptador aditivo: o núcleo v18 e o handler chat permanecem byte-idênticos.
import { CHAT_MODEL_TIMEOUT_MS,runChat,type ChatFinal,type ChatDb,type KeyAssessment,type OpenRouterClient } from './chat_core.ts'
export type FinalResult = {status:number;final?:ChatFinal;code?:string;message?:string}
export async function collectChatFinal(input: {userId:string;body:unknown;db:ChatDb;openrouter:OpenRouterClient;budgetUsd:number;loadInferenceKey:()=>Promise<KeyAssessment>;signal?:AbortSignal}): Promise<FinalResult> {
  const timeout=AbortSignal.timeout(CHAT_MODEL_TIMEOUT_MS)
  const signal=input.signal ? AbortSignal.any([timeout,input.signal]) : timeout
  const result=await runChat({...input,signal,isUserAbort:()=>input.signal?.aborted===true})
  const terminal=result.events.findLast(e=>e.event==='final'||e.event==='error')
  if (terminal?.event==='final') return {status:result.httpStatus,final:terminal.data}
  if (terminal?.event==='error') return {status:result.httpStatus,code:terminal.data.code,message:terminal.data.message}
  return {status:502,code:'rede',message:'Não foi possível concluir a resposta.'}
}
export function finalPlainText(result: FinalResult): string {
  if (!result.final) return result.message ?? 'Serviço indisponível. Tente novamente.'
  const f=result.final
  const blocks=f.blocos.map(b=>`${b.tipo==='documentado'?'DOCUMENTADO':'INFERÊNCIA'}\n${b.texto}`)
  const sources=f.fontes.map(id=>{const s=f.fontes_detalhe[id];return `[${id}] ${s?.titulo??id}${s?.localizador?` · ${s.localizador}`:''}${s?.url?`\n${s.url}`:''}`})
  return [...blocks,...f.avisos.map(a=>a.texto),...(sources.length?['FONTES',...sources]:[]),`Cota grátis restante: ${f.gratis_restantes}. Saldo pago: ${f.saldo_pago}.`].join('\n\n')
}
