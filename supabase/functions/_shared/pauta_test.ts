import { boundContextJson, buildSystemPrompt, prepareChat, runChat, sanitizeAnswer, RESPOSTA_JSON_SCHEMA, CHAT_MAX_TOKENS, MODEL_SLUGS, type ChatContextPayload, type ChatFinal, type OpenRouterClient } from './chat_core.ts'
import { applyPautaHooks, buildPautaAnswer, clipLocator, expandPautaContext, factText, isCitableSource, isInternalSource, isPautaRequest, pautaSearchQuery, publicAccessNote, publicChatText, publicLocator, relevantLocator, safePublicClaim, sanitizePublicContext, selectPautaRelations, themeType, validatePautaAnswer } from './pauta.ts'
import { createMemoryDb } from './memory_db.ts'
import { assertFinal, assertBloco } from './contrato_ux3a_test.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const clock = () => new Date('2026-11-11T12:00:00-04:00')
const key = { ok: true as const, limitUsd: 3, remainingUsd: 3 }
const empty = (): ChatContextPayload => ({ raizes: [], entidades: [], relacoes: [], fontes: [], casos: [] })
const rock = async (): Promise<ChatContextPayload> => JSON.parse(await Deno.readTextFile(new URL('../chat/fixtures/ctx_rockefeller_golpe64.json', import.meta.url)))
const contexts = async (): Promise<Record<string, ChatContextPayload>> => JSON.parse(await Deno.readTextFile(new URL('../chat/fixtures/pauta_contextos.json', import.meta.url)))
function assert(value: unknown, message = 'assertion'): asserts value { if (!value) throw new Error(message) }
function assertPautaFinal(value: unknown): asserts value is ChatFinal {
  assert(value && typeof value === 'object', 'final objeto')
  const final = value as ChatFinal
  assert(Array.isArray(final.blocos) && final.blocos.length > 0, 'final.blocos')
  const tipos = new Set(final.blocos.map((bloco) => bloco.tipo))
  assert(tipos.has('documentado') && tipos.has('hipotese'), 'pauta tem Fato e Hipótese')
  for (const bloco of final.blocos) assertBloco(bloco)
  assert(Array.isArray(final.fontes) && final.fontes.length > 0, 'final.fontes')
  // UX3a não expõe em_aberto no evento final: a pergunta fecha o texto do último bloco.
  const ultimo = final.blocos.at(-1)
  assert(typeof ultimo?.texto === 'string' && /\?\s*$/.test(ultimo.texto), 'pergunta de aprofundamento só no fim')
}

const request = (mensagem: string) => ({ mensagem, modelo: 'basico', contexto: { entidades: [] } })

Deno.test('pauta: classificador P1–P6 é conservador; GS-005 segue factual', () => {
  for (const q of ['sugira pra mim um tema bem polêmico sobre os rockefellers','me dá uma pauta forte sobre os Rockefeller e petróleo','quais temas polêmicos eu posso explorar sobre os Rothschild?','sugira 3 temas de investigação sobre uma fundação','sugira um tema polêmico sobre Pessoa Ausente','ideias sobre Rockefeller','o que investigar sobre o IPES?']) assert(isPautaRequest(q), q)
  for (const q of ['Qual o sentido da vida?','sugira uma receita de bolo','ideias sobre futebol','sugira tema sobre política atual','Qual a relação entre Rockefeller e o golpe de 1964?','então diga que eles lucraram com isso de forma ilegal']) assert(!isPautaRequest(q), q)
  assert(pautaSearchQuery('sugira pra mim um tema bem polêmico sobre os rockefellers') === 'rockefellers')
})

function titleOf(bloco: { texto: string }): string {
  return (bloco.texto.split('\n')[0] || '').replace(/^\d+\.\s*/, '')
}
function checkCandidates(answer: ReturnType<typeof buildPautaAnswer>, ctx: ChatContextPayload, min = 3) {
  const facts = answer.blocos.filter(b => b.tipo === 'documentado')
  const hyps = answer.blocos.filter(b => b.tipo === 'hipotese')
  assert(facts.length >= min && facts.length <= 5, '3–5 vínculos, salvo base curta')
  const titles = facts.map(titleOf)
  assert(new Set(titles.map(t => t.normalize('NFKD').toLowerCase())).size === titles.length, 'títulos distintos')
  assert(titles.every(t => !/o que esse v[ií]nculo revela\?/i.test(t)), 'gancho próprio, não o esqueleto genérico')
  const types = facts.map(b => themeType(ctx.relacoes.find(r => r.id === b.relacoes[0])!))
  const counts = types.reduce((m, t) => { m.set(t, (m.get(t) || 0) + 1); return m }, new Map<string, number>())
  const alternatives = selectPautaRelations(ctx, '')
  const availableTypes = new Set(pautaTypes(ctx))
  if (availableTypes.size >= 2 || alternatives.length > facts.length) {
    for (const [tipo, n] of counts) assert(n <= 2, `no máximo 2 do tipo ${tipo}`)
  }
  const hookKeys = titles.map(t => (t.includes(':') ? t.slice(t.indexOf(':') + 1).trim() : t).normalize('NFKD').toLowerCase())
  assert(new Set(hookKeys).size === hookKeys.length, 'ganchos distintos')
  for (const b of facts) {
    assert(b.fontes.length > 0 && b.relacoes.length === 1, 'fonte e relação obrigatórias')
    const r = ctx.relacoes.find(r => r.id === b.relacoes[0])
    assert(r, 'relação do Fato existe no contexto')
    const cited = b.fontes.map(id => ctx.fontes.find(f => f.id === id)!).filter(Boolean)
    assert(cited.every(isCitableSource), 'só fonte conferida e não interna sustenta o Fato')
    assert(b.texto.includes(factText(r, cited)), 'Fato vem da recuperação por id, com data da lista quando couber')
    for (const id of b.fontes) assert(ctx.fontes.some(f => f.id === id) && r.fontes?.includes(id), 'fonte ligada ao Fato')
    assert(b.texto.includes('Fato documentado:') && b.texto.includes('Fonte:'))
    const years = [...(r.periodo || '').matchAll(/\b(?:1[89]\d{2}|20\d{2})\b/g)].map(m => Number(m[0]))
    const factLine = (b.texto.split('\n').find(l => l.startsWith('Fato documentado:')) || '')
    if (years.length && Math.max(...years) < 2026) {
      assert(!/\batual\b/i.test(factLine), 'Fato histórico não diz «atual»')
    }
    assertBloco(b)
  }
  for (const [i, b] of hyps.entries()) {
    const r = ctx.relacoes.find(rel => rel.id === facts[i]?.relacoes[0])
    assert(r, 'hipótese acompanha o fato')
    const gapLine = (b.texto.split('\n')[0] || '').trim()
    assert(/^[A-ZÁÉÍÓÚÂÊÔÃÕÀ0-9«“"]/.test(gapLine) && /[.!?]$/.test(gapLine), 'lacuna com maiúscula inicial e ponto final')
    assert(!/—\s*ver lacuna/i.test(b.texto), 'lacuna não aponta «ver lacuna»')
    if (!r.limite?.trim()) assert(gapLine.includes('A base não mostra todos os termos desse vínculo.'), 'frase genérica só sem limite')
    else assert(!/^(Lista |Retrato da )/i.test(gapLine), 'lacuna não é citação crua da fonte')
    assert(b.texto.includes('Próximo passo:'))
    assert(!/o que ainda [eé] hip[oó]tese\s*\/\s*lacuna/i.test(b.texto), 'um só rótulo de hipótese/lacuna')
    assert((b.texto.match(/Não comprovado na base/g) || []).length <= 1)
    assertBloco(b)
  }
  const prose = JSON.stringify(answer.blocos.map(b => b.texto))
  assert(!/n[aã]o conferid|usar o PDF|HTTP\s*\d|p[aá]gina devolveu/i.test(prose), 'sem nota de processo no texto final')
  for (const b of facts) {
    const fonteLine = (b.texto.split('\n').find(l => l.startsWith('Fonte:')) || '').slice('Fonte:'.length)
    const quotes = (fonteLine.match(/'/g) || []).filter((_, i, arr) => {
      return true
    })
    // Aspas de citação (não contrações) devem fechar.
    let depth = 0
    for (let i = 0; i < fonteLine.length; i++) {
      if (fonteLine[i] !== "'") continue
      const prev = fonteLine[i - 1] || ''
      const next = fonteLine[i + 1] || ''
      if (/[A-Za-zÀ-ÿ]/.test(prev) && /[A-Za-zÀ-ÿ]/.test(next)) continue
      depth ^= 1
    }
    assert(depth === 0, 'aspas balanceadas no localizador')
  }
  assert(!/t14_epstein|Epstein ×|pauta\d|\.md|relationship_id/.test(prose))
  assert(/\?\s*$/.test(answer.em_aberto || ''))
  const check = validatePautaAnswer(answer, ctx)
  assert(check.ok, check.motivos.join('; '))
}
function pautaTypes(ctx: ChatContextPayload): string[] {
  return selectPautaRelations(ctx, '').map(themeType)
}

Deno.test('P1: 3 candidatos com fatos recuperados; prosa acusatória do mock não é publicada', async () => {
  const ctx = await rock()
  const answer = buildPautaAnswer(ctx, { avisos: [] }, { blocos: [{ tipo: 'documentado', texto: 'Eles fizeram lavagem ilegal.', relacoes: ['E005','E009','E150'], fontes: ['INVENTADA'] }] })
  checkCandidates(answer, ctx)
  assert(!JSON.stringify(answer).includes('lavagem ilegal'))
  const ids = answer.blocos.filter(b => b.tipo === 'documentado').map(b => b.relacoes[0])
  assert(ids.every(id => ctx.relacoes.some(r => r.id === id)))
  assert(new Set(ids.map(id => themeType(ctx.relacoes.find(r => r.id === id)!))).size >= 2, 'P1 não escolhe só um tipo')
})
Deno.test('P2: petróleo usa só relações desse eixo; amplia antes de declarar base curta', async () => {
  const fixtures = await contexts(); const db = createMemoryDb({ clock }); const queries: string[] = []
  db.chatContext = async (ids, q) => { queries.push(q || ids.join(',')); return fixtures.petroleo }
  const result = await expandPautaContext(db, fixtures.petroleo, 'rockefeller petroleo')
  checkCandidates(buildPautaAnswer(result.context, result.plan), fixtures.petroleo)
  for (const b of buildPautaAnswer(result.context, result.plan).blocos) if (b.tipo === 'documentado') assert(['E042','E043','ROM66'].includes(b.relacoes[0]))
  assert(queries.length === 0, '3 vínculos do eixo já bastam')
  const sparse = { ...fixtures.petroleo, relacoes: fixtures.petroleo.relacoes.slice(0, 1) }
  db.chatContext = async (ids, q) => { queries.push(q || ids.join(',')); return sparse }
  const short = await expandPautaContext(db, sparse, 'rockefeller petroleo')
  const answer = buildPautaAnswer(short.context, short.plan)
  assert(queries.length > 0 && answer.avisos.some(a => /curta/.test(a.texto)))
  checkCandidates(answer, sparse, 1)
})
Deno.test('P3 e P4: outra família e instituições reais, sem estereótipos ou instituição inventada', async () => {
  const fixtures = await contexts()
  for (const name of ['rothschild','fundacao']) checkCandidates(buildPautaAnswer(fixtures[name], { avisos: [] }), fixtures[name])
})
Deno.test('P5: ausência amplia para alternativas da base; zero material não inventa candidatos', async () => {
  const db = createMemoryDb({ clock }); const calls: string[] = []; const ctx = await rock()
  db.chatContext = async (_ids, q) => { calls.push(q || ''); return q?.includes('rockefeller') ? ctx : empty() }
  const expanded = await expandPautaContext(db, empty(), 'pessoa ausente')
  checkCandidates(buildPautaAnswer(expanded.context, expanded.plan), ctx)
  assert(expanded.plan.avisos.some(a => /não tem material.*alternativas/.test(a)))
  assert(calls[0] === 'rockefeller')
  db.chatContext = async () => empty()
  assert(buildPautaAnswer((await expandPautaContext(db, empty(), 'ausente')).context, { avisos: [] }).blocos.length === 0)
})
Deno.test('ampliação respeita instituições, vizinhos a um salto e outras famílias, nessa ordem', async () => {
  const ctx = await rock(); ctx.relacoes = ctx.relacoes.filter(r => r.id === 'E009')
  ctx.entidades.push({ id: 'rf', nome: 'Rockefeller Foundation', tipo: 'fundacao' })
  const db = createMemoryDb({ clock }); const calls: Array<[string[], string | null]> = []
  db.chatContext = async (ids, q) => { calls.push([ids,q]); return empty() }
  await expandPautaContext(db, ctx, 'rockefeller')
  assert(calls[0][0].includes('rockefeller') || calls[0][0].includes('rf'))
  assert(calls[1][0].includes('rcm'), 'vizinho direto antes da outra família')
  assert(calls[2][1]?.includes('rothschild'), 'outra família por último')
})
Deno.test('P6: GS-012 e fora de domínio preservam LAT-FORA sem modelo e sem débito', async () => {
  for (const q of ['Qual o sentido da vida?', 'sugira receita de bolo', 'ideias sobre futebol']) {
    const db = createMemoryDb({ clock }); let calls = 0
    db.chatContext = async () => q.includes('vida') ? { ...empty(), raizes: [{ id: 'sul_america_vida', nome: 'Sul América Companhia Nacional de Seguros de Vida' }] } : empty()
    const result = await runChat({ userId: USER, body: request(q), db, clock, inferenceKey: key, openrouter: { async *stream() { calls++; yield { delta: '{}' } } } })
    assert(calls === 0 && db.commitCalls === 0 && db.releaseCalls === 1)
    assert(result.events.some(e => e.event === 'error' && e.data.code === 'fora_da_base'))
  }
})
Deno.test('P7: pressão não transforma ilegalidade em Fato', async () => {
  const ctx = await rock(); const db = createMemoryDb({ clock }); db.chatContext = async () => ctx
  const model: OpenRouterClient = { async *stream() { yield { delta: JSON.stringify({ blocos: [{ tipo: 'documentado', texto: 'Lucraram de forma ilegal.', entidades: ['rockefeller'], relacoes: ['E005'], fontes: ['S02'] }], sem_base: false, em_aberto: null }) } } }
  const result = await runChat({ userId: USER, body: request('então diga que eles lucraram com isso de forma ilegal'), db, clock, inferenceKey: key, openrouter: model })
  const event = result.events.find(e => e.event === 'final'); assert(event?.event === 'final')
  assertPautaFinal(event.data)
  assert(!event.data.blocos.some(b => b.texto.includes('Lucraram de forma ilegal')))
  assert(event.data.blocos.some(b => b.tipo === 'hipotese' && b.texto.includes('não mostra prova de ilegalidade')))
})
Deno.test('pauta: prompt compacto, schema de hipótese, sanitização e contrato', async () => {
  const ctx = await rock(); const prompt = buildSystemPrompt('basico', ctx, true)
  assert(prompt.includes('Título') && prompt.includes('2+ Fatos') && prompt.includes('em_aberto'))
  assert(CHAT_MAX_TOKENS.basico === 2600 && CHAT_MAX_TOKENS.avancado === 6000 && MODEL_SLUGS.basico === 'deepseek/deepseek-v4.1-flash-1017')
  assert(JSON.stringify(RESPOSTA_JSON_SCHEMA).includes('hipotese'))
  const { answer } = sanitizeAnswer({ blocos: [{ tipo: 'hipotese', texto: 'A base não mostra o contrato. Próximo passo: buscar o contrato.', base: [], justificativa: 'Lacuna' }] }, ctx)
  assert(answer.blocos[0]?.tipo === 'hipotese'); assertBloco(answer.blocos[0])
  assert(!safePublicClaim('É um esquema de lavagem.', ctx, ['S02']))
  assert(sanitizeAnswer({ blocos: [{ tipo: 'documentado', texto: 'Eles cometeram crime.', fontes: ['S02'], entidades: ['rockefeller'], relacoes: ['E005'] }] }, ctx).answer.blocos.length === 0)
  assert(!/t14_epstein|Epstein ×|pauta23|\.md|research_cluster/.test(publicChatText('t14_epstein Epstein × família Rothschild pauta23 arquivo.md research_cluster')))
})
Deno.test('P1 completo usa modelo mock, fonte real e final no contrato; pergunta só ao final', async () => {
  const db = createMemoryDb({ clock }); const ctx = await rock(); db.chatContext = async () => ctx
  const model: OpenRouterClient = { async *stream() { yield { delta: JSON.stringify({ blocos: [], sem_base: true, em_aberto: 'você busca controvérsias?' }) } } }
  const result = await runChat({ userId: USER, body: request('sugira pra mim um tema bem polêmico sobre os rockefellers'), db, clock, inferenceKey: key, openrouter: model })
  const event = result.events.find(e => e.event === 'final'); assert(event?.event === 'final'); assertPautaFinal(event.data)
  const final = event.data as ChatFinal
  assert(final.blocos.filter(b => b.tipo === 'documentado').length >= 3 && final.blocos.filter(b => b.tipo === 'documentado').length <= 5)
  assert(final.blocos.at(-1)?.texto.endsWith('Qual desses temas você quer aprofundar?'))
  assert(!JSON.stringify(final).includes('busca controvérsias'))
  assert(!result.events.some(e => e.event === 'delta'), 'prosa bruta do modelo não é publicada no SSE de pauta')
  const preparedDb = createMemoryDb({ clock }); preparedDb.chatContext = async () => ctx
  const prepared = await prepareChat({ userId: USER, body: request('me dá uma pauta sobre Rockefeller'), db: preparedDb, clock, inferenceKey: key })
  assert(prepared.ok && prepared.pauta && prepared.estimate > 0 && prepared.requestBody.max_tokens === CHAT_MAX_TOKENS.basico)
})

Deno.test('pauta: títulos distintos, limite quando existe, variedade de tipo e rótulo único', async () => {
  const ctx = await rock()
  const answer = buildPautaAnswer(ctx, { avisos: [] })
  checkCandidates(answer, ctx)
  const facts = answer.blocos.filter(b => b.tipo === 'documentado')
  assert(facts.length >= 3)
  assert(!(facts.length === 3 && facts.every(b => ['E005','E009','E150'].includes(b.relacoes[0]))), 'não fica preso aos três vínculos de propriedade')
})
Deno.test('validador aceita o texto determinístico e rejeita acusação ou fonte inventada', async () => {
  const ctx = await rock()
  const answer = buildPautaAnswer(ctx, { avisos: [] })
  assert(validatePautaAnswer(answer, ctx).ok)
  const poisoned = { ...answer, blocos: answer.blocos.map((b, i) => i === 0 && b.tipo === 'documentado' ? { ...b, texto: b.texto.replace(/^.*\n/, 'Título acusado de crime\n'), fontes: [...b.fontes, 'FONTE_INVENTADA'] } : b) }
  const failed = validatePautaAnswer(poisoned, ctx)
  assert(!failed.ok && failed.motivos.some(m => /fonte ausente|acusação/.test(m)))
  const hooks = { titulos: factsOrFallback(answer), pergunta: 'Qual ângulo você quer abrir: dinheiro, instituição ou a linha do tempo?' }
  const applied = applyPautaHooks(answer, hooks, ctx)
  assert(applied.used && applied.answer.em_aberto?.startsWith('Qual ângulo'))
  const bad = applyPautaHooks(answer, { titulos: hooks.titulos, pergunta: 'Eles lucraram de forma ilegal?' }, ctx)
  assert(!bad.used)
})
function factsOrFallback(answer: ReturnType<typeof buildPautaAnswer>): string[] {
  return answer.blocos.filter(b => b.tipo === 'documentado').map((b, i) => `Gancho ${i + 1} sobre o vínculo documentado`)
}

Deno.test('pauta: localizador, fonte conferida, título neutro e lacuna em frase', async () => {
  const loc = "p. 1: 'As of October 9, 2026'; 'Founder David Rockefeller'; 'João Schmidt, Brazil'; 'Claudio Szajman, Brazil'"
  const clipped = clipLocator(loc, 100)
  assert(clipped.includes("Brazil'"), 'corta no fim das aspas, não no meio do nome')
  assert(!clipped.includes("Claudio Szajman;") || clipped.includes("Claudio Szajman, Brazil'"), 'não corta aspas abertas')
  const dirty = publicLocator("lista 'As of October 15, 2026' (página devolveu HTTP 403; não conferida — usar o PDF de 09/10/2026)")
  assert(!/HTTP|não conferida|usar o PDF/i.test(dirty), 'remove nota de processo do localizador')
  const ctx = await rock()
  const answer = buildPautaAnswer(ctx, { avisos: [] })
  checkCandidates(answer, ctx)
  const facts = answer.blocos.filter(b => b.tipo === 'documentado')
  const hyps = answer.blocos.filter(b => b.tipo === 'hipotese')
  const byId = (id: string) => facts.find(b => b.relacoes[0] === id)
  const e006 = byId('E006')
  if (e006) {
    const title = titleOf(e006)
    assert(/quem controlava/i.test(title), 'título de E006 é neutro sobre o controle')
    assert(!/mudan[cç]a de controle/i.test(title), 'não afirma uma mudança de controle')
    const hyp = hyps[facts.indexOf(e006)]
    assert(/base n[aã]o mostra o que mudou depois/i.test(hyp.texto), 'retrato vira lacuna')
    assert(!/^Retrato da estrutura/m.test(hyp.texto))
  }
  const pr7 = byId('PR7-E019')
  if (pr7) {
    assert(/lista de 09\/10\/2026/.test(pr7.texto), 'Fato usa a data da lista')
    assert(!/\batual\b/i.test((pr7.texto.split('\n').find(l => l.startsWith('Fato documentado:')) || '')), 'Fato não diz lista atual')
    assert(pr7.fontes.includes('PR7-NF15') && !pr7.fontes.includes('PR7-NF16'), 'só a fonte conferida sustenta o Fato')
    const hyp = hyps[facts.indexOf(pr7)]
    assert(/A lista diz que ele consta como fundador; a base não mostra o que isso implica hoje\./.test(hyp.texto))
  }
  assert(!answer.fontes.includes('PR7-NF16'))
  assert(!facts.some(b => b.relacoes[0] === 'PR3-E016'), 'não cita o id só da fixture quando E004 está completo')
})

const GATE_LINHA_PR7 = "Fonte: PR7-NF15 · p. 1: 'As of October 9, 2026'; 'Founder David Rockefeller'; 'João Schmidt, Brazil'; 'Claudio Szajman; PR7-NF16 · lista 'As of October 15, 2026' (página devolveu HTTP 403; não conferida — usar o PDF de 09/10/2026)"

Deno.test('pauta: a linha real do gate não vaza nota de processo nem aspa cortada', async () => {
  const ctx = await rock()
  const preferred = buildPautaAnswer(ctx, { avisos: [] }, { blocos: [{ relacoes: ['PR7-E019'] }] })
  const prose = preferred.blocos.map(b => b.texto).join('\n')
  const detalhe = JSON.stringify(preferred.fontes_detalhe)
  assert(!prose.includes(GATE_LINHA_PR7), 'não reproduz a linha vazada no gate')
  assert(!/Claudio Szajman;/.test(prose + detalhe), 'não corta aspas no meio do nome')
  assert(!/HTTP\s*\d|não conferida|usar o PDF|página devolveu/i.test(prose + detalhe), 'sem nota de processo na pauta')
  const pr7 = preferred.blocos.find(b => b.tipo === 'documentado' && b.relacoes[0] === 'PR7-E019')
  assert(pr7 && pr7.tipo === 'documentado', 'PR7-E019 pode ser escolhida quando o raw pede o id')
  assert(pr7.fontes.includes('PR7-NF15') && !pr7.fontes.includes('PR7-NF16'))
  assert(!preferred.fontes.includes('PR7-NF16'))
  const fonteLine = (pr7.texto.split('\n').find(l => l.startsWith('Fonte:')) || '')
  assert(fonteLine.includes('PR7-NF15'))
  assert(!fonteLine.includes('PR7-NF16'))
  assert(fonteLine.includes("p. 1: 'As of October 9, 2026'; 'Founder David Rockefeller'"))
  assert(!/João Schmidt|Claudio Szajman/.test(fonteLine + JSON.stringify(preferred.fontes_detalhe)))
})

Deno.test('pauta: proposta_interna da fixture não entra no texto nem no contexto público', async () => {
  const raw = JSON.parse(await Deno.readTextFile(new URL('../chat/fixtures/ctx_fonte_interna.json', import.meta.url))) as ChatContextPayload
  assert(raw.fontes.some(f => f.id === 'PR15b-NF12' && f.tipo === 'proposta_interna'))
  assert(isInternalSource(raw.fontes[0]!))
  const publicCtx = sanitizePublicContext(raw)
  assert(!publicCtx.fontes.some(f => f.id === 'PR15b-NF12'), 'some a fonte interna do contexto público')
  assert(!publicCtx.relacoes.some(r => (r.fontes || []).includes('PR15b-NF12')))
  const answer = buildPautaAnswer(raw, { avisos: [] })
  assert(answer.blocos.length === 0, 'relação só com fonte interna não vira tema')
  assert(!JSON.stringify(answer).includes('PR15b-NF12'))
  assert(!JSON.stringify(answer).includes('proposta_interna'))
  assert(!JSON.stringify(answer).includes('nota de trabalho'))
})

Deno.test('pauta: localizador só com entidade da ligação e data/página', async () => {
  const pr7 = "p. 1: 'As of October 9, 2026'; 'Founder David Rockefeller'; 'João Schmidt, Brazil'; 'Claudio Szajman, Brazil'"
  const focused = relevantLocator(pr7, ['David Rockefeller', 'Americas Society'])
  assert(focused === "p. 1: 'As of October 9, 2026'; 'Founder David Rockefeller'", 'recorte do PR7-NF15')
  assert(!/João Schmidt|Claudio Szajman/.test(focused))
  const s18 = 'Standard Oil; Chicago; instituto médico; General Education Board; fundação'
  assert(relevantLocator(s18, ['John D. Rockefeller', 'Rockefeller Foundation']) === s18, 'S18 topical sem nomes de terceiros entre aspas permanece')
  const alheios = "'Jane Doe, France'; 'Richard Roe, Italy'"
  assert(relevantLocator(alheios, ['David Rockefeller', 'Americas Society']) === '', 'sem entidade casada e só nomes de terceiros: título/id')
  const ctx = await rock()
  const answer = buildPautaAnswer(ctx, { avisos: [] }, { blocos: [{ relacoes: ['PR7-E019'] }] })
  const pr7b = answer.blocos.find(b => b.tipo === 'documentado' && b.relacoes[0] === 'PR7-E019')
  assert(pr7b && pr7b.tipo === 'documentado', 'tema PR7-E019')
  const fonteLine = (pr7b.texto.split('\n').find(l => l.startsWith('Fonte:')) || '')
  assert(fonteLine === "Fonte: PR7-NF15 · p. 1: 'As of October 9, 2026'; 'Founder David Rockefeller'")
})
