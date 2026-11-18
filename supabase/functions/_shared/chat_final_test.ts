import { collectChatFinal,finalPlainText } from './chat_final.ts'
import { createMemoryDb } from './memory_db.ts'
import { prepareChat,type KeyAssessment,type OpenRouterClient } from './chat_core.ts'
import { USER,assert,equal } from './telegram_test_fixture.ts'
const accepted=async()=>({ok:true as const,limitUsd:3,remainingUsd:3})
const body=(mensagem='Quais as conexões de Mauá?')=>({mensagem,modelo:'basico',contexto:{entidades:[]}})
const noModel:OpenRouterClient={async *stream(){throw new Error('não deveria chamar modelo')}}
Deno.test('adaptador final preserva fora_da_base e libera reserva sem modelo',async()=>{
  const db=createMemoryDb()
  const r=await collectChatFinal({userId:USER,body:body('assunto inexistente zyx'),db,openrouter:noModel,budgetUsd:3,loadInferenceKey:accepted})
  equal(r.code,'fora_da_base');assert(finalPlainText(r).includes('base'));equal(db.commitCalls,0);equal(db.releaseCalls,1)
})
Deno.test('transporte recusa igual ao prepareChat da v18 no teto e no corpo',async()=>{
  const db=createMemoryDb()
  const key:KeyAssessment={ok:true,limitUsd:3,remainingUsd:3}
  const cases=[{body:body(),budgetUsd:0,code:'orcamento_esgotado'},{body:body('x'.repeat(2001)),budgetUsd:3,code:'pedido_invalido'}]
  for (const item of cases) {
    const direto=await prepareChat({userId:USER,body:item.body,db,budgetUsd:item.budgetUsd,inferenceKey:key})
    const via=await collectChatFinal({userId:USER,body:item.body,db,openrouter:noModel,budgetUsd:item.budgetUsd,loadInferenceKey:async()=>key})
    assert(!direto.ok)
    if (!direto.ok && direto.event.event==='error') equal(via.code,direto.event.data.code)
    equal(via.code,item.code)
  }
})
Deno.test('adaptador final mantém teto SEC-01, rate SEC-02, 2000 caracteres e chave fechada',async()=>{
  const db=createMemoryDb()
  const ask=(over:Record<string,unknown>={})=>collectChatFinal({userId:USER,body:body(),db,openrouter:noModel,budgetUsd:3,loadInferenceKey:accepted,...over})
  equal((await ask({budgetUsd:0})).code,'orcamento_esgotado')
  equal((await ask({body:body('x'.repeat(2001))})).code,'pedido_invalido')
  equal((await ask({loadInferenceKey:async()=>({ok:false,reason:'ausente'})})).code,'chave_recusada')
  for(let i=0;i<8;i++) await ask({budgetUsd:0})
  equal((await ask()).code,'rate_limit')
})
Deno.test('adaptador recebe final do modelo fake, cobra cota e mantém fontes em texto puro',async()=>{
  const db=createMemoryDb()
  const model:OpenRouterClient={async *stream(){yield {delta:JSON.stringify({blocos:[{tipo:'documentado',texto:'Mauá aparece no recorte documental.',entidades:['maua'],relacoes:['r1'],fontes:['S1']}],entidades:['maua'],fontes:['S1'],avisos:[],sem_base:false})};yield {usage:{prompt_tokens:20,completion_tokens:20,cost:0.0001}}}}
  const r=await collectChatFinal({userId:USER,body:body(),db,openrouter:model,budgetUsd:3,loadInferenceKey:accepted})
  assert(r.final);equal(db.commitCalls,1);assert(finalPlainText(r).includes('DOCUMENTADO'));assert(finalPlainText(r).includes('FONTES'));equal(r.final.gratis_restantes,19)
})
