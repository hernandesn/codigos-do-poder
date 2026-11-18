import { createTelegramHandler,LINK_INSTRUCTIONS } from './handler.ts'
import { createTelegramSender,splitTelegramText } from '../_shared/telegram_client.ts'
import { generateLinkCode,hashLinkCode } from '../_shared/telegram_auth.ts'
import { FAKE_TOKEN,FAKE_PEPPER,FAKE_SECRET,NOW,USER,OTHER,assert,equal,signedInitData,testDb } from '../_shared/telegram_test_fixture.ts'
function fixture() {
  const state=testDb(),sent:{id:string;text:string}[]=[],asked:{user:string;body:unknown}[]=[],logs:unknown[]=[]
  let dbCalls=0
  const handler=createTelegramHandler({webhookSecret:()=>FAKE_SECRET,botToken:()=>FAKE_TOKEN,linkPepper:()=>FAKE_PEPPER,db:async()=>{dbCalls++;return state.db},now:()=>NOW,
    send:async(id,text)=>{sent.push({id,text})},ask:async(user,body)=>{asked.push({user,body});return {status:422,code:'fora_da_base',message:'Não encontrei isso na base do atlas.'}},log:e=>{logs.push(e)}})
  const update=(text='Pergunta sintética',n=1,extra:Record<string,unknown>={})=>({update_id:n,message:{chat:{id:101,type:'private'},from:{id:101},text},...extra})
  const webhook=(body:unknown,secret:string|null=FAKE_SECRET)=>handler(new Request('http://local/telegram',{method:'POST',headers:secret?{'x-telegram-bot-api-secret-token':secret}:{},body:JSON.stringify(body)}))
  const app=async(route:string,init:string,body:unknown={},proof?:string)=>handler(new Request('http://local/telegram/app/'+route,{method:'POST',headers:{authorization:'tma '+init,...(proof?{'x-telegram-app-session':proof}:{})},body:JSON.stringify(body)}))
  return {...state,handler,sent,asked,logs,update,webhook,app,dbCalls:()=>dbCalls}
}
Deno.test('webhook secret ausente/incorreto: 401 antes de body e DB até em corpo excessivo',async()=>{
  const f=fixture()
  for(const secret of [null,'errado']) equal((await f.webhook(f.update(),secret)).status,401)
  const request=new Request('http://local/telegram',{method:'POST',headers:{'content-length':'900000'},body:'nunca ler'})
  request.body!.getReader=()=>{throw new Error('O corpo não deve ser lido antes do secret')} 
  const response=await f.handler(request)
  equal(response.status,401);equal(f.dbCalls(),0);equal(f.sent.length,0)
})
Deno.test('webhook secret certo: corpo excessivo 413 e JSON malformado 400',async()=>{
  const f=fixture()
  equal((await f.webhook({payload:'x'.repeat(65536)})).status,413)
  equal((await f.handler(new Request('http://local/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':FAKE_SECRET},body:'{'}))).status,400)
  equal(f.dbCalls(),0)
})
Deno.test('grupo, canal, edição, callback, membro, sem from e mídia ignorados sem DB',async()=>{
  const f=fixture()
  for(const body of [f.update('x',1,{message:{chat:{id:101,type:'group'},from:{id:101},text:'x'}}),f.update('x',1,{message:{chat:{id:101,type:'channel'},from:{id:101},text:'x'}}),{update_id:1,edited_message:{}},{update_id:2,callback_query:{}},{update_id:3,my_chat_member:{}},{update_id:4,message:{chat:{type:'private',id:101},text:'x'}},{update_id:5,message:{chat:{type:'private',id:101},from:{id:101},photo:[]}}]) equal((await f.webhook(body)).status,200)
  equal(f.dbCalls(),0);equal(f.sent,[])
})
Deno.test('limite recebido 2000 recusa acima sem chamar núcleo; fronteira passa',async()=>{
  const f=fixture();f.links.set('101',USER)
  await f.webhook(f.update('x'.repeat(2001)));assert(f.sent[0].text.includes('2000'));equal(f.asked.length,0)
  await f.webhook(f.update('x'.repeat(2000),2));equal(f.asked.length,1)
})
Deno.test('idempotência inclusive concorrente: uma chamada ao núcleo e um envio',async()=>{
  const f=fixture();f.links.set('101',USER)
  await Promise.all([f.webhook(f.update()),f.webhook(f.update()),f.webhook(f.update())])
  equal(f.sent.length,1);equal(f.asked.length,1);equal(f.rates.get('101')?.length,1)
})
Deno.test('rate Telegram vem antes do vínculo e modelo; bloqueio não grava overflow nem envia',async()=>{
  const f=fixture();f.links.set('101',USER)
  for(let i=0;i<15;i++)await f.webhook(f.update('x',i))
  equal(f.rates.get('101')?.length,8);equal(f.asked.length,8);equal(f.sent.length,8)
  const calls=f.calls.slice();equal(calls.filter(x=>x==='linked').length,8)
})
Deno.test('sem vínculo e /start orientam conta existente e username correto',async()=>{
  const f=fixture();await f.webhook(f.update());await f.webhook(f.update('/start',2))
  equal(f.sent[0].text,LINK_INSTRUCTIONS);assert(f.sent[1].text.includes('@aion_codigosdopoder_bot'));equal(f.asked.length,0)
})
Deno.test('vínculo com código, uso único, expirado, rebind e desvínculo',async()=>{
  const f=fixture(),code=generateLinkCode(),hash=await hashLinkCode(code,FAKE_PEPPER)
  assert(hash);await f.db.issueCode(USER,hash,NOW)
  await f.webhook(f.update('/start '+code));equal(f.links.get('101'),USER)
  await f.webhook(f.update('/start '+code,2));assert(f.sent[1].text.includes('já usado'))
  const other=generateLinkCode(),otherHash=await hashLinkCode(other,FAKE_PEPPER);assert(otherHash);await f.db.issueCode(OTHER,otherHash,NOW)
  f.codes.get(otherHash)!.expires=NOW-1;await f.webhook(f.update('/start '+other,3));equal(f.links.get('101'),USER)
  f.codes.get(otherHash)!.expires=NOW+600;f.links.set('202',OTHER)
  await f.webhook(f.update('/start '+other,4));equal(f.links.get('101'),OTHER);assert(!f.links.has('202'))
  await f.webhook(f.update('/desvincular',5));equal(f.links.size,0)
})
Deno.test('mini app sessão: HMAC válido, replay, prova falsa e user_id do corpo ignorado',async()=>{
  const f=fixture();f.links.set('101',USER);const init=await signedInitData()
  const start=await f.app('session',init);equal(start.status,200);const {session}=await start.json()
  equal((await f.app('session',init)).status,401)
  equal((await f.app('chat',init,{mensagem:'x',user_id:OTHER})).status,401)
  equal((await f.app('chat',init,{mensagem:'x'},'a'.repeat(64))).status,401)
  const result=await f.app('chat',init,{mensagem:'x',user_id:OTHER,telegram_id:202,contexto:{entidades:['ENT-9999']}},session)
  equal(result.status,422);equal(f.asked[0],{user:USER,body:{mensagem:'x',modelo:'basico',contexto:{entidades:[]}}})
  equal((await f.app('status',init,{},session)).status,200)
})
Deno.test('mini app não vinculado, auth ausente, secret/token ausente e replay depois de desvincular',async()=>{
  const f=fixture(),init=await signedInitData()
  const start=await (await f.app('session',init)).json()
  equal(start.linked,false);equal((await f.app('chat',init,{mensagem:'x'},start.session)).status,403)
  await f.db.unlink('101');equal((await f.app('status',init,{},start.session)).status,401)
  equal((await f.app('session',init)).status,401)
  const h=createTelegramHandler({webhookSecret:()=>undefined,botToken:()=>undefined,linkPepper:()=>undefined,db:async()=>{throw new Error('DB não deve ser tocado')},send:async()=>{},ask:async()=>{throw new Error('núcleo não deve ser tocado')}})
  for(const [url,headers] of [['http://local/telegram',{}],['http://local/telegram/app/session',{authorization:'tma '+init}]] as const) equal((await h(new Request(url,{method:'POST',headers,body:'{}'}))).status,401)
})
Deno.test('sessão resolve usuário atomicamente e não herda novo dono após rebind',async()=>{
  const f=fixture();f.links.set('101',USER);const init=await signedInitData()
  const {session}=await (await f.app('session',init)).json()
  const original=f.db.sessionUser
  // Simula rebind imediatamente DEPOIS do snapshot de autorização. A pergunta
  // em andamento usa o usuário autenticado naquele snapshot, nunca o novo dono.
  f.db.sessionUser=async(...args)=>{const checked=await original(...args);f.links.set('101',OTHER);return checked}
  await f.app('chat',init,{mensagem:'x'},session)
  equal(f.asked[0].user,USER)
  equal((await f.app('chat',init,{mensagem:'x'},session)).status,401)
  equal(f.asked.length,1)
})
Deno.test('mini app CORS sem novas origens, preflight e corpo limitado',async()=>{
  const f=fixture()
  const req=(origin:string)=>new Request('http://local/telegram/app/chat',{method:'OPTIONS',headers:{origin}})
  const pre=await f.handler(req('https://aion.hernandesnogueira.com.br'));equal(pre.status,204);assert(pre.headers.get('access-control-allow-headers')?.includes('x-telegram-app-session'))
  equal((await f.handler(req('https://malicioso.invalid'))).status,403)
  const large=await f.app('chat',await signedInitData(),{mensagem:'x'.repeat(65536)})
  equal(large.status,413);equal(f.dbCalls(),0)
})
Deno.test('logs estruturados sem texto livre, initData, ids externos, códigos ou erro de fetch',async()=>{
  const f=fixture(),code=generateLinkCode();await f.webhook(f.update('/start '+code));const init=await signedInitData();await f.app('session',init)
  const encoded=JSON.stringify(f.logs)
  for(const forbidden of [code,init,FAKE_TOKEN,FAKE_SECRET,FAKE_PEPPER,'/start','first_name','telegram_id']) assert(!encoded.includes(forbidden))
  for(const entry of f.logs) equal(Object.keys(entry as object).sort(),['classificacao','evento','pedido_id'])
})
Deno.test('sendMessage injetado: host fixo, texto puro, chunks e redirect bloqueado',async()=>{
  const calls:{url:string;body:Record<string,unknown>;redirect:unknown}[]=[]
  const send=createTelegramSender(FAKE_TOKEN,async(input,options)=>{calls.push({url:String(input),body:JSON.parse(String(options?.body)),redirect:options?.redirect});return Response.json({ok:true})})
  const text='<b>HTML</b> & *Markdown* '+ '😀'.repeat(5000)
  await send('101',text);assert(calls.length>1)
  equal(calls.map(c=>c.body.text).join(''),text)
  for(const c of calls){equal(c.url,`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);assert(String(c.body.text).length<=4096);assert(!('parse_mode' in c.body));equal(c.body.disable_web_page_preview,true);equal((c.body.link_preview_options as {is_disabled?:boolean}).is_disabled,true);equal(c.redirect,'error')}
  equal(splitTelegramText('x'.repeat(4096)).length,1)
  let rejected=false;try{createTelegramSender('fake/../../evil',async()=>{throw new Error('não chamar')})}catch{rejected=true}assert(rejected)
})
Deno.test('webhook com secret certo e sem token do bot: 503 antes do claim e do núcleo',async()=>{
  let dbCalls=0
  const h=createTelegramHandler({webhookSecret:()=>FAKE_SECRET,botToken:()=>undefined,linkPepper:()=>FAKE_PEPPER,db:async()=>{dbCalls++;throw new Error('DB não deve ser tocado')},send:async()=>{throw new Error('envio não deve ocorrer')},ask:async()=>{throw new Error('núcleo não deve ser tocado')}})
  for(const text of ['Pergunta','/desvincular']){
    const response=await h(new Request('http://local/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':FAKE_SECRET},body:JSON.stringify({update_id:text.length,message:{chat:{id:101,type:'private'},from:{id:101},text}})}))
    equal(response.status,503)
  }
  equal(dbCalls,0)
})
Deno.test('com o rate esgotado, /desvincular remove o vínculo e invalida a sessão; pergunta, /start e texto longo seguem sem modelo nem envio',async()=>{
  const confirm='Vínculo removido do @aion_codigosdopoder_bot. Para vincular novamente, gere outro código na página de vínculo.'
  const rateCalls=(f:ReturnType<typeof fixture>)=>f.calls.filter(x=>x==='rate').length
  const f=fixture();f.links.set('101',USER);const init=await signedInitData()
  const {session}=await (await f.app('session',init)).json()
  for(let i=0;i<7;i++)await f.webhook(f.update('p'+i,i+1))
  equal(f.rates.get('101')?.length,8);equal(f.asked.length,7);equal(f.sent.length,7)
  await f.webhook(f.update('excesso',30));await f.webhook(f.update('/start',31));await f.webhook(f.update('/desvincular '+'x'.repeat(2000),32))
  equal(f.sent.length,7);equal(f.asked.length,7);equal(f.links.get('101'),USER);equal(f.rates.get('101')?.length,8)
  const ratesBefore=rateCalls(f)
  equal((await f.webhook(f.update('/desvincular',33))).status,200)
  equal(f.links.size,0);equal(f.asked.length,7);equal(f.rates.get('101')?.length,8);equal(rateCalls(f),ratesBefore)
  equal(f.sent.at(-1)?.text,confirm);equal((await f.app('status',init,{},session)).status,401)
  await f.webhook(f.update('/desvincular',33));equal(f.sent.length,8)
  await f.webhook(f.update('ainda no limite',34));await f.webhook(f.update('/start codigo',35))
  equal(f.asked.length,7);equal(f.sent.length,8);equal(f.rates.get('101')?.length,8);equal(rateCalls(f),ratesBefore+2)
  const g=fixture();g.links.set('101',USER);const initDay=await signedInitData()
  const opened=await (await g.app('session',initDay)).json()
  g.rates.set('101',Array.from({length:100},()=>NOW))
  await g.webhook(g.update('dia cheio',1));equal(g.asked.length,0);equal(g.sent.length,0);equal(g.rates.get('101')?.length,100)
  const dayRates=g.calls.filter(x=>x==='rate').length
  equal((await g.webhook(g.update('/desvincular@aion_codigosdopoder_bot',2))).status,200)
  equal(g.links.size,0);equal(g.asked.length,0);equal(g.rates.get('101')?.length,100);equal(g.calls.filter(x=>x==='rate').length,dayRates)
  equal(g.sent[0]?.text,confirm);equal((await g.app('status',initDay,{},opened.session)).status,401)
  await g.webhook(g.update('continua bloqueada',3));equal(g.asked.length,0);equal(g.sent.length,1);equal(g.rates.get('101')?.length,100)
})
Deno.test('falhas de envio não propagam URL/token ou corpo remoto',async()=>{
  for(const mock of [async()=>{throw new Error('conteúdo livre secreto')},async()=>Response.json({ok:false,description:'conteúdo livre secreto'})]) {
    let message='';try{await createTelegramSender(FAKE_TOKEN,mock)('101','x')}catch(e){message=(e as Error).message}
    equal(message,'telegram_envio_falhou')
  }
})
