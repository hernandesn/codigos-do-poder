// Somente testes offline. Nenhuma leitura de env, arquivo de credencial ou rede.
import type { TelegramDb } from './telegram_db.ts'
export const FAKE_TOKEN='000000000:AAFAKE_TOKEN_FOR_UNIT_TESTS_ONLY__'
export const FAKE_PEPPER='pepper-exclusivo-de-testes-locais-00000000'
export const FAKE_SECRET='webhook-somente-teste-local'
export const USER='11111111-1111-4111-8111-111111111111'
export const OTHER='22222222-2222-4222-8222-222222222222'
export const NOW=1794400000
export function assert(value:unknown,message='asserção falhou'):asserts value { if (!value) throw new Error(message) }
export function equal(a:unknown,b:unknown) { assert(JSON.stringify(a)===JSON.stringify(b),'valores divergentes') }
export async function signedInitData(overrides:Record<string,string>={},token=FAKE_TOKEN):Promise<string> {
  // Oráculo independente da implementação: Web Crypto, derivação literal.
  const values={auth_date:String(NOW),query_id:'fixture-only',user:JSON.stringify({id:101,first_name:'Teste'}),...overrides}
  const data=Object.keys(values).sort().map(k=>`${k}=${values[k as keyof typeof values]}`).join('\n')
  const sign=async (key:Uint8Array,message:string)=>{
    const imported=await crypto.subtle.importKey('raw',key as BufferSource,{name:'HMAC',hash:'SHA-256'},false,['sign'])
    return new Uint8Array(await crypto.subtle.sign('HMAC',imported,new TextEncoder().encode(message)))
  }
  const secret=await sign(new TextEncoder().encode('WebAppData'),token)
  const hash=Array.from(await sign(secret,data),b=>b.toString(16).padStart(2,'0')).join('')
  return new URLSearchParams({...values,hash}).toString()
}
export function testDb() {
  let now=NOW
  const links=new Map<string,string>()
  const codes=new Map<string,{user:string;expires:number;used:boolean}>()
  const updates=new Set<number>()
  const rates=new Map<string,number[]>()
  const sessions=new Map<string,{telegram:string;proof:string;expires:number;boundUser:string|null}>()
  const calls:string[]=[]
  const revokedAt=new Map<string,number>()
  const db:TelegramDb={
    async issueCode(u,h,iat) {
      calls.push('issue')
      const marker=revokedAt.get(u)
      if (marker!==undefined && !(typeof iat==='number' && Number.isSafeInteger(iat) && iat>marker)) return false
      for (const [k,v] of codes) if (v.user===u) codes.delete(k)
      codes.set(h,{user:u,expires:now+600,used:false})
      return true
    },
    async revokeCodes(u) {
      calls.push('revoke')
      revokedAt.set(u,now)
      for (const [k,v] of codes) if (v.user===u&&!v.used) codes.delete(k)
    },
    async consumeCode(t,h) { calls.push('consume');const c=codes.get(h);if(!c||c.used||c.expires<=now)return false;c.used=true;const old=[...links].find(([,u])=>u===c.user)?.[0];for(const [k,u] of links)if(k===t||u===c.user)links.delete(k);links.set(t,c.user);for(const s of sessions.values())if(s.telegram===t||s.telegram===old)s.proof='invalidado';return true },
    async unlink(t) { calls.push('unlink');links.delete(t);for(const s of sessions.values())if(s.telegram===t)s.proof='invalidado' },
    async linkedUser(t) { calls.push('linked');return links.get(t)??null },
    async claimUpdate(i) { calls.push('claim');if(updates.has(i))return false;updates.add(i);return true },
    async rateTouch(t) { calls.push('rate');const all=rates.get(t)??[];if(all.filter(x=>x>now-60).length>=8||all.filter(x=>x>now-86400).length>=100)return false;rates.set(t,[...all,now]);return true },
    async beginSession(h,t,p,e) { calls.push('begin');if(sessions.has(h)||e<=now)return false;sessions.set(h,{telegram:t,proof:p,expires:e,boundUser:links.get(t)??null});return true },
    async sessionUser(h,t,p) { calls.push('session');const s=sessions.get(h);const ok=!!s&&s.telegram===t&&s.proof===p&&s.expires>now&&s.boundUser===(links.get(t)??null);return {ok,userId:ok?s!.boundUser:null} },
  }
  return {db,links,codes,updates,rates,sessions,calls,setNow:(value:number)=>{now=value}}
}
