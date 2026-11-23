import { createTelegramHandler,LINK_INSTRUCTIONS,TELEGRAM_NOTICE_DELAY_MS,TELEGRAM_TYPING_INTERVAL_MS,TELEGRAM_TYPING_LIMIT_MS } from './handler.ts'
import { createTelegramClient,createTelegramSender,noticeLanguage,searchingLabel,splitTelegramText } from '../_shared/telegram_client.ts'
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
Deno.test('mini app sessão: HMAC válido, reabertura, prova antiga morta e user_id do corpo ignorado',async()=>{
  const f=fixture();f.links.set('101',USER);const init=await signedInitData()
  const start=await f.app('session',init);equal(start.status,200);const first=await start.json()
  const again=await f.app('session',init);equal(again.status,200);const second=await again.json()
  equal(second.linked,true);assert(second.session!==first.session)
  equal((await f.app('chat',init,{mensagem:'x'},first.session)).status,401)
  equal((await f.app('chat',init,{mensagem:'x',user_id:OTHER})).status,401)
  equal((await f.app('chat',init,{mensagem:'x'},'a'.repeat(64))).status,401)
  const result=await f.app('chat',init,{mensagem:'x',user_id:OTHER,telegram_id:202,contexto:{entidades:['ENT-9999']}},second.session)
  equal(result.status,422);equal(f.asked[0],{user:USER,body:{mensagem:'x',modelo:'basico',contexto:{entidades:[]}}})
  equal((await f.app('status',init,{},second.session)).status,200)
})
Deno.test('mini app não vinculado, auth ausente, secret/token ausente e sessão nova depois de desvincular',async()=>{
  const f=fixture(),init=await signedInitData()
  const start=await (await f.app('session',init)).json()
  equal(start.linked,false);equal((await f.app('chat',init,{mensagem:'x'},start.session)).status,403)
  await f.db.unlink('101');equal((await f.app('status',init,{},start.session)).status,401)
  const reopened=await f.app('session',init);equal(reopened.status,200);const body=await reopened.json()
  equal(body.linked,false)
  equal((await f.app('chat',init,{mensagem:'x'},start.session)).status,401)
  equal((await f.app('chat',init,{mensagem:'x'},body.session)).status,403)
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
Deno.test('cliente: ação, edição, exclusão e message_id sem vazar token nem URL',async()=>{
  const calls:{url:string;body:Record<string,unknown>;redirect:unknown}[]=[]
  const client=createTelegramClient(FAKE_TOKEN,async(input,options)=>{
    calls.push({url:String(input),body:JSON.parse(String(options?.body)),redirect:options?.redirect})
    return Response.json({ok:true,result:{message_id:String(input).endsWith('/sendMessage')?15:undefined}})
  })
  equal(await client.sendMessage('101','oi'),15)
  await client.sendChatAction('101')
  await client.editMessageText('101',15,'pronto')
  await client.deleteMessage('101',15)
  equal(calls.map(c=>c.url.split('/').pop()),['sendMessage','sendChatAction','editMessageText','deleteMessage'])
  equal(calls[1].body.action,'typing')
  equal(calls[2].body.message_id,15)
  equal(calls[2].body.disable_web_page_preview,true)
  equal((calls[2].body.link_preview_options as {is_disabled?:boolean}).is_disabled,true)
  for(const call of calls){equal(call.redirect,'error');assert(call.url.startsWith(`https://api.telegram.org/bot${FAKE_TOKEN}/`))}
  let message=''
  try{await createTelegramClient(FAKE_TOKEN,async()=>{throw new Error('https://api.telegram.org/bot'+FAKE_TOKEN+'/sendChatAction')}).sendChatAction('101')}catch(e){message=(e as Error).message}
  equal(message,'telegram_envio_falhou');assert(!message.includes(FAKE_TOKEN));assert(!message.includes('api.telegram.org'))
})
Deno.test('aviso de pesquisa em pt, en e es, com o texto ganhando do language_code',()=>{
  equal(searchingLabel('O que a base não documenta?','en'),'Pesquisando…')
  equal(searchingLabel('What does the base document about Mauá?','pt'),'Searching…')
  equal(searchingLabel('¿Qué documenta la base?','pt'),'Investigando…')
  equal(searchingLabel('Mauá','en-US'),'Searching…')
  equal(searchingLabel('Mauá','es'),'Investigando…')
  equal(searchingLabel('Mauá','pt-BR'),'Pesquisando…')
  equal(searchingLabel('Mauá',''),'Pesquisando…')
  equal(noticeLanguage('Você viu isso?','en'),'pt')
})
Deno.test('mini app recusa initData forjado, vencido e futuro sem abrir sessão',async()=>{
  const f=fixture()
  const forged=new URLSearchParams(await signedInitData());forged.set('hash','0'.repeat(64))
  equal((await f.app('session',forged.toString())).status,401)
  equal((await f.app('session',await signedInitData({auth_date:String(NOW-3601)}))).status,401)
  equal((await f.app('session',await signedInitData({auth_date:String(NOW+31)}))).status,401)
  equal(f.dbCalls(),0);assert(!f.calls.includes('begin'))
})
Deno.test('beginSession rotaciona o mesmo telegram, recusa outro e ignora expires inválido',async()=>{
  const f=fixture();f.links.set('101',USER)
  const hash='ab'.repeat(32),old='cd'.repeat(32),fresh='ef'.repeat(32)
  assert(await f.db.beginSession(hash,'101',old,NOW+600))
  assert(await f.db.beginSession(hash,'101',fresh,NOW+600))
  equal((await f.db.sessionUser(hash,'101',old)).ok,false)
  equal((await f.db.sessionUser(hash,'101',fresh)).userId,USER)
  equal(await f.db.beginSession(hash,'202','11'.repeat(32),NOW+600),false)
  equal((await f.db.sessionUser(hash,'101',fresh)).userId,USER)
  equal(await f.db.beginSession(hash,'101','22'.repeat(32),NOW-1),false)
  equal(await f.db.beginSession(hash,'101','22'.repeat(32),NOW+61*60+1),false)
  equal((await f.db.sessionUser(hash,'101',fresh)).userId,USER)
  f.setNow(NOW+601)
  assert(await f.db.beginSession(hash,'101','33'.repeat(32),NOW+601+600))
  equal((await f.db.sessionUser(hash,'101',fresh)).ok,false)
  equal((await f.db.sessionUser(hash,'101','33'.repeat(32))).userId,USER)
})
function documented(texto:string){return {status:200,final:{conversa_id:'c',blocos:[{tipo:'documentado' as const,texto,entidades:[],relacoes:[],fontes:[]}],entidades:[],fontes:[],fontes_detalhe:{},avisos:[],custo_real:0,gratis_restantes:1,saldo_pago:0}}}
function fakeClock(){
  let time=0,seq=0
  type Entry={at:number;seq:number;done:boolean;resolve:(value:'elapsed'|'cancelled')=>void}
  const pending=new Set<Entry>()
  const finish=(entry:Entry,reason:'elapsed'|'cancelled')=>{ if(entry.done)return;entry.done=true;pending.delete(entry);entry.resolve(reason) }
  return {
    now:()=>time,
    delay(ms:number){
      const entry:Entry={at:time+ms,seq:++seq,done:false,resolve:()=>{}}
      const promise=new Promise<'elapsed'|'cancelled'>(resolve=>{entry.resolve=resolve})
      pending.add(entry)
      return {promise,cancel(){finish(entry,'cancelled')}}
    },
    async advance(ms:number){
      const target=time+ms
      for(;;){
        let next:Entry|null=null
        for(const entry of pending) if(entry.at<=target&&(!next||entry.at<next.at||(entry.at===next.at&&entry.seq<next.seq))) next=entry
        if(!next) break
        time=next.at
        finish(next,'elapsed')
        for(let i=0;i<30;i++) await Promise.resolve()
      }
      time=target
    },
    pending:()=>pending.size,
  }
}
async function flush(){ for(let i=0;i<40;i++) await new Promise(resolve=>setImmediate(resolve)) }
function presenceHarness(){
  const state=testDb();state.links.set('101',USER)
  const clock=fakeClock()
  const sent:{id:string;text:string}[]=[],asked:unknown[]=[],typing:number[]=[],notices:string[]=[],edits:string[]=[],deletions:number[]=[]
  let failEdit=false,useGate=false,nextId=10
  let resolveAsk:(value:unknown)=>void=()=>{},rejectAsk:(error:unknown)=>void=()=>{}
  const askGate={promise:Promise.resolve() as Promise<unknown>}
  const renew=()=>{ askGate.promise=new Promise((resolve,reject)=>{resolveAsk=resolve;rejectAsk=reject}) }
  renew()
  const handler=createTelegramHandler({webhookSecret:()=>FAKE_SECRET,botToken:()=>FAKE_TOKEN,linkPepper:()=>FAKE_PEPPER,db:async()=>state.db,now:()=>NOW,clock,
    send:async(id,text)=>{sent.push({id,text})},
    ask:async(user,body)=>{ asked.push({user,body});return (useGate?askGate.promise:Promise.resolve({status:422,code:'fora_da_base',message:'Não encontrei isso na base do atlas.'})) as Promise<{status:number;code:string;message:string}> },
    bot:{
      async sendMessage(_id,text){notices.push(text);return nextId++},
      async sendChatAction(){typing.push(clock.now())},
      async editMessageText(_id,_messageId,text){ if(failEdit) throw new Error('edit-falhou');edits.push(text) },
      async deleteMessage(_id,messageId){deletions.push(messageId)},
    },
  })
  const webhook=(text:string,n=1,extra:Record<string,unknown>={})=>handler(new Request('http://local/telegram',{method:'POST',headers:{'x-telegram-bot-api-secret-token':FAKE_SECRET},body:JSON.stringify({update_id:n,message:{chat:{id:101,type:'private'},from:{id:101,...extra},text}})}))
  return {state,clock,sent,asked,typing,notices,edits,deletions,webhook,renew,resolve:()=>resolveAsk,reject:()=>rejectAsk,setUseGate:(value:boolean)=>{useGate=value},setFailEdit:(value:boolean)=>{failEdit=value}}
}
Deno.test('resposta rápida: typing uma vez, sem aviso e só a resposta final',async()=>{
  const p=presenceHarness()
  equal((await p.webhook('Pergunta rápida')).status,200)
  await flush()
  equal(p.typing.length,1);equal(p.notices.length,0);equal(p.edits.length,0);equal(p.deletions.length,0);equal(p.sent.length,1)
  assert(p.sent[0].text.includes('Não encontrei'));equal(p.clock.pending(),0)
})
Deno.test('aviso depois da espera, edição da mensagem e fallback quando a edição falha ou o texto é longo',async()=>{
  const slow=presenceHarness();slow.setUseGate(true);slow.renew()
  const pending=slow.webhook('O que a base não documenta?')
  await flush();equal(slow.typing.length,1);equal(slow.notices.length,0)
  await slow.clock.advance(TELEGRAM_NOTICE_DELAY_MS);await flush()
  equal(slow.notices,[ 'Pesquisando…' ]);assert(slow.typing.length>=2)
  slow.resolve()({status:422,code:'fora_da_base',message:'Não encontrei isso na base do atlas.'})
  equal((await pending).status,200)
  equal(slow.edits.length,1);assert(slow.edits[0].includes('Não encontrei'));equal(slow.sent.length,0);equal(slow.deletions.length,0);equal(slow.clock.pending(),0)
  const broken=presenceHarness();broken.setUseGate(true);broken.setFailEdit(true);broken.renew()
  const pendingEdit=broken.webhook('Mauá',2,{language_code:'en'})
  await flush();await broken.clock.advance(TELEGRAM_NOTICE_DELAY_MS);await flush()
  equal(broken.notices,['Searching…'])
  broken.resolve()({status:422,code:'fora_da_base',message:'Não encontrei isso na base do atlas.'})
  equal((await pendingEdit).status,200)
  equal(broken.edits.length,0);equal(broken.deletions.length,1);equal(broken.sent.length,1);equal(broken.clock.pending(),0)
  const huge=presenceHarness();huge.setUseGate(true);huge.renew()
  const pendingHuge=huge.webhook('¿Qué documenta la base?',3,{language_code:'pt'})
  await flush();await huge.clock.advance(TELEGRAM_NOTICE_DELAY_MS);await flush()
  equal(huge.notices,['Investigando…'])
  huge.resolve()(documented('x'.repeat(5000)))
  equal((await pendingHuge).status,200)
  equal(huge.edits.length,0);equal(huge.deletions.length,1);equal(huge.sent.length,1);assert(huge.sent[0].text.length>4096);equal(huge.clock.pending(),0)
})
Deno.test('typing repete, para no teto e não deixa timer em sucesso, erro ou timeout',async()=>{
  const ok=presenceHarness();ok.setUseGate(true);ok.renew()
  const pending=ok.webhook('Pergunta')
  await flush()
  await ok.clock.advance(TELEGRAM_TYPING_LIMIT_MS);await flush()
  equal(ok.typing.length,Math.ceil(TELEGRAM_TYPING_LIMIT_MS/TELEGRAM_TYPING_INTERVAL_MS))
  equal(ok.clock.pending(),0);equal(ok.notices.length,1)
  ok.resolve()({status:422,code:'fora_da_base',message:'Não encontrei isso na base do atlas.'})
  equal((await pending).status,200);equal(ok.clock.pending(),0)
  const failed=presenceHarness();failed.setUseGate(true);failed.renew()
  const pendingFail=failed.webhook('Pergunta',2)
  await flush();await failed.clock.advance(TELEGRAM_NOTICE_DELAY_MS);await flush()
  equal(failed.notices,['Pesquisando…'])
  failed.reject()(new Error('modelo'))
  equal((await pendingFail).status,502)
  equal(failed.deletions.length,1);equal(failed.edits.length,0);equal(failed.sent.length,0);equal(failed.clock.pending(),0);equal(failed.asked.length,1)
})
Deno.test('/start, /desvincular, código inválido, texto longo e sem vínculo não disparam typing',async()=>{
  const p=presenceHarness()
  await p.webhook('/start',1);await p.webhook('/desvincular',2);await p.webhook('/start codigo-invalido',3);await p.webhook('x'.repeat(2001),4)
  p.state.links.delete('101');await p.webhook('Pergunta sem vínculo',5)
  equal(p.typing.length,0);equal(p.notices.length,0);equal(p.asked.length,0);equal(p.clock.pending(),0)
  assert(p.sent.some(item=>item.text.includes('Bem-vindo')));assert(p.sent.some(item=>item.text.includes('Vínculo removido')));assert(p.sent.some(item=>item.text===LINK_INSTRUCTIONS))
})
Deno.test('waitUntil responde 200 depois do claim e o retry não pergunta de novo',async()=>{
  const p=presenceHarness();p.setUseGate(true);p.renew()
  const runtime=globalThis as {EdgeRuntime?: {waitUntil:(job:Promise<unknown>)=>void}}
  const previous=runtime.EdgeRuntime
  let background:Promise<unknown>|undefined
  runtime.EdgeRuntime={waitUntil(job){background=job}}
  try {
    const response=await p.webhook('Pergunta',8);await flush()
    equal(response.status,200);equal(p.asked.length,1);equal(p.sent.length,0)
    equal((await p.webhook('Pergunta',8)).status,200);equal(p.asked.length,1)
    p.resolve()({status:422,code:'fora_da_base',message:'Não encontrei isso na base do atlas.'})
    await background;await flush()
    equal(p.sent.length,1);equal(p.asked.length,1);equal(p.clock.pending(),0)
  } finally { if(previous) runtime.EdgeRuntime=previous; else delete runtime.EdgeRuntime }
})
