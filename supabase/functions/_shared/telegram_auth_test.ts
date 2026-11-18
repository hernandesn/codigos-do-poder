import { constantTimeTextEqual,equalDigest,generateLinkCode,hashLinkCode,normalizeCode,validateInitData,webhookSecretValue } from './telegram_auth.ts'
import { FAKE_TOKEN,FAKE_PEPPER,NOW,assert,equal,signedInitData } from './telegram_test_fixture.ts'
Deno.test('initData válido usa WebAppData como chave e bate vetor independente Node',async()=>{
  const data=await signedInitData()
  equal(new URLSearchParams(data).get('hash'),'660e4862c4c24f4a61e4c6df9e657cd4b8581bd9f7a1fc2e1ee019ddef26315e')
  equal((await validateInitData('tma '+data,FAKE_TOKEN,NOW))?.telegramId,'101')
})
Deno.test('initData HMAC inválido ou adulteração de user recusados',async()=>{
  const data=await signedInitData()
  const p=new URLSearchParams(data);p.set('hash','0'.repeat(64))
  equal(await validateInitData('tma '+p,FAKE_TOKEN,NOW),null)
  p.set('hash',new URLSearchParams(data).get('hash')!);p.set('user','{"id":999}')
  equal(await validateInitData('tma '+p,FAKE_TOKEN,NOW),null)
})
Deno.test('initData expirado, futuro e fronteiras de relógio',async()=>{
  for (const offset of [-3601,31]) equal(await validateInitData('tma '+await signedInitData({auth_date:String(NOW+offset)}),FAKE_TOKEN,NOW),null)
  for (const offset of [-3599,30]) assert(await validateInitData('tma '+await signedInitData({auth_date:String(NOW+offset)}),FAKE_TOKEN,NOW))
})
Deno.test('initData exige tma e token explícito: nunca usa ambiente',async()=>{
  const data=await signedInitData()
  for (const header of [null,'Bearer '+data,'TMA '+data,'tma ','tma '+ 'a'.repeat(17000)]) equal(await validateInitData(header,FAKE_TOKEN,NOW),null)
  equal(await validateInitData('tma '+data,undefined,NOW),null)
  equal(await validateInitData('tma '+data,'outro-token-falso',NOW),null)
})
Deno.test('initData duplicado, user inválido e data não inteira recusados',async()=>{
  equal(await validateInitData('tma '+await signedInitData()+'&auth_date='+NOW,FAKE_TOKEN,NOW),null)
  for (const user of ['{}','{"id":-1}','{"id":"101"}','{"id":9007199254740992}','{"id":101,"is_bot":true}','null','inválido']) equal(await validateInitData('tma '+await signedInitData({user}),FAKE_TOKEN,NOW),null)
  equal(await validateInitData('tma '+await signedInitData({auth_date:'1.2'}),FAKE_TOKEN,NOW),null)
})
Deno.test('comparação de secret e digests sem igualdade de strings',async()=>{
  assert(await constantTimeTextEqual('segredo-sintetico','segredo-sintetico'))
  assert(!await constantTimeTextEqual('segredo-sintetico','outro'))
  assert(!equalDigest(new Uint8Array(32),new Uint8Array(31)))
  const changed=new Uint8Array(32);changed[31]=1
  assert(!equalDigest(new Uint8Array(32),changed))
})
Deno.test('código tem 100 bits, normalização, hash com pepper obrigatório',async()=>{
  const codes=new Set(Array.from({length:100},()=>generateLinkCode()))
  equal(codes.size,100)
  for(const code of codes) {assert(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/.test(code));equal(normalizeCode(code.toLowerCase()),code.replaceAll('-',''))}
  const code=generateLinkCode();const hash=await hashLinkCode(code,FAKE_PEPPER)
  assert(hash&&/^[a-f0-9]{64}$/.test(hash));assert(!hash.includes(code))
  equal(await hashLinkCode(code,undefined),null);equal(await hashLinkCode(code,'curto'),null);equal(await hashLinkCode('inválido',FAKE_PEPPER),null)
})
Deno.test('secret do webhook com menos de 32 caracteres conta como ausente',()=>{
  equal(webhookSecretValue(undefined),undefined)
  equal(webhookSecretValue(''),undefined)
  equal(webhookSecretValue('x'.repeat(31)),undefined)
  equal(webhookSecretValue('y'.repeat(32)),'y'.repeat(32))
})
