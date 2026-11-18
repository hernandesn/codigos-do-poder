import { createTelegramLinkHandler } from './handler.ts'
import { userIdFromAuthorization } from '../_shared/chat_core.ts'
import { hashLinkCode } from '../_shared/telegram_auth.ts'
import { FAKE_PEPPER,NOW,USER,OTHER,assert,equal,testDb } from '../_shared/telegram_test_fixture.ts'
const JWT_KEY='chave-jwt-sintetica-exclusiva-dos-testes'
async function fakeJwt(iat:number|null=Math.floor(Date.now()/1000)) {
  const encode=(value:unknown)=>btoa(JSON.stringify(value)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
  const claims:Record<string,unknown>={sub:USER,role:'authenticated',aud:'authenticated',iss:'https://fixture.invalid/auth/v1',exp:Math.floor(Date.now()/1000)+60}
  if (iat!==null) claims.iat=iat
  const data=encode({alg:'HS256',typ:'JWT'})+'.'+encode(claims)
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(JWT_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign'])
  const signature=new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(data)))
  return data+'.'+btoa(String.fromCharCode(...signature)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
}
const authenticate=(header:string|null)=>userIdFromAuthorization(header,{jwtSecret:JWT_KEY,issuer:'https://fixture.invalid/auth/v1',audience:'authenticated'})
Deno.test('telegram-link autentica JWT real sintético e ignora user_id do cliente',async()=>{
  const f=testDb(),h=createTelegramLinkHandler({authenticate,pepper:()=>FAKE_PEPPER,db:async()=>f.db})
  const r=await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+await fakeJwt()},body:JSON.stringify({user_id:OTHER})}))
  equal(r.status,200);equal(r.headers.get('cache-control'),'no-store')
  const body=await r.json();equal(body.expires_in,600);equal(body.bot,'@aion_codigosdopoder_bot')
  const hash=await hashLinkCode(body.code,FAKE_PEPPER);assert(hash);equal(f.codes.get(hash)?.user,USER)
  assert(!JSON.stringify([...f.codes]).includes(body.code))
})
Deno.test('telegram-link sem JWT ou JWT adulterado: 401 sem DB',async()=>{
  let calls=0;const h=createTelegramLinkHandler({authenticate,pepper:()=>FAKE_PEPPER,db:async()=>{calls++;return testDb().db}})
  for(const header of ['', 'tma fake','Bearer '+await fakeJwt()+'adulterado']) equal((await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:header},body:'{}'}))).status,401)
  equal(calls,0)
})
Deno.test('telegram-link falha fechado sem pepper e limita corpo sem gerar código',async()=>{
  let calls=0;const h=createTelegramLinkHandler({authenticate:async()=>USER,pepper:()=>undefined,db:async()=>{calls++;return testDb().db}})
  equal((await h(new Request('http://local/telegram-link',{method:'POST',body:'{}'}))).status,503)
  equal((await h(new Request('http://local/telegram-link',{method:'POST',body:'x'.repeat(65537)}))).status,413)
  equal(calls,0)
})
Deno.test('telegram-link emissão bloqueada dá 429; erro não vaza texto livre',async()=>{
  const f=testDb(),logs:unknown[]=[];f.db.issueCode=async()=>false
  const h=createTelegramLinkHandler({authenticate:async()=>USER,pepper:()=>FAKE_PEPPER,db:async()=>f.db,log:e=>{logs.push(e)}})
  const token=await fakeJwt()
  equal((await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+token},body:'{}'}))).status,429)
  f.db.issueCode=async()=>{throw new Error('nunca imprimir conteúdo de erro')}
  equal((await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+token},body:'{}'}))).status,502)
  assert(!JSON.stringify(logs).includes('conteúdo de erro'))
})

Deno.test('telegram-link revoga códigos pendentes do dono autenticado e ignora user_id do corpo',async()=>{
  const f=testDb(),h=createTelegramLinkHandler({authenticate,pepper:()=>FAKE_PEPPER,db:async()=>f.db})
  const issued=await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+await fakeJwt()},body:'{}'}))
  const code=(await issued.json()).code
  const hash=await hashLinkCode(code,FAKE_PEPPER);assert(hash);assert(f.codes.has(hash))
  const r=await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+await fakeJwt()},body:JSON.stringify({revogar:true,user_id:OTHER})}))
  equal(r.status,200);equal((await r.json()).revogado,true);assert(!f.codes.has(hash!))
})
Deno.test('telegram-link não grava iat anterior ao marco e grava iat posterior sem ler o corpo',async()=>{
  const f=testDb(),h=createTelegramLinkHandler({authenticate,pepper:()=>FAKE_PEPPER,db:async()=>f.db})
  const oldToken=await fakeJwt(NOW-60)
  const issued=await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+oldToken},body:'{}'}))
  equal(issued.status,200)
  const hash=await hashLinkCode((await issued.json()).code,FAKE_PEPPER)
  assert(hash);assert(f.codes.has(hash))
  const revoked=await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+oldToken},body:JSON.stringify({revogar:true,user_id:OTHER,iat:NOW+999999})}))
  equal(revoked.status,200);equal((await revoked.json()).revogado,true);assert(!f.codes.has(hash!))
  for (const iat of [NOW-60,NOW]) {
    const late=await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+await fakeJwt(iat)},body:JSON.stringify({iat:NOW+999999,user_id:OTHER})}))
    equal(late.status,429);equal(f.codes.size,0)
  }
  const again=await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+await fakeJwt(NOW+1)},body:JSON.stringify({iat:1,user_id:OTHER})}))
  equal(again.status,200)
  const fresh=await hashLinkCode((await again.json()).code,FAKE_PEPPER)
  assert(fresh);equal(f.codes.get(fresh!)?.user,USER);equal(f.codes.size,1)
  const calls=f.calls.length
  equal((await h(new Request('http://local/telegram-link',{method:'POST',headers:{authorization:'Bearer '+await fakeJwt(null)},body:'{}'}))).status,401)
  equal(f.calls.length,calls)
})
