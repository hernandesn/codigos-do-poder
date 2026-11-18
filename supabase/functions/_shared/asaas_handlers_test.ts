import { createAsaasCancelHandler } from '../asaas-cancel/handler.ts'
import { createAsaasCheckoutHandler } from '../asaas-checkout/handler.ts'
import { createAsaasWebhookHandler } from '../asaas-webhook/handler.ts'
import { createSandboxWebhookHandler } from '../sandbox_asaas_webhook/handler.ts'
import { createAsaasClient, type AsaasClient } from './asaas_client.ts'
import { somarMesIso } from './asaas_datas.ts'
import { criarMemoriaAsaas, type MemoriaAsaas } from './asaas_memoria.ts'
import { ASAAS_SANDBOX_BASE, ORIGEM_SITE } from './asaas_planos.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const CHAVE = 'chave_sintetica_sandbox_0123456789abcd'
const TOKEN = 'w'.repeat(40)
const CPF = '52998224725'
const NOME = 'Maria Exemplo'
const RELOGIO = () => new Date('2026-11-18T15:00:00.000Z')
const PERMITIDAS = new Set([
  'chat_private.asaas_preparar_checkout', 'chat_private.asaas_vincular_checkout', 'chat_private.asaas_descartar_checkout',
  'chat_private.asaas_marcar_checkout_enviando', 'chat_private.asaas_descartar_envio_recusado',
  'chat_private.asaas_marcar_checkout_incerto',
  'chat_private.asaas_obter_cliente', 'chat_private.asaas_gravar_cliente', 'chat_private.asaas_aplicar_evento',
  'chat_private.asaas_status', 'chat_private.asaas_pedir_cancelamento', 'chat_private.asaas_marcar_cancelamento',
  'chat_private.asaas_falhar_cancelamento', 'chat_private.asaas_liberar_checkout', 'chat_private.asaas_vincular_assinatura_remota',
])

function assert(cond: unknown, msg?: string) {
  if (!cond) throw new Error(msg || 'asserção')
}
function equal(a: unknown, b: unknown) {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  if (ja !== jb) throw new Error('esperado ' + jb + ' obtido ' + ja)
}
function erroCodigo(code: string, message = 'NAO_VAZAR_INTERNO') {
  const erro = new Error(message) as Error & { code: string }
  erro.code = code
  return erro
}
async function ler(res: Response) {
  const text = await res.text()
  let body: Record<string, unknown> | null = null
  try { body = text ? JSON.parse(text) as Record<string, unknown> : null } catch { body = null }
  return { status: res.status, text, body, headers: res.headers }
}
function semSegredo(logs: unknown, texto: string) {
  const bruto = JSON.stringify(logs) + texto
  for (const item of [CPF, '529.982.247-25', NOME, CHAVE, TOKEN, 'CORPO_REMOTO_NAO_VAZAR', 'NAO_VAZAR_INTERNO', 'sub_alheio_NAO_LOGAR', 'cartao_teste']) {
    if (bruto.includes(item)) throw new Error('vazou segredo')
  }
  if (Array.isArray(logs)) {
    const chaves = new Set(['fn', 'evento', 'pedido_id', 'plano', 'resultado', 'http', 'modo', 'event_id', 'recurso_id', 'subscription_id', 'classificacao'])
    for (const entrada of logs) for (const chave of Object.keys(entrada as object)) {
      if (!chaves.has(chave)) throw new Error('chave de log')
    }
  }
}
function tabelasOk(mem: MemoriaAsaas) {
  for (const nome of mem.tocadas) {
    if (!PERMITIDAS.has(nome)) throw new Error('chamada fora da lista')
    for (const proibida of ['credit_balances', 'credit_ledger', 'free_quota_daily', 'unlimited_users']) {
      if (nome.includes(proibida)) throw new Error('tabela do chat')
    }
  }
}
interface Chamada { url: string, method: string, body: string | null, redirect: unknown, signal: boolean, token: string | null }
function cliente(rotas: (chamada: Chamada) => Response | Promise<Response>) {
  const chamadas: Chamada[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    const chamada: Chamada = {
      url: String(input), method: init?.method || 'GET', body: typeof init?.body === 'string' ? init.body : null,
      redirect: init?.redirect ?? null, signal: Boolean(init?.signal), token: headers.get('access_token'),
    }
    chamadas.push(chamada)
    return rotas(chamada)
  }
  return { chamadas, client: createAsaasClient({ fetch: fetchImpl, apiKey: CHAVE, baseUrl: ASAAS_SANDBOX_BASE }) }
}
function rotasOk(chamada: Chamada): Response {
  if (chamada.method === 'POST' && chamada.url.endsWith('/v3/customers')) return Response.json({ id: 'cus_teste123' })
  if (chamada.method === 'POST' && chamada.url.endsWith('/v3/checkouts')) {
    return Response.json({ id: 'chk_teste123', link: 'https://sandbox.asaas.com/checkoutSession/show?id=chk_teste123' })
  }
  if (chamada.method === 'GET' && chamada.url.includes('/v3/customers/')) return Response.json({ id: 'cus_teste123' })
  if (chamada.method === 'GET' && chamada.url.includes('/v3/subscriptions?')) return Response.json({ data: [], hasMore: false })
  if (chamada.method === 'DELETE') return Response.json({ deleted: true, id: 'sub_do_usuario' })
  return Response.json({ id: 'sub_do_usuario', deleted: false, status: 'ACTIVE' })
}
function pedido(url: string, body: unknown, extra: Record<string, string> = {}, method = 'POST') {
  const headers: Record<string, string> = { origin: ORIGEM_SITE, authorization: 'Bearer teste', 'content-type': 'application/json', ...extra }
  return new Request(url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
}
const PEDIDO = { plano: 'basico', nome: NOME, cpfCnpj: '529.982.247-25', valor: 0.01, value: 1, price: 2, nextDueDate: '1999-01-01', user_id: OTHER }

function checkoutDe(mem: MemoriaAsaas, opts: Record<string, unknown> = {}) {
  const fake = cliente((opts.rotas as typeof rotasOk) || rotasOk)
  const logs: Record<string, string>[] = []
  const handler = createAsaasCheckoutHandler({
    authenticate: (opts.authenticate as (h: string | null) => Promise<string | null>) || (async (header) => header ? USER : null),
    db: (opts.db as (() => Promise<MemoriaAsaas['db']>) | undefined) || (async () => { if (opts.dbErro) throw opts.dbErro; return mem.db }),
    baseUrl: (opts.baseUrl as () => string) || (() => ASAAS_SANDBOX_BASE),
    criarAsaas: (opts.criarAsaas as () => AsaasClient | null) || (() => fake.client),
    now: (opts.now as () => Date) || RELOGIO,
    log: (entrada) => logs.push(entrada),
  })
  return { handler, logs, chamadas: fake.chamadas }
}

Deno.test('checkout: preço, plano e data saem do servidor; corpo do cliente é ignorado', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  const f = checkoutDe(mem)
  const res = await ler(await f.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(res.status, 200)
  equal(Object.keys(res.body || {}), ['url'])
  equal(res.body?.url, 'https://sandbox.asaas.com/checkoutSession/show?id=chk_teste123')
  const clientePost = f.chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/v3/customers'))
  const checkoutPost = f.chamadas.filter((c) => c.url.endsWith('/v3/checkouts'))
  equal(checkoutPost.length, 1)
  equal(f.chamadas.filter((c) => c.url.includes('/v3/subscriptions?customer=')).length, 0)
  const corpo = JSON.parse(checkoutPost[0].body || '{}')
  equal(corpo.items[0].value, 9.9)
  equal(corpo.items[0].name, 'Plano Básico')
  equal(corpo.billingTypes, ['CREDIT_CARD'])
  equal(corpo.chargeTypes, ['RECURRENT'])
  equal(corpo.subscription.cycle, 'MONTHLY')
  equal(corpo.subscription.nextDueDate, '2026-11-25 00:00:00')
  equal(corpo.minutesToExpire, 60)
  equal(corpo.customer, 'cus_teste123')
  equal(corpo.externalReference, mem.linhas[0].id)
  assert(String(corpo.callback.successUrl).startsWith(ORIGEM_SITE + '/cancelar.html?retorno=sucesso'))
  assert(!JSON.stringify(corpo).includes('1999-01-01'))
  assert(!JSON.stringify(corpo).includes('0.01'))
  const pessoa = JSON.parse(clientePost?.body || '{}')
  equal(pessoa.cpfCnpj, CPF)
  equal(pessoa.notificationDisabled, true)
  equal(f.chamadas[0].token, CHAVE)
  equal(f.chamadas[0].redirect, 'error')
  equal(await mem.db.obterCliente('sandbox', USER), 'cus_teste123')
  equal(await mem.db.obterCliente('sandbox', OTHER), null)
  semSegredo(f.logs, res.text)
  tabelasOk(mem)
})

Deno.test('checkout plus e viradas de dia usam o relógio de São Paulo', async () => {
  for (const [iso, data] of [
    ['2026-12-01T02:30:00.000Z', '2026-12-07 00:00:00'],
    ['2026-12-01T03:30:00.000Z', '2026-12-08 00:00:00'],
    ['2026-01-31T15:00:00.000Z', '2026-02-07 00:00:00'],
  ] as const) {
    const agora = () => new Date(iso)
    const mem = criarMemoriaAsaas(agora)
    const f = checkoutDe(mem, { now: agora })
    const corpoPedido = { ...PEDIDO, plano: 'plus', valor: 1, nextDueDate: '1999-01-01' }
    const res = await ler(await f.handler(pedido('http://local/asaas-checkout', corpoPedido)))
    equal(res.status, 200)
    const corpo = JSON.parse(f.chamadas.find((c) => c.url.endsWith('/v3/checkouts'))?.body || '{}')
    equal(corpo.items[0].value, 29.9)
    equal(corpo.items[0].name, 'Plano Plus')
    equal(corpo.subscription.nextDueDate, data)
  }
})

Deno.test('checkout recusa plano, CPF, trial usado, assinatura aberta e origem', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  const ruim = checkoutDe(mem, {
    authenticate: async () => { throw new Error('auth') },
    baseUrl: () => { throw new Error('base') },
    criarAsaas: () => { throw new Error('cliente') },
    db: async () => { throw new Error('db') },
  })
  equal((await ruim.handler(pedido('http://local/asaas-checkout', PEDIDO, { origin: 'https://hernandesn.github.io' }))).status, 403)
  equal((await ruim.handler(pedido('http://local/asaas-checkout', PEDIDO, { origin: 'http://localhost:8080' }))).status, 403)
  const pre = await ruim.handler(new Request('http://local/asaas-checkout', { method: 'OPTIONS', headers: { origin: ORIGEM_SITE } }))
  equal(pre.status, 204)
  assert(pre.headers.get('access-control-allow-headers')?.includes('apikey'))
  assert(pre.headers.get('access-control-allow-headers')?.includes('x-client-info'))
  equal(pre.headers.get('access-control-allow-origin'), ORIGEM_SITE)

  const semLogin = checkoutDe(mem, {
    baseUrl: () => { throw new Error('base') },
    criarAsaas: () => { throw new Error('cliente') },
    db: async () => { throw new Error('db') },
  })
  const cru = new Request('http://local/asaas-checkout', { method: 'POST', headers: { 'content-length': '900000' }, body: 'nunca' })
  cru.body!.getReader = () => { throw new Error('corpo lido') }
  const negado = await ler(await semLogin.handler(cru))
  equal(negado.status, 401)
  equal(negado.body?.code, 'sem_login')
  equal(negado.headers.get('access-control-allow-origin'), null)

  const baseRuim = checkoutDe(mem, { baseUrl: () => 'https://api.asaas.com', criarAsaas: () => { throw new Error('cliente') } })
  const reqBase = pedido('http://local/asaas-checkout', PEDIDO)
  reqBase.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await ler(await baseRuim.handler(reqBase))).body?.code, 'configuracao_ausente')

  const f = checkoutDe(mem)
  equal((await ler(await f.handler(pedido('http://local/asaas-checkout', { ...PEDIDO, plano: 'avancado' })))).body?.code, 'plano_invalido')
  equal((await ler(await f.handler(pedido('http://local/asaas-checkout', { ...PEDIDO, cpfCnpj: '52998224726' })))).body?.code, 'cpf_invalido')
  equal((await ler(await f.handler(pedido('http://local/asaas-checkout', { ...PEDIDO, nome: 'A' })))).body?.code, 'pedido_invalido')
  equal(f.chamadas.length, 0)
  equal(mem.tocadas.length, 0)
  const grande = pedido('http://local/asaas-checkout', PEDIDO)
  grande.headers.set('content-length', '70000')
  equal((await f.handler(grande)).status, 413)

  await mem.db.prepararCheckout('sandbox', USER, 'basico')
  equal((await ler(await f.handler(pedido('http://local/asaas-checkout', PEDIDO)))).body?.code, 'checkout_em_andamento')
  mem.linhas[0].status = 'ativa'
  mem.linhas[0].subscriptionId = 'sub_aberta'
  equal((await ler(await f.handler(pedido('http://local/asaas-checkout', PEDIDO)))).body?.code, 'assinatura_ativa')
  mem.linhas[0].status = 'cancelada'
  const historico = await ler(await f.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(historico.status, 409)
  equal(historico.body?.code, 'trial_ja_usado')
  equal(f.chamadas.length, 0)
  tabelasOk(mem)
})

Deno.test('checkout reusa sessão recente, descarta tentativa falha e não vaza o corpo do Asaas', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  const f = checkoutDe(mem)
  equal((await f.handler(pedido('http://local/asaas-checkout', { ...PEDIDO, cpfCnpj: '11.444.777/0001-61', plano: 'plus' }))).status, 200)
  equal(JSON.parse(f.chamadas.find((c) => c.url.endsWith('/v3/customers'))?.body || '{}').cpfCnpj, '11444777000161')
  const posts = () => f.chamadas.filter((c) => c.url.endsWith('/v3/checkouts')).length
  equal(posts(), 1)
  const segunda = await ler(await f.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(segunda.body?.url, 'https://sandbox.asaas.com/checkoutSession/show?id=chk_teste123')
  equal(posts(), 1)

  mem.linhas[0].atualizadoEm = '2020-01-01T00:00:00.000Z'
  const antigoId = mem.linhas[0].id
  equal((await f.handler(pedido('http://local/asaas-checkout', PEDIDO))).status, 200)
  equal(posts(), 2)
  equal(mem.linhas.length, 2)
  equal(mem.linhas.some((linha) => linha.id === antigoId && linha.checkoutId === 'chk_teste123'), true)

  const quebrado = criarMemoriaAsaas(RELOGIO)
  let vistos = 0
  const g = checkoutDe(quebrado, {
    rotas(chamada: Chamada) {
      if (chamada.url.endsWith('/v3/customers')) return Response.json({ id: 'cus_teste123' })
      vistos += 1
      equal(quebrado.linhas[0]?.reserva, 'enviando')
      assert(!!quebrado.linhas[0]?.envioEm)
      equal(JSON.parse(chamada.body || '{}').externalReference, quebrado.linhas[0]?.id)
      return new Response(JSON.stringify({ errors: [{ description: 'CORPO_REMOTO_NAO_VAZAR ' + CPF }] }), { status: 400 })
    },
  })
  const falha = await ler(await g.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(falha.status, 502)
  equal(falha.body?.code, 'provedor')
  equal(vistos, 1)
  equal(quebrado.linhas.length, 0)
  equal(await quebrado.db.obterCliente('sandbox', USER), 'cus_teste123')
  semSegredo(g.logs, falha.text)
  const semUrl = checkoutDe(criarMemoriaAsaas(RELOGIO), { dbErro: erroCodigo('SEM_URL') })
  equal((await ler(await semUrl.handler(pedido('http://local/asaas-checkout', PEDIDO)))).status, 503)
  const rede = checkoutDe(criarMemoriaAsaas(RELOGIO), { dbErro: erroCodigo('XX000') })
  const redeRes = await ler(await rede.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(redeRes.status, 502)
  semSegredo(rede.logs, redeRes.text)
})

function cancelDe(mem: MemoriaAsaas, opts: Record<string, unknown> = {}) {
  const fake = cliente((opts.rotas as typeof rotasOk) || rotasOk)
  const logs: Record<string, string>[] = []
  let criou = 0
  const handler = createAsaasCancelHandler({
    authenticate: (opts.authenticate as (h: string | null) => Promise<string | null>) || (async (header) => header ? USER : null),
    db: (opts.db as (() => Promise<MemoriaAsaas['db']>) | undefined) || (async () => { if (opts.dbErro) throw opts.dbErro; return mem.db }),
    baseUrl: (opts.baseUrl as () => string) || (() => ASAAS_SANDBOX_BASE),
    criarAsaas: (opts.criarAsaas as () => AsaasClient | null) || (() => { criou += 1; return fake.client }),
    log: (entrada) => logs.push(entrada),
  })
  return { handler, logs, chamadas: fake.chamadas, criou: () => criou }
}
async function semear(mem: MemoriaAsaas, user: string, patch: Record<string, unknown>) {
  const prep = await mem.db.prepararCheckout('sandbox', user, 'basico')
  const linha = mem.linhas.find((item) => item.id === prep.assinaturaId)
  if (!linha) throw new Error('sem linha')
  Object.assign(linha, patch)
  return linha
}

Deno.test('cancelamento: sem JWT 401, sem assinatura 404, só a própria e idempotente', async () => {
  const vazio = criarMemoriaAsaas(RELOGIO)
  const bloqueado = cancelDe(vazio, {
    baseUrl: () => { throw new Error('base') },
    criarAsaas: () => { throw new Error('cliente') },
    db: async () => { throw new Error('db') },
  })
  const cru = new Request('http://local/asaas-cancel', { method: 'POST', body: '{"subscription_id":"sub_alheio_NAO_LOGAR"}' })
  cru.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await ler(await bloqueado.handler(cru))).status, 401)
  equal((await bloqueado.handler(pedido('http://local/asaas-cancel', {}, { origin: 'https://evil.example' }))).status, 403)
  const base = cancelDe(vazio, { baseUrl: () => 'https://api.asaas.com', criarAsaas: () => { throw new Error('cliente') } })
  const reqBase = pedido('http://local/asaas-cancel', { subscription_id: 'sub_alheio_NAO_LOGAR' })
  reqBase.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await base.handler(reqBase)).status, 503)

  const mem = criarMemoriaAsaas(RELOGIO)
  const f = cancelDe(mem, { criarAsaas: () => { throw new Error('cliente no GET') } })
  const livre = await ler(await f.handler(pedido('http://local/asaas-cancel', undefined, {}, 'GET')))
  equal(livre.body?.plano, 'free')
  equal(livre.body?.pode_cancelar, false)
  const nenhum = cancelDe(mem)
  equal((await ler(await nenhum.handler(pedido('http://local/asaas-cancel', { subscription_id: 'sub_alheio_NAO_LOGAR' })))).status, 404)

  await semear(mem, OTHER, { status: 'ativa', subscriptionId: 'sub_alheio_NAO_LOGAR', pagoAte: '2027-01-01' })
  await semear(mem, USER, { status: 'ativa', subscriptionId: 'sub_do_usuario', pagoAte: '2027-03-18', trialAte: '2026-11-25' })
  const g = cancelDe(mem)
  const visto = await ler(await g.handler(pedido('http://local/asaas-cancel', undefined, {}, 'GET')))
  equal(visto.body?.status, 'ativa')
  equal(visto.body?.acesso_ate, '2027-03-18')
  equal(g.criou(), 0)
  const feito = await ler(await g.handler(pedido('http://local/asaas-cancel', { subscription_id: 'sub_alheio_NAO_LOGAR', user_id: OTHER })))
  equal(feito.status, 200)
  equal(feito.body, { status: 'cancelamento_solicitado', ja: false, acesso_ate: '2027-03-18' })
  equal(g.chamadas.map((c) => c.url), [ASAAS_SANDBOX_BASE + '/v3/subscriptions/sub_do_usuario'])
  const deNovo = await ler(await g.handler(pedido('http://local/asaas-cancel', { subscription_id: 'sub_alheio_NAO_LOGAR' })))
  equal(deNovo.body?.ja, true)
  equal(g.chamadas.length, 1)
  const depois = await ler(await g.handler(pedido('http://local/asaas-cancel', undefined, {}, 'GET')))
  equal(depois.body?.pode_cancelar, false)
  equal(depois.body?.pode_tentar_de_novo, false)
  semSegredo(g.logs, feito.text + deNovo.text)
  tabelasOk(mem)

  const sumida = criarMemoriaAsaas(RELOGIO)
  await semear(sumida, USER, { status: 'ativa', subscriptionId: 'sub_do_usuario', pagoAte: '2027-03-18' })
  const h = cancelDe(sumida, { rotas: () => new Response('{}', { status: 404 }) })
  equal((await h.handler(pedido('http://local/asaas-cancel', {}))).status, 200)
  equal(sumida.linhas[0].status, 'cancelamento_solicitado')

  const instavel = criarMemoriaAsaas(RELOGIO)
  await semear(instavel, USER, { status: 'ativa', subscriptionId: 'sub_do_usuario', pagoAte: '2027-03-18' })
  let deletesInstavel = 0
  const i = cancelDe(instavel, {
    rotas: (chamada: Chamada) => {
      if (chamada.method === 'GET') return Response.json({ id: 'sub_do_usuario', deleted: false, status: 'ACTIVE' })
      deletesInstavel += 1
      if (deletesInstavel === 1) return new Response(JSON.stringify({ errors: [{ description: 'CORPO_REMOTO_NAO_VAZAR' }] }), { status: 500 })
      return Response.json({ deleted: true, id: 'sub_do_usuario' })
    },
  })
  const falha = await ler(await i.handler(pedido('http://local/asaas-cancel', {})))
  equal(falha.status, 502)
  equal(falha.body?.code, 'provedor')
  equal(instavel.linhas[0].status, 'cancelamento_solicitado')
  equal(instavel.linhas[0].recorrencia, 'cancelamento_pendente')
  equal(instavel.cancelamentos[0].estado, 'falhou')
  equal(deletesInstavel, 1)
  const retry = await ler(await i.handler(pedido('http://local/asaas-cancel', undefined, {}, 'GET')))
  equal(retry.body?.pode_cancelar, true)
  equal(retry.body?.pode_tentar_de_novo, true)
  const refeito = await ler(await i.handler(pedido('http://local/asaas-cancel', {})))
  equal(refeito.status, 200)
  equal(refeito.body?.ja, false)
  equal(instavel.cancelamentos[0].estado, 'concluido')
  equal(deletesInstavel, 2)
  const terceiro = await ler(await i.handler(pedido('http://local/asaas-cancel', {})))
  equal(terceiro.body?.ja, true)
  equal(deletesInstavel, 2)
  semSegredo(i.logs, falha.text + refeito.text)

  const morta = criarMemoriaAsaas(RELOGIO)
  await semear(morta, USER, { status: 'cancelada', subscriptionId: 'sub_do_usuario', pagoAte: '2027-03-18' })
  const j = cancelDe(morta, { criarAsaas: () => { throw new Error('cliente') } })
  const ja = await ler(await j.handler(pedido('http://local/asaas-cancel', {})))
  equal(ja.body?.ja, true)
  equal(ja.body?.status, 'cancelada')
  equal((await ler(await cancelDe(morta, { dbErro: erroCodigo('42P01') }).handler(pedido('http://local/asaas-cancel', {})))).status, 503)
})

function whDe(mem: MemoriaAsaas, opts: Record<string, unknown> = {}) {
  const logs: Record<string, string>[] = []
  let dbCalls = 0
  const deps = {
    token: (opts.token as () => string | undefined) || (() => TOKEN),
    baseUrl: (opts.baseUrl as () => string | undefined) || (() => ASAAS_SANDBOX_BASE),
    db: async () => { dbCalls += 1; if (opts.dbErro) throw opts.dbErro; return mem.db },
    log: (entrada: Record<string, string>) => logs.push(entrada),
    now: RELOGIO,
  }
  const handler = opts.prod ? createAsaasWebhookHandler(deps) : createSandboxWebhookHandler(deps)
  return { handler, logs, dbCalls: () => dbCalls }
}
function evento(id: string, event: string, extra: Record<string, unknown> = {}, quando = '2026-11-18 12:00:00') {
  return { id, event, dateCreated: quando, cpfCnpj: CPF, email: 'pessoa@example.com', creditCard: { number: 'cartao_teste' }, ...extra }
}
function postWh(handler: (req: Request) => Promise<Response>, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = {}
  if (token !== null) headers['asaas-access-token'] = token
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return handler(new Request('http://local/webhook', { method: 'POST', headers, body: raw }))
}

Deno.test('webhook valida o token antes do corpo e do banco', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  let tokens = 0
  const cedo = whDe(mem, {
    token: () => { tokens += 1; return TOKEN },
    baseUrl: () => { throw new Error('base') },
    db: async () => { throw new Error('db') },
  })
  equal((await cedo.handler(new Request('http://local/webhook', { method: 'GET' }))).status, 405)
  equal(tokens, 0)
  const cru = new Request('http://local/webhook', { method: 'POST', headers: { 'content-length': '900000' }, body: 'nunca' })
  cru.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await cedo.handler(cru)).status, 401)
  const errado = new Request('http://local/webhook', { method: 'POST', headers: { 'asaas-access-token': 'b'.repeat(40) }, body: 'nunca' })
  errado.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await cedo.handler(errado)).status, 401)
  equal(cedo.dbCalls(), 0)

  const curto = whDe(mem, { token: () => 'a'.repeat(31), db: async () => { throw new Error('db') } })
  const corpoCurto = new Request('http://local/webhook', { method: 'POST', headers: { 'asaas-access-token': 'a'.repeat(31) }, body: 'nunca' })
  corpoCurto.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await curto.handler(corpoCurto)).status, 503)
  const longo = whDe(mem, { token: () => 'a'.repeat(257) })
  const corpoLongo = new Request('http://local/webhook', { method: 'POST', body: 'nunca' })
  corpoLongo.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await longo.handler(corpoLongo)).status, 503)
  const headerLongo = new Request('http://local/webhook', { method: 'POST', headers: { 'asaas-access-token': 'h'.repeat(257) }, body: 'nunca' })
  headerLongo.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await whDe(mem).handler(headerLongo)).status, 401)

  const base = whDe(mem, { baseUrl: () => 'https://api.asaas.com', db: async () => { throw new Error('db') } })
  const corpoBase = new Request('http://local/webhook', { method: 'POST', headers: { 'asaas-access-token': TOKEN }, body: 'nunca' })
  corpoBase.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await base.handler(corpoBase)).status, 503)

  const prod = whDe(mem, { prod: true, baseUrl: () => { throw new Error('base') }, db: async () => { throw new Error('db') } })
  const corpoProd = new Request('http://local/webhook', { method: 'POST', headers: { 'asaas-access-token': TOKEN }, body: 'nunca' })
  corpoProd.body!.getReader = () => { throw new Error('corpo lido') }
  const prodRes = await ler(await prod.handler(corpoProd))
  equal(prodRes.status, 503)
  equal(prodRes.body?.code, 'configuracao_ausente')
  equal(prod.dbCalls(), 0)
  const prodErrado = new Request('http://local/webhook', { method: 'POST', body: 'nunca' })
  prodErrado.body!.getReader = () => { throw new Error('corpo lido') }
  equal((await prod.handler(prodErrado)).status, 401)
})

Deno.test('webhook: JSON, tamanho, duplicado, mapas, divergente, customer e só log', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  const f = whDe(mem)
  equal((await postWh(f.handler, '{')).status, 400)
  const grande = new Request('http://local/webhook', {
    method: 'POST',
    headers: { 'asaas-access-token': TOKEN, 'content-length': '70000' },
    body: JSON.stringify(evento('evt_grande', 'PING')),
  })
  equal((await f.handler(grande)).status, 413)
  equal((await postWh(f.handler, 'x'.repeat(65537))).status, 413)
  equal(f.dbCalls(), 0)

  await mem.db.gravarCliente('sandbox', USER, 'cus_user1')
  await mem.db.prepararCheckout('sandbox', USER, 'basico', '2026-11-25')
  await mem.db.vincularCheckout('sandbox', USER, mem.linhas[0].id, 'chk_user1')
  const created = await ler(await postWh(f.handler, evento('evt_05b708f961d739ea7eba7e4db318f621&36818395', 'SUBSCRIPTION_CREATED', {
    subscription: { id: 'sub_user1', customer: 'cus_user1', nextDueDate: '2026-11-25', value: 9.9, externalReference: mem.linhas[0].id },
  }, '2026-11-18 10:00:00')))
  equal(created.status, 200)
  equal(mem.linhas[0].status, 'trial')
  equal(mem.linhas[0].trialAte, '2026-11-25')
  const dup = await ler(await postWh(f.handler, evento('evt_05b708f961d739ea7eba7e4db318f621&36818395', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_dup', customer: 'cus_user1', subscription: 'sub_user1', value: 9.9, dueDate: '2026-12-18' },
  })))
  equal(dup.status, 200)
  equal(mem.transicoes, 1)
  equal(mem.qtdEventos, 1)
  equal(mem.linhas[0].status, 'trial')

  const pago = await postWh(f.handler, evento('evt_pago', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_1', customer: 'cus_user1', subscription: 'sub_user1', value: '9.90', dueDate: '2026-12-18' },
  }, '2026-11-18 12:00:00'))
  equal((await ler(pago)).status, 200)
  equal(mem.linhas[0].status, 'ativa')
  equal(mem.linhas[0].pagoAte, somarMesIso('2026-12-18'))
  await postWh(f.handler, evento('evt_velho', 'PAYMENT_OVERDUE', {
    payment: { id: 'pay_velho', customer: 'cus_user1', subscription: 'sub_user1' },
  }, '2026-11-18 09:00:00'))
  equal(mem.linhas[0].status, 'ativa')

  const mapas: Array<[string, string]> = [
    ['PAYMENT_OVERDUE', 'inadimplente'],
    ['PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'inadimplente'],
    ['PAYMENT_REFUNDED', 'suspensa'],
    ['PAYMENT_CHARGEBACK_REQUESTED', 'suspensa'],
    ['SUBSCRIPTION_INACTIVATED', 'cancelada'],
  ]
  let hora = 13
  for (const [tipo, status] of mapas) {
    const fresco = criarMemoriaAsaas(RELOGIO)
    await fresco.db.gravarCliente('sandbox', USER, 'cus_user1')
    await semear(fresco, USER, { status: 'ativa', subscriptionId: 'sub_user1', pagoAte: '2027-01-18', plano: 'basico' })
    const h = whDe(fresco)
    await postWh(h.handler, evento('evt_' + tipo, tipo, {
      payment: { id: 'pay_' + hora, customer: 'cus_user1', subscription: 'sub_user1', value: 9.9, dueDate: '2026-12-18' },
      subscription: { id: 'sub_user1', customer: 'cus_user1' },
    }, `2026-11-18 ${hora}:00:00`))
    equal(fresco.linhas[0].status, status)
    equal(fresco.linhas[0].pagoAte, '2027-01-18')
    hora += 1
  }

  const recebido = criarMemoriaAsaas(RELOGIO)
  await recebido.db.gravarCliente('sandbox', USER, 'cus_user1')
  await semear(recebido, USER, { status: 'trial', subscriptionId: 'sub_user1', trialAte: '2026-11-25' })
  await postWh(whDe(recebido).handler, evento('evt_received', 'PAYMENT_RECEIVED', {
    payment: { id: 'pay_r', customer: 'cus_user1', subscription: 'sub_user1', value: 9.9, dueDate: '2026-12-18' },
  }))
  equal(recebido.linhas[0].status, 'ativa')
  const checkoutPago = criarMemoriaAsaas(RELOGIO)
  await checkoutPago.db.gravarCliente('sandbox', USER, 'cus_user1')
  await semear(checkoutPago, USER, { status: 'checkout', checkoutId: 'chk_user1', nextDuePlanejado: '2026-11-25' })
  await postWh(whDe(checkoutPago).handler, evento('evt_chk', 'CHECKOUT_PAID', {
    checkout: { id: 'chk_user1', customer: 'cus_user1', subscription: 'sub_user1', nextDueDate: '2026-11-25', value: 9.9 },
  }))
  equal(checkoutPago.linhas[0].status, 'trial')
  equal(checkoutPago.linhas[0].subscriptionId, 'sub_user1')

  const div = criarMemoriaAsaas(RELOGIO)
  await div.db.gravarCliente('sandbox', USER, 'cus_user1')
  await semear(div, USER, { status: 'ativa', subscriptionId: 'sub_user1', plano: 'plus', pagoAte: '2027-01-18' })
  const hd = whDe(div)
  await postWh(hd.handler, evento('evt_div', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_div', customer: 'cus_user1', subscription: 'sub_user1', value: 9.9, dueDate: '2026-12-18' },
  }, '2026-11-18 15:00:00'))
  equal(div.linhas[0].status, 'divergente')
  await postWh(hd.handler, evento('evt_div_velho', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_div0', customer: 'cus_user1', subscription: 'sub_user1', value: 29.9, dueDate: '2026-12-18' },
  }, '2026-11-18 10:00:00'))
  equal(div.linhas[0].status, 'divergente')
  await postWh(hd.handler, evento('evt_div_ok', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_div2', customer: 'cus_user1', subscription: 'sub_user1', value: 29.9, dueDate: '2026-12-18' },
  }, '2026-11-18 18:00:00'))
  equal(div.linhas[0].status, 'ativa')
  await postWh(hd.handler, evento('evt_div_null', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_div3', customer: 'cus_user1', subscription: 'sub_user1', dueDate: '2026-12-18' },
  }, '2026-11-18 19:00:00'))
  equal(div.linhas[0].status, 'divergente')

  const fim = criarMemoriaAsaas(RELOGIO)
  await fim.db.gravarCliente('sandbox', USER, 'cus_user1')
  await semear(fim, USER, { status: 'ativa', subscriptionId: 'sub_user1', pagoAte: '2027-01-18' })
  const hf = whDe(fim)
  await postWh(hf.handler, evento('evt_del', 'SUBSCRIPTION_DELETED', { subscription: { id: 'sub_user1', customer: 'cus_user1' } }, '2026-11-18 16:00:00'))
  await postWh(hf.handler, evento('evt_depois', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_depois', customer: 'cus_user1', subscription: 'sub_user1', value: 9.9, dueDate: '2027-03-18' },
  }, '2026-11-19 16:00:00'))
  equal(fim.linhas[0].status, 'cancelada')
  equal(fim.linhas[0].pagoAte, '2027-01-18')

  const estranho = criarMemoriaAsaas(RELOGIO)
  const he = whDe(estranho)
  const desconhecido = await ler(await postWh(he.handler, evento('evt_quem', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_quem', customer: 'cus_ninguem', subscription: 'sub_ninguem', value: 9.9, dueDate: '2026-12-18' },
  })))
  equal(desconhecido.status, 200)
  equal(estranho.linhas.length, 0)
  equal(estranho.qtdEventos, 1)
  await postWh(he.handler, evento('evt_tipo', 'PAYMENT_CREATED', { subscription: { id: 'sub_tipo' } }))
  equal(estranho.linhas.length, 0)
  semSegredo(he.logs, desconhecido.text)
  tabelasOk(estranho)

  for (const code of ['SEM_URL', '42883', '42P01']) {
    const m = criarMemoriaAsaas(RELOGIO)
    const h = whDe(m, { dbErro: erroCodigo(code, 'NAO_VAZAR_INTERNO') })
    const res = await ler(await postWh(h.handler, evento('evt_log_' + code, 'SUBSCRIPTION_CREATED')))
    equal(res.status, 200)
    equal(res.body, { ok: true })
    equal(h.logs, [{ fn: 'sandbox_asaas_webhook', modo: 'so_log', evento: 'SUBSCRIPTION_CREATED', event_id: 'evt_log_' + code, recurso_id: '', subscription_id: '' }])
    semSegredo(h.logs, res.text)
  }
  const interno = whDe(criarMemoriaAsaas(RELOGIO), { dbErro: erroCodigo('XX000') })
  const resInterno = await ler(await postWh(interno.handler, evento('evt_xx', 'SUBSCRIPTION_CREATED', { subscription: { id: 'sub_user1' } })))
  equal(resInterno.status, 502)
  semSegredo(interno.logs, resInterno.text)
  assert(!resInterno.text.includes('so_log'))
})

Deno.test('checkout incerto não apaga a reserva e a janela de 60 min bloqueia outro POST', async () => {
  async function incerto(responder: (chamada: Chamada) => Response | Promise<Response>) {
    const mem = criarMemoriaAsaas(RELOGIO)
    let posts = 0
    const f = checkoutDe(mem, {
      rotas(chamada: Chamada) {
        if (chamada.url.endsWith('/v3/checkouts')) posts += 1
        return responder(chamada)
      },
    })
    const falha = await ler(await f.handler(pedido('http://local/asaas-checkout', PEDIDO)))
    equal(falha.status, 502)
    equal(mem.linhas.length, 1)
    equal(mem.linhas[0].resultadoIncerto, true)
    equal(mem.linhas[0].checkoutId, null)
    const segunda = await ler(await f.handler(pedido('http://local/asaas-checkout', PEDIDO)))
    equal(segunda.status, 409)
    equal(segunda.body?.code, 'checkout_em_andamento')
    equal(posts, 1)
    semSegredo(f.logs, falha.text + segunda.text)
    tabelasOk(mem)
    return mem
  }
  await incerto((chamada) => {
    if (chamada.url.endsWith('/v3/customers')) return Response.json({ id: 'cus_teste123' })
    const erro = new Error('abortado')
    erro.name = 'AbortError'
    return Promise.reject(erro)
  })
  await incerto((chamada) => {
    if (chamada.url.endsWith('/v3/customers')) return Response.json({ id: 'cus_teste123' })
    return new Response('falhou', { status: 500 })
  })
  await incerto((chamada) => {
    if (chamada.url.endsWith('/v3/customers')) return Response.json({ id: 'cus_teste123' })
    return new Response('nao-json', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  await incerto((chamada) => {
    if (chamada.url.endsWith('/v3/customers')) return Response.json({ id: 'cus_teste123' })
    return new Response('ocupado', { status: 429 })
  })

  const vinculado = criarMemoriaAsaas(RELOGIO)
  const g = checkoutDe(vinculado, {
    db: async () => ({
      ...vinculado.db,
      vincularCheckout: async () => { throw new Error('NAO_VAZAR_INTERNO') },
    }),
  })
  const liga = await ler(await g.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(liga.status, 502)
  equal(liga.body?.code, 'rede')
  assert(!liga.text.includes('NAO_VAZAR_INTERNO'))
  equal(vinculado.linhas.length, 1)
  equal(vinculado.linhas[0].resultadoIncerto, true)
  equal(vinculado.linhas[0].checkoutId, null)
  const deNovo = await ler(await g.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(deNovo.body?.code, 'checkout_em_andamento')
  equal(g.chamadas.filter((c) => c.url.endsWith('/v3/checkouts')).length, 1)

  const mudo = criarMemoriaAsaas(RELOGIO)
  const h = checkoutDe(mudo, {
    db: async () => ({
      ...mudo.db,
      marcarCheckoutIncerto: async () => { throw new Error('marca') },
    }),
    rotas(chamada: Chamada) {
      if (chamada.url.endsWith('/v3/customers')) return Response.json({ id: 'cus_teste123' })
      return new Response('falhou', { status: 500 })
    },
  })
  equal((await ler(await h.handler(pedido('http://local/asaas-checkout', PEDIDO)))).status, 502)
  equal(mudo.linhas.length, 1)
  equal(mudo.linhas[0].resultadoIncerto, false)
  equal((await ler(await h.handler(pedido('http://local/asaas-checkout', PEDIDO)))).body?.code, 'checkout_em_andamento')

  const janela = criarMemoriaAsaas(RELOGIO)
  await janela.db.prepararCheckout('sandbox', USER, 'basico', '2026-11-25')
  janela.linhas[0].atualizadoEm = '2026-11-18T14:57:00.000Z'
  const i = checkoutDe(janela)
  equal((await ler(await i.handler(pedido('http://local/asaas-checkout', PEDIDO)))).body?.code, 'checkout_em_andamento')
  equal(i.chamadas.length, 0)
  janela.linhas[0].atualizadoEm = '2026-11-18T13:59:00.000Z'
  equal((await ler(await i.handler(pedido('http://local/asaas-checkout', PEDIDO)))).status, 200)
  equal(janela.linhas.length, 1)
  equal(janela.linhas[0].plano, 'basico')

  const nulo = await ler(await checkoutDe(criarMemoriaAsaas(RELOGIO)).handler(pedido('http://local/asaas-checkout', null)))
  equal(nulo.status, 400)
  equal(nulo.body?.code, 'pedido_invalido')
})

Deno.test('erro de RPC no checkout vira 503 ou 502 sem vazar a mensagem', async () => {
  for (const code of ['42883', '42P01', 'SEM_URL']) {
    const mem = criarMemoriaAsaas(RELOGIO)
    const f = checkoutDe(mem, {
      db: async () => ({
        ...mem.db,
        prepararCheckout: async () => { throw erroCodigo(code, 'NAO_VAZAR_INTERNO') },
      }),
    })
    const res = await ler(await f.handler(pedido('http://local/asaas-checkout', PEDIDO)))
    equal(res.status, 503)
    equal(res.body?.code, 'configuracao_ausente')
    assert(!res.text.includes('NAO_VAZAR_INTERNO'))
    equal(mem.linhas.length, 0)
  }
  const mem = criarMemoriaAsaas(RELOGIO)
  const f = checkoutDe(mem, {
    db: async () => ({
      ...mem.db,
      prepararCheckout: async () => { throw erroCodigo('XX000', 'NAO_VAZAR_INTERNO') },
    }),
  })
  const res = await ler(await f.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(res.status, 502)
  equal(res.body?.code, 'rede')
  assert(!res.text.includes('NAO_VAZAR_INTERNO'))
  assert(!res.text.includes('XX000'))
})

Deno.test('cancelamento concorrente reserva antes do DELETE e o segundo não repete', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  await semear(mem, USER, { status: 'ativa', subscriptionId: 'sub_do_usuario', pagoAte: '2027-03-18' })
  let chegou!: () => void
  const gate = new Promise<void>((resolve) => { chegou = resolve })
  let seguir!: () => void
  const espera = new Promise<void>((resolve) => { seguir = resolve })
  let deletes = 0
  const h = cancelDe(mem, {
    rotas: async (chamada: Chamada) => {
      if (chamada.method === 'DELETE') {
        deletes += 1
        chegou()
        await espera
        return Response.json({ deleted: true, id: 'sub_do_usuario' })
      }
      return rotasOk(chamada)
    },
  })
  const primeiro = h.handler(pedido('http://local/asaas-cancel', {}))
  await gate
  equal(mem.linhas[0].status, 'cancelamento_solicitado')
  await mem.db.aplicarEvento({
    ambiente: 'sandbox', eventId: 'evt_meio_ref', tipo: 'PAYMENT_REFUNDED', recursoId: 'pay_meio',
    subscriptionId: 'sub_do_usuario', customerId: null, checkoutId: null, externalReference: null,
    valor: 9.9, vencimento: null, nextDue: null, quando: '2026-11-18T16:00:00.000Z',
  })
  equal(mem.linhas[0].bloqueio, 'suspensa')
  equal(mem.linhas[0].status, 'suspensa')
  const durante = await ler(await h.handler(pedido('http://local/asaas-cancel', undefined, {}, 'GET')))
  equal(durante.body?.pode_cancelar, false)
  equal(durante.body?.pode_tentar_de_novo, false)
  const segundo = await ler(await h.handler(pedido('http://local/asaas-cancel', {})))
  equal(segundo.status, 409)
  equal(segundo.body?.code, 'cancelamento_em_andamento')
  equal(segundo.body?.ja, undefined)
  equal(deletes, 1)
  equal(mem.cancelamentos[0].tentativas, 1)
  seguir()
  const feito = await ler(await primeiro)
  equal(feito.status, 200)
  equal(feito.body?.ja, false)
  equal(feito.body?.status, 'suspensa')
  equal(deletes, 1)
  equal(mem.linhas[0].bloqueio, 'suspensa')
  equal(mem.linhas[0].recorrencia, 'cancelamento_pendente')
  equal(mem.linhas[0].pagoAte, '2027-03-18')
  const depois = await ler(await h.handler(pedido('http://local/asaas-cancel', {})))
  equal(depois.body?.ja, true)
  equal(deletes, 1)
  const visto = await ler(await h.handler(pedido('http://local/asaas-cancel', undefined, {}, 'GET')))
  equal(visto.body?.plano, 'free')
  equal(visto.body?.status, 'suspensa')
  tabelasOk(mem)
})

Deno.test('erro de RPC no cancelamento vira 503 sem vazar a mensagem', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  const get = cancelDe(mem, {
    db: async () => ({
      ...mem.db,
      lerStatus: async () => { throw erroCodigo('SEM_URL', 'NAO_VAZAR_INTERNO') },
    }),
  })
  const lido = await ler(await get.handler(pedido('http://local/asaas-cancel', undefined, {}, 'GET')))
  equal(lido.status, 503)
  equal(lido.body?.code, 'configuracao_ausente')
  assert(!lido.text.includes('NAO_VAZAR_INTERNO'))
  const post = cancelDe(mem, {
    db: async () => ({
      ...mem.db,
      pedirCancelamento: async () => { throw erroCodigo('42P01', 'NAO_VAZAR_INTERNO') },
    }),
  })
  const pedidoCancel = await ler(await post.handler(pedido('http://local/asaas-cancel', {})))
  equal(pedidoCancel.status, 503)
  equal(pedidoCancel.body?.code, 'configuracao_ausente')
  assert(!pedidoCancel.text.includes('NAO_VAZAR_INTERNO'))
  const outro = cancelDe(mem, {
    db: async () => ({
      ...mem.db,
      pedirCancelamento: async () => { throw erroCodigo('XX000', 'NAO_VAZAR_INTERNO') },
    }),
  })
  const rede = await ler(await outro.handler(pedido('http://local/asaas-cancel', {})))
  equal(rede.status, 502)
  equal(rede.body?.code, 'rede')
  assert(!rede.text.includes('NAO_VAZAR_INTERNO'))
  assert(!rede.text.includes('XX000'))
})

Deno.test('checkout expirado reconcilia no Asaas e o webhook atrasado ainda vincula', async () => {
  async function reservaVelha() {
    const mem = criarMemoriaAsaas(RELOGIO)
    const prep = await mem.db.prepararCheckout('sandbox', USER, 'basico', '2026-11-25')
    await mem.db.vincularCheckout('sandbox', USER, prep.assinaturaId!, 'chk_velho')
    await mem.db.gravarCliente('sandbox', USER, 'cus_teste123')
    mem.linhas[0].atualizadoEm = '2026-11-18T13:59:00.000Z'
    return { mem, id: prep.assinaturaId! }
  }
  const remota = await reservaVelha()
  const a = checkoutDe(remota.mem, {
    rotas(chamada: Chamada) {
      if (chamada.url.includes('/v3/subscriptions?customer=')) {
        return Response.json({
          hasMore: false,
          data: [{ id: 'sub_remota1', deleted: false, status: 'ACTIVE', externalReference: remota.id }],
        })
      }
      return rotasOk(chamada)
    },
  })
  const bloqueou = await ler(await a.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(bloqueou.status, 409)
  equal(bloqueou.body?.code, 'assinatura_ativa')
  equal(a.chamadas.filter((c) => c.url.endsWith('/v3/checkouts')).length, 0)
  equal(remota.mem.linhas.length, 1)
  equal(remota.mem.linhas[0].id, remota.id)
  equal(remota.mem.linhas[0].checkoutId, 'chk_velho')
  equal(remota.mem.linhas[0].subscriptionId, 'sub_remota1')
  equal(remota.mem.linhas[0].pagoAte, null)
  equal(remota.mem.linhas[0].trialAte, null)
  tabelasOk(remota.mem)

  const vazia = await reservaVelha()
  const b = checkoutDe(vazia.mem, {
    rotas(chamada: Chamada) {
      if (chamada.url.includes('/v3/subscriptions?customer=')) return Response.json({ hasMore: false, data: [] })
      return rotasOk(chamada)
    },
  })
  const liberou = await ler(await b.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(liberou.status, 200)
  equal(vazia.mem.linhas.length, 2)
  equal(vazia.mem.linhas.filter((linha) => linha.checkoutId === 'chk_velho').length, 1)
  equal(b.chamadas.filter((c) => c.url.endsWith('/v3/checkouts')).length, 1)
  tabelasOk(vazia.mem)

  const falha = await reservaVelha()
  const c = checkoutDe(falha.mem, {
    rotas(chamada: Chamada) {
      if (chamada.url.includes('/v3/subscriptions?customer=')) return new Response('falhou', { status: 500 })
      return rotasOk(chamada)
    },
  })
  const recusou = await ler(await c.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(recusou.status, 503)
  equal(recusou.body?.code, 'checkout_em_andamento')
  equal(falha.mem.linhas.length, 1)
  equal(falha.mem.linhas[0].reserva, 'expirada')
  equal(c.chamadas.filter((item) => item.url.endsWith('/v3/checkouts')).length, 0)

  const mais = await reservaVelha()
  const d = checkoutDe(mais.mem, {
    rotas(chamada: Chamada) {
      if (chamada.url.includes('/v3/subscriptions?customer=')) return Response.json({ hasMore: true, data: [] })
      return rotasOk(chamada)
    },
  })
  equal((await ler(await d.handler(pedido('http://local/asaas-checkout', PEDIDO)))).status, 503)
  equal(mais.mem.linhas.length, 1)

  const tarde = await reservaVelha()
  const prep = await tarde.mem.db.prepararCheckout('sandbox', USER, 'basico', '2026-11-25')
  equal(prep.code, 'reconciliar')
  equal(tarde.mem.linhas[0].reserva, 'expirada')
  const aplicado = await tarde.mem.db.aplicarEvento({
    ambiente: 'sandbox', eventId: 'evt_tarde', tipo: 'SUBSCRIPTION_CREATED', recursoId: 'sub_tarde',
    subscriptionId: 'sub_tarde', customerId: 'cus_teste123', checkoutId: 'chk_velho', externalReference: tarde.id,
    valor: 9.9, vencimento: null, nextDue: '2026-11-25', quando: '2026-11-18T16:00:00.000Z',
  })
  equal(aplicado.aplicado, true)
  equal(tarde.mem.linhas[0].status, 'trial')
  equal(tarde.mem.linhas[0].trialAte, '2026-11-25')
  equal(tarde.mem.linhas[0].checkoutId, 'chk_velho')
})

Deno.test('lease vencido refaz o DELETE e o GET deleted conclui sem outro DELETE', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  await semear(mem, USER, { status: 'ativa', subscriptionId: 'sub_do_usuario', pagoAte: '2027-03-18' })
  await mem.db.pedirCancelamento('sandbox', USER)
  mem.cancelamentos[0].leaseAte = '2020-01-01T00:00:00.000Z'
  const vencido = await ler(await cancelDe(mem, { criarAsaas: () => { throw new Error('cliente no GET') } }).handler(pedido('http://local/asaas-cancel', undefined, {}, 'GET')))
  equal(vencido.body?.pode_cancelar, true)
  equal(vencido.body?.pode_tentar_de_novo, true)
  let gets = 0
  let deletes = 0
  const h = cancelDe(mem, {
    rotas(chamada: Chamada) {
      if (chamada.method === 'GET' && chamada.url.includes('/v3/subscriptions/')) {
        gets += 1
        return Response.json({ id: 'sub_do_usuario', deleted: false, status: 'ACTIVE' })
      }
      if (chamada.method === 'DELETE') {
        deletes += 1
        return Response.json({ deleted: true, id: 'sub_do_usuario' })
      }
      return rotasOk(chamada)
    },
  })
  const refeito = await ler(await h.handler(pedido('http://local/asaas-cancel', {})))
  equal(refeito.status, 200)
  equal(refeito.body?.ja, false)
  equal(gets, 1)
  equal(deletes, 1)
  equal(mem.cancelamentos[0].estado, 'concluido')
  equal(mem.cancelamentos[0].tentativas, 2)

  const morto = criarMemoriaAsaas(RELOGIO)
  await semear(morto, USER, { status: 'ativa', subscriptionId: 'sub_do_usuario', pagoAte: '2027-03-18' })
  await morto.db.pedirCancelamento('sandbox', USER)
  morto.cancelamentos[0].leaseAte = '2020-01-01T00:00:00.000Z'
  let deletesMortos = 0
  const i = cancelDe(morto, {
    rotas(chamada: Chamada) {
      if (chamada.method === 'DELETE') deletesMortos += 1
      if (chamada.method === 'GET') return Response.json({ id: 'sub_do_usuario', deleted: true, status: 'INACTIVE' })
      return rotasOk(chamada)
    },
  })
  const concluiu = await ler(await i.handler(pedido('http://local/asaas-cancel', {})))
  equal(concluiu.status, 200)
  equal(deletesMortos, 0)
  equal(morto.cancelamentos[0].estado, 'concluido')
})

Deno.test('webhook não aplica evento de outra assinatura, trial divergente nem encurta pago_ate', async () => {
  const cruzado = criarMemoriaAsaas(RELOGIO)
  await cruzado.db.gravarCliente('sandbox', USER, 'cus_user1')
  await semear(cruzado, USER, { status: 'ativa', subscriptionId: 'sub_atual', pagoAte: '2027-06-01', plano: 'basico' })
  await postWh(whDe(cruzado).handler, evento('evt_outra', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_outra', customer: 'cus_user1', subscription: 'sub_outra', value: 9.9, dueDate: '2026-12-18' },
  }, '2026-11-18 16:00:00'))
  equal(cruzado.linhas.length, 1)
  equal(cruzado.linhas[0].status, 'ativa')
  equal(cruzado.linhas[0].pagoAte, '2027-06-01')
  equal(cruzado.linhas[0].subscriptionId, 'sub_atual')

  const data = criarMemoriaAsaas(RELOGIO)
  await data.db.gravarCliente('sandbox', USER, 'cus_user1')
  await semear(data, USER, { status: 'checkout', checkoutId: 'chk_data', nextDuePlanejado: '2026-11-25', precoCentavos: 990 })
  await postWh(whDe(data).handler, evento('evt_data', 'CHECKOUT_PAID', {
    checkout: { id: 'chk_data', customer: 'cus_user1', subscription: 'sub_data', nextDueDate: '2026-11-27', value: 9.9 },
  }, '2026-11-18 16:00:00'))
  equal(data.linhas[0].status, 'divergente')
  equal(data.linhas[0].trialAte, null)

  const curto = criarMemoriaAsaas(RELOGIO)
  await curto.db.gravarCliente('sandbox', USER, 'cus_user1')
  await semear(curto, USER, { status: 'ativa', subscriptionId: 'sub_curto', pagoAte: '2027-06-01', plano: 'basico' })
  await postWh(whDe(curto).handler, evento('evt_curto', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_curto', customer: 'cus_user1', subscription: 'sub_curto', value: 9.9, dueDate: '2026-12-18' },
  }, '2026-11-18 16:00:00'))
  equal(curto.linhas[0].pagoAte, '2027-06-01')
  equal(curto.linhas[0].status, 'ativa')

  const mantem = criarMemoriaAsaas(RELOGIO)
  await mantem.db.gravarCliente('sandbox', USER, 'cus_user1')
  await semear(mantem, USER, { status: 'ativa', subscriptionId: 'sub_mantem', pagoAte: '2027-03-18', plano: 'basico' })
  await postWh(whDe(mantem).handler, evento('evt_mantem', 'SUBSCRIPTION_DELETED', {
    subscription: { id: 'sub_mantem', customer: 'cus_user1' },
  }, '2026-11-18 16:00:00'))
  equal(mantem.linhas[0].status, 'cancelada')
  equal((await mantem.db.lerStatus('sandbox', USER)).plano, 'basico')
  equal((await mantem.db.lerStatus('sandbox', USER)).status, 'cancelada')
  mantem.linhas[0].pagoAte = '2026-11-17'
  equal((await mantem.db.lerStatus('sandbox', USER)).plano, 'free')
  tabelasOk(cruzado)
  tabelasOk(data)
  tabelasOk(curto)
  tabelasOk(mantem)
})

async function ate(cond: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('nao convergiram')
}

Deno.test('envio interrompido não apaga a reserva e reconcilia antes de outro POST', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  const prep = await mem.db.prepararCheckout('sandbox', USER, 'basico', '2026-11-25')
  const id = prep.assinaturaId!
  await mem.db.marcarCheckoutEnviando('sandbox', USER, id)
  equal(mem.linhas[0].reserva, 'enviando')
  assert(!!mem.linhas[0].envioEm)
  await mem.db.descartarCheckout('sandbox', USER, id)
  equal(mem.linhas.length, 1)
  const cedo = checkoutDe(mem)
  equal((await ler(await cedo.handler(pedido('http://local/asaas-checkout', PEDIDO)))).body?.code, 'checkout_em_andamento')
  equal(cedo.chamadas.filter((c) => c.url.endsWith('/v3/checkouts')).length, 0)

  mem.linhas[0].atualizadoEm = '2026-11-18T13:59:00.000Z'
  const falha = checkoutDe(mem, {
    rotas(chamada: Chamada) {
      if (chamada.url.includes('/v3/subscriptions?')) return new Response('falhou', { status: 500 })
      return rotasOk(chamada)
    },
  })
  const recusou = await ler(await falha.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(recusou.status, 503)
  equal(recusou.body?.code, 'checkout_em_andamento')
  equal(mem.linhas.some((linha) => linha.id === id), true)
  equal(falha.chamadas.filter((c) => c.url.endsWith('/v3/checkouts')).length, 0)
  equal(falha.chamadas.some((c) => c.url.includes('externalReference=')), true)

  const semCliente = criarMemoriaAsaas(RELOGIO)
  const prepSem = await semCliente.db.prepararCheckout('sandbox', USER, 'basico', '2026-11-25')
  const idSem = prepSem.assinaturaId!
  await semCliente.db.marcarCheckoutEnviando('sandbox', USER, idSem)
  semCliente.linhas[0].atualizadoEm = '2026-11-18T13:59:00.000Z'
  const orfa = checkoutDe(semCliente, {
    rotas(chamada: Chamada) {
      if (chamada.url.includes('externalReference=')) {
        return Response.json({
          hasMore: false,
          data: [{ id: 'sub_orfa1', deleted: false, status: 'ACTIVE', externalReference: idSem }],
        })
      }
      return rotasOk(chamada)
    },
  })
  const achou = await ler(await orfa.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(achou.status, 409)
  equal(achou.body?.code, 'assinatura_ativa')
  equal(orfa.chamadas.filter((c) => c.url.endsWith('/v3/checkouts')).length, 0)
  equal(semCliente.linhas[0].id, idSem)
  equal(semCliente.linhas[0].subscriptionId, 'sub_orfa1')
  equal(semCliente.linhas[0].pagoAte, null)

  const consulta = criarMemoriaAsaas(RELOGIO)
  const prepConsulta = await consulta.db.prepararCheckout('sandbox', USER, 'basico', '2026-11-25')
  const idConsulta = prepConsulta.assinaturaId!
  await consulta.db.marcarCheckoutEnviando('sandbox', USER, idConsulta)
  consulta.linhas[0].atualizadoEm = '2026-11-18T13:59:00.000Z'
  const cega = checkoutDe(consulta, {
    rotas(chamada: Chamada) {
      if (chamada.url.includes('/v3/subscriptions?')) return new Response('falhou', { status: 500 })
      return rotasOk(chamada)
    },
  })
  equal((await ler(await cega.handler(pedido('http://local/asaas-checkout', PEDIDO)))).status, 503)
  equal(consulta.linhas.some((linha) => linha.id === idConsulta), true)
  equal(cega.chamadas.filter((c) => c.url.endsWith('/v3/checkouts')).length, 0)

  const livre = checkoutDe(mem)
  const ok = await ler(await livre.handler(pedido('http://local/asaas-checkout', PEDIDO)))
  equal(ok.status, 200)
  equal(mem.linhas.some((linha) => linha.id === id), true)
  equal(mem.linhas.length, 2)
  tabelasOk(mem)
  tabelasOk(semCliente)
  tabelasOk(consulta)
})

Deno.test('reconciliação concorrente não abre dois checkouts', async () => {
  const mem = criarMemoriaAsaas(RELOGIO)
  const prep = await mem.db.prepararCheckout('sandbox', USER, 'basico', '2026-11-25')
  await mem.db.vincularCheckout('sandbox', USER, prep.assinaturaId!, 'chk_velho')
  await mem.db.gravarCliente('sandbox', USER, 'cus_teste123')
  mem.linhas[0].atualizadoEm = '2026-11-18T13:59:00.000Z'
  const fila: Array<() => void> = []
  let posts = 0
  const h = checkoutDe(mem, {
    rotas: async (chamada: Chamada) => {
      if (chamada.url.includes('externalReference=')) return Response.json({ data: [], hasMore: false })
      if (chamada.url.includes('customer=')) {
        await new Promise<void>((resolve) => fila.push(resolve))
        return Response.json({ data: [], hasMore: false })
      }
      if (chamada.url.endsWith('/v3/checkouts')) {
        posts += 1
        return new Response('falhou', { status: 500 })
      }
      return rotasOk(chamada)
    },
  })
  const primeiro = h.handler(pedido('http://local/asaas-checkout', PEDIDO))
  const segundo = h.handler(pedido('http://local/asaas-checkout', PEDIDO))
  await ate(() => fila.length === 2)
  fila[0]()
  const r1 = await ler(await primeiro)
  equal(r1.status, 502)
  equal(posts, 1)
  fila[1]()
  const r2 = await ler(await segundo)
  equal(r2.status, 409)
  equal(r2.body?.code, 'checkout_em_andamento')
  equal(posts, 1)
  equal(mem.linhas.some((linha) => linha.id === prep.assinaturaId), true)
  equal(mem.linhas.some((linha) => linha.reserva === 'incerta'), true)
  tabelasOk(mem)
})

Deno.test('estorno fora de ordem bloqueia mesmo depois de um evento de recorrência mais novo', async () => {
  async function ordem(primeiro: string, segundo: string) {
    const mem = criarMemoriaAsaas(RELOGIO)
    await mem.db.gravarCliente('sandbox', USER, 'cus_user1')
    await semear(mem, USER, { status: 'ativa', subscriptionId: 'sub_ord', pagoAte: '2027-01-18', plano: 'basico' })
    const tipos = [primeiro, segundo]
    const horas = primeiro === 'SUBSCRIPTION_DELETED' ? ['2026-11-18 15:10:00', '2026-11-18 15:09:00'] : ['2026-11-18 15:09:00', '2026-11-18 15:10:00']
    for (let i = 0; i < tipos.length; i++) {
      const tipo = tipos[i]
      const corpo = tipo === 'SUBSCRIPTION_DELETED'
        ? { subscription: { id: 'sub_ord', customer: 'cus_user1' } }
        : { payment: { id: 'pay_ord_' + i, customer: 'cus_user1', subscription: 'sub_ord', value: 9.9 } }
      equal((await ler(await postWh(whDe(mem).handler, evento('evt_ord_' + tipo + i, tipo, corpo, horas[i])))).status, 200)
    }
    equal(mem.linhas[0].bloqueio, 'suspensa')
    equal(mem.linhas[0].recorrencia, 'encerrada')
    equal(mem.linhas[0].ultimoEventoEm, '2026-11-18T18:10:00.000Z')
    equal(mem.linhas[0].pagoAte, '2027-01-18')
    const visto = await mem.db.lerStatus('sandbox', USER)
    equal(visto.plano, 'free')
    equal(visto.status, 'suspensa')
    tabelasOk(mem)
  }
  await ordem('SUBSCRIPTION_DELETED', 'PAYMENT_REFUNDED')
  await ordem('PAYMENT_REFUNDED', 'SUBSCRIPTION_DELETED')
})

Deno.test('lease de 240s segura a tentativa e o token antigo não grava por cima', async () => {
  let agora = new Date('2026-11-18T15:00:00.000Z').getTime()
  const clock = () => new Date(agora)
  const mem = criarMemoriaAsaas(clock)
  await semear(mem, USER, { status: 'ativa', subscriptionId: 'sub_do_usuario', pagoAte: '2027-03-18' })
  let deletes = 0
  let liberar!: () => void
  const espera = new Promise<void>((resolve) => { liberar = resolve })
  let chegou!: () => void
  const gate = new Promise<void>((resolve) => { chegou = resolve })
  const h = cancelDe(mem, {
    rotas: async (chamada: Chamada) => {
      if (chamada.method === 'DELETE') {
        deletes += 1
        chegou()
        await espera
        return Response.json({ deleted: true, id: 'sub_do_usuario' })
      }
      return rotasOk(chamada)
    },
  })
  const primeiro = h.handler(pedido('http://local/asaas-cancel', {}))
  await gate
  agora += 120_000
  const segundo = await ler(await h.handler(pedido('http://local/asaas-cancel', {})))
  equal(segundo.status, 409)
  equal(segundo.body?.code, 'cancelamento_em_andamento')
  equal(deletes, 1)
  liberar()
  equal((await ler(await primeiro)).status, 200)
  equal(deletes, 1)
  equal(mem.cancelamentos[0].estado, 'concluido')

  agora = new Date('2026-11-18T15:00:00.000Z').getTime()
  const troca = criarMemoriaAsaas(clock)
  await semear(troca, USER, { status: 'ativa', subscriptionId: 'sub_do_usuario', pagoAte: '2027-03-18' })
  let fase: 'primeiro' | 'segundo' | 'solto' = 'primeiro'
  const portoes: Array<{ modo: string, seguir: () => void }> = []
  let apagou = 0
  const i = cancelDe(troca, {
    rotas: async (chamada: Chamada) => {
      if (chamada.method === 'GET') return Response.json({ id: 'sub_do_usuario', deleted: false, status: 'ACTIVE' })
      if (chamada.method === 'DELETE') {
        apagou += 1
        const modo = apagou === 1 ? 'primeiro' : 'segundo'
        if (fase === modo) {
          await new Promise<void>((resolve) => portoes.push({ modo, seguir: resolve }))
        }
        if (modo === 'primeiro') return new Response('falhou', { status: 500 })
        return Response.json({ deleted: true, id: 'sub_do_usuario' })
      }
      return rotasOk(chamada)
    },
  })
  const antigo = i.handler(pedido('http://local/asaas-cancel', {}))
  await ate(() => portoes.some((item) => item.modo === 'primeiro'))
  const tentativaAntiga = troca.cancelamentos[0].tentativaId
  agora += 300_000
  fase = 'segundo'
  const novo = i.handler(pedido('http://local/asaas-cancel', {}))
  await ate(() => portoes.some((item) => item.modo === 'segundo'))
  const tentativaNova = troca.cancelamentos[0].tentativaId
  assert(tentativaAntiga !== tentativaNova)
  fase = 'solto'
  portoes.find((item) => item.modo === 'primeiro')!.seguir()
  const velho = await ler(await antigo)
  equal(velho.status, 502)
  equal(troca.cancelamentos[0].estado, 'pendente')
  equal(troca.cancelamentos[0].tentativaId, tentativaNova)
  portoes.find((item) => item.modo === 'segundo')!.seguir()
  const atual = await ler(await novo)
  equal(atual.status, 200)
  equal(troca.cancelamentos[0].estado, 'concluido')
  equal(await troca.db.marcarCancelamento('sandbox', USER, 'sub_do_usuario', tentativaAntiga), false)
  equal(await troca.db.falharCancelamento('sandbox', USER, 'sub_do_usuario', tentativaAntiga), false)
  equal(troca.cancelamentos[0].estado, 'concluido')
  equal(troca.cancelamentos[0].tentativaId, tentativaNova)
  tabelasOk(mem)
  tabelasOk(troca)
})
