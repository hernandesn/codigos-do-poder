// E2E manual do sandbox Asaas. NÃO entra na suíte offline e NÃO registra webhook.
// Saída: só o passo e PASS/FAIL. cus_ e sub_ podem aparecer. Chave, CPF e cartão não.
// node supabase/functions/_shared/asaas_e2e_sandbox.mjs
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

const scope = new URL('../', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith(scope) && url.endsWith('.ts')) {
      return {
        format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }),
      }
    }
    return nextLoad(url, context)
  },
})

const HOST = 'https://api-sandbox.asaas.com'
const segredos = []
const escrever = console.log.bind(console)
function limpar(valor) {
  let texto = typeof valor === 'string' ? valor : ''
  for (const item of segredos) {
    if (item && item.length >= 4) texto = texto.split(item).join('[redigido]')
  }
  return texto.replace(/\b\d{11,19}\b/g, '[redigido]')
}
console.log = (...args) => escrever(...args.map((item) => (typeof item === 'string' ? limpar(item) : '')))
console.error = console.log
console.info = console.log
console.warn = console.log

if (process.env.ASAAS_BASE_URL !== HOST) {
  console.log('FAIL base_url')
  process.exit(1)
}
const chave = process.env.ASAAS_API_KEY_SANDBOX
if (!chave) {
  console.log('FAIL sem_chave')
  process.exit(1)
}
segredos.push(chave)

const fetchReal = globalThis.fetch.bind(globalThis)
const vistos = []
function fetchGuard(input, init = {}) {
  const bruto = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let origem = ''
  try { origem = new URL(bruto).origin } catch { /* host inválido */ }
  if (origem !== HOST) {
    const erro = new Error('host_bloqueado')
    erro.code = 'host_bloqueado'
    throw erro
  }
  const metodo = init.method || 'GET'
  let corpo = null
  if (typeof init.body === 'string') {
    try { corpo = JSON.parse(init.body) } catch { corpo = null }
  }
  vistos.push({ url: bruto, method: metodo, corpo })
  return fetchReal(input, init)
}
globalThis.fetch = fetchGuard

const { createAsaasCheckoutHandler } = await import('../asaas-checkout/handler.ts')
const { createAsaasCancelHandler } = await import('../asaas-cancel/handler.ts')
const { createSandboxWebhookHandler } = await import('../sandbox_asaas_webhook/handler.ts')
const { createAsaasClient } = await import('./asaas_client.ts')
const { criarMemoriaAsaas } = await import('./asaas_memoria.ts')
const { ORIGEM_SITE, PRECO_REAIS } = await import('./asaas_planos.ts')
const { nextDueDate, somarMesIso, dataIsoDeTexto } = await import('./asaas_datas.ts')
const { cpfValido } = await import('./asaas_cpf.ts')

const CARTAO_OK = '4539656048392220'
const CARTAO_RECUSADO = '4916561358240741'
const TOKEN = 'e2e_token_local_sandbox_0123456789abcd'
const USER = crypto.randomUUID()
segredos.push(CARTAO_OK, CARTAO_RECUSADO, '4539 6560 4839 2220', '4916 5613 5824 0741')

function gerarCpf() {
  const n = []
  for (let i = 0; i < 9; i++) n.push(Math.floor(Math.random() * 10))
  if (n.every((d) => d === n[0])) n[8] = (n[8] + 3) % 10
  const dv = (len) => {
    let soma = 0
    for (let i = 0; i < len; i++) soma += n[i] * (len + 1 - i)
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }
  n.push(dv(9), dv(10))
  const cpf = n.join('')
  if (!cpfValido(cpf)) throw new Error('PARAR')
  return cpf
}

function parar(codigo) {
  console.log('FAIL ' + codigo)
  process.exitCode = 1
  throw new Error('PARAR')
}
function ok(passo, extra) {
  console.log('PASS ' + passo + (extra ? ' ' + extra : ''))
}
function idSeguro(valor, prefixo) {
  return typeof valor === 'string' && valor.startsWith(prefixo) && /^[A-Za-z0-9_]+$/.test(valor) ? valor : null
}

async function chamarApi(method, path, body) {
  const res = await fetchGuard(HOST + path, {
    method,
    headers: {
      access_token: chave,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
  })
  const texto = await res.text()
  let data = null
  if (texto) {
    try { data = JSON.parse(texto) } catch { data = null }
  }
  return { status: res.status, data }
}

function pedido(caminho, body, method = 'POST') {
  return new Request(ORIGEM_SITE + caminho, {
    method,
    headers: {
      origin: ORIGEM_SITE,
      authorization: 'Bearer e2e',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function cartao(numero) {
  return {
    creditCard: {
      holderName: 'Maria Exemplo',
      number: numero,
      expiryMonth: '12',
      expiryYear: '2028',
      ccv: '123',
    },
    creditCardHolderInfo: {
      name: 'Maria Exemplo',
      email: 'sandbox.e2e@example.com',
      cpfCnpj: cpf,
      postalCode: '01310100',
      addressNumber: '100',
      phone: '1133334444',
    },
    remoteIp: '191.191.191.191',
  }
}

const cpf = gerarCpf()
segredos.push(cpf, cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'))

const memoria = criarMemoriaAsaas()
const asaas = createAsaasClient({ fetch: fetchGuard, apiKey: chave, baseUrl: HOST })
const checkout = createAsaasCheckoutHandler({
  authenticate: async () => USER,
  db: async () => memoria.db,
  baseUrl: () => HOST,
  criarAsaas: () => asaas,
  now: () => new Date(),
})
const cancelar = createAsaasCancelHandler({
  authenticate: async () => USER,
  db: async () => memoria.db,
  baseUrl: () => HOST,
  criarAsaas: () => asaas,
})

async function main() {
  const vencimento = nextDueDate(new Date(), 7)
  const vencimentoDia = dataIsoDeTexto(vencimento)
  if (!vencimentoDia) parar('data')

  const resA = await checkout(pedido('/asaas-checkout', {
    plano: 'basico',
    nome: 'Cliente Sandbox',
    cpfCnpj: cpf,
    valor: 0.01,
    value: 1,
    price: 2,
    nextDueDate: '1999-01-01',
  }))
  const corpoA = await resA.json()
  if (resA.status !== 200 || typeof corpoA.url !== 'string' || !corpoA.url.startsWith('https://sandbox.asaas.com/')) parar('checkout')
  const postsCliente = vistos.filter((item) => item.method === 'POST' && item.url === HOST + '/v3/customers')
  const postsCheckout = vistos.filter((item) => item.method === 'POST' && item.url === HOST + '/v3/checkouts')
  if (postsCliente.length !== 1 || postsCheckout.length !== 1) parar('checkout_qtd')
  const enviado = postsCheckout[0].corpo
  if (!enviado || enviado.items?.[0]?.value !== PRECO_REAIS.basico) parar('checkout_valor')
  if (enviado.items[0].value === 0.01 || JSON.stringify(enviado).includes('1999-01-01')) parar('checkout_cliente')
  if (enviado.billingTypes?.[0] !== 'CREDIT_CARD' || enviado.chargeTypes?.[0] !== 'RECURRENT') parar('checkout_tipo')
  if (enviado.subscription?.cycle !== 'MONTHLY' || enviado.subscription?.nextDueDate !== vencimento) parar('checkout_ciclo')
  if (enviado.minutesToExpire !== 60) parar('checkout_expira')
  const customerId = idSeguro(await memoria.db.obterCliente('sandbox', USER), 'cus_')
  const checkoutId = idSeguro(memoria.linhas[0]?.checkoutId, '') || (typeof memoria.linhas[0]?.checkoutId === 'string' ? memoria.linhas[0].checkoutId : null)
  if (!customerId || !checkoutId) parar('checkout_id')
  if (enviado.customer !== customerId) parar('checkout_customer')
  ok('a_checkout', customerId)

  const criada = await chamarApi('POST', '/v3/subscriptions', {
    customer: customerId,
    billingType: 'CREDIT_CARD',
    value: PRECO_REAIS.basico,
    nextDueDate: vencimentoDia,
    cycle: 'MONTHLY',
    description: 'Plano Básico',
    ...cartao(CARTAO_OK),
  })
  const subId = idSeguro(criada.data?.id, 'sub_')
  if (criada.status < 200 || criada.status >= 300 || !subId) parar('assinatura_' + criada.status)
  const pagamentos = await chamarApi('GET', '/v3/subscriptions/' + subId + '/payments')
  const lista = Array.isArray(pagamentos.data?.data) ? pagamentos.data.data : null
  if (!lista) parar('pagamentos')
  if (lista.some((item) => item && (item.status === 'CONFIRMED' || item.status === 'RECEIVED'))) parar('cobranca_dia0')
  ok('b_sem_cobranca_dia0', subId)

  const recusada = await chamarApi('POST', '/v3/subscriptions', {
    customer: customerId,
    billingType: 'CREDIT_CARD',
    value: PRECO_REAIS.basico,
    nextDueDate: vencimentoDia,
    cycle: 'MONTHLY',
    description: 'Plano Básico',
    ...cartao(CARTAO_RECUSADO),
  })
  const subRecusada = idSeguro(recusada.data?.id, 'sub_')
  if (subRecusada) {
    console.log('FAIL cartao_recusado_criou ' + subRecusada)
    process.exitCode = 1
    throw new Error('PARAR')
  }
  if (recusada.status >= 200 && recusada.status < 300) parar('cartao_recusado')
  ok('c_cartao_recusado')

  memoria.anotarSubscription(USER, subId)
  const resD = await cancelar(pedido('/asaas-cancel', { subscription_id: 'sub_alheio', user_id: 'outro' }))
  if (resD.status !== 200) parar('cancelar_' + resD.status)
  const lida = await chamarApi('GET', '/v3/subscriptions/' + subId)
  if (lida.data?.deleted !== true) parar('cancelar_get')
  ok('d_cancelar', subId)

  const fresco = criarMemoriaAsaas()
  await fresco.db.gravarCliente('sandbox', USER, customerId)
  const prep = await fresco.db.prepararCheckout('sandbox', USER, 'basico', vencimentoDia)
  if (!prep.ok || !prep.assinaturaId) parar('e_prep')
  await fresco.db.vincularCheckout('sandbox', USER, prep.assinaturaId, checkoutId)
  const webhook = createSandboxWebhookHandler({
    token: () => TOKEN,
    baseUrl: () => HOST,
    db: async () => fresco.db,
    now: () => new Date('2026-11-18T15:00:00.000Z'),
  })
  async function evento(id, event, extra, quando) {
    const res = await webhook(new Request(HOST + '/sandbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'asaas-access-token': TOKEN },
      body: JSON.stringify({ id, event, dateCreated: quando, ...extra }),
    }))
    if (res.status !== 200) parar('e_' + event)
    return fresco.linhas[0]
  }
  const trial = await evento('evt_e2e_created', 'SUBSCRIPTION_CREATED', {
    subscription: {
      id: subId,
      customer: customerId,
      nextDueDate: vencimentoDia,
      value: PRECO_REAIS.basico,
      externalReference: prep.assinaturaId,
    },
  }, '2026-11-18 12:00:00')
  if (trial?.status !== 'trial') parar('e_trial')
  ok('e_trial', subId)
  const dup = await evento('evt_e2e_created', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_e2e_dup', customer: customerId, subscription: subId, value: PRECO_REAIS.basico, dueDate: vencimentoDia },
  }, '2026-11-18 12:05:00')
  if (dup?.status !== 'trial' || fresco.transicoes !== 1 || fresco.qtdEventos !== 1) parar('e_duplicado')
  ok('e_duplicado')
  const ativa = await evento('evt_e2e_confirmed', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_e2e_ok', customer: customerId, subscription: subId, value: PRECO_REAIS.basico, dueDate: vencimentoDia },
  }, '2026-11-18 12:10:00')
  if (ativa?.status !== 'ativa' || ativa.pagoAte !== somarMesIso(vencimentoDia)) parar('e_ativa')
  ok('e_ativa')
  const fim = await evento('evt_e2e_deleted', 'SUBSCRIPTION_DELETED', {
    subscription: { id: subId, customer: customerId },
  }, '2026-11-18 12:15:00')
  if (fim?.status !== 'cancelada') parar('e_cancelada')
  ok('e_cancelada')
  // Checkout expirado reconcilia com GET /v3/subscriptions?customer= antes de abrir outro.
  // PAYMENT_CONFIRMED depois do encerramento não reabre a recorrência nem estende pago_ate.
  const estorno = await evento('evt_e2e_refund', 'PAYMENT_REFUNDED', {
    payment: { id: 'pay_e2e_refund', customer: customerId, subscription: subId, value: PRECO_REAIS.basico },
  }, '2026-11-18 12:20:00')
  if (estorno?.status !== 'suspensa' || estorno.recorrencia !== 'encerrada' || estorno.pagoAte !== somarMesIso(vencimentoDia)) parar('e_estorno')
  ok('e_estorno')
  const parado = await evento('evt_e2e_pos', 'PAYMENT_CONFIRMED', {
    payment: { id: 'pay_e2e_pos', customer: customerId, subscription: subId, value: PRECO_REAIS.basico, dueDate: vencimentoDia },
  }, '2026-11-18 12:25:00')
  if (parado?.status !== 'suspensa' || parado.recorrencia !== 'encerrada' || parado.pagoAte !== somarMesIso(vencimentoDia)) parar('e_confirmado_encerrada')
  ok('e_confirmado_encerrada')
  vistos.length = 0
}

try {
  await main()
} catch (erro) {
  if (!erro || erro.message !== 'PARAR') {
    const codigo = erro && erro.code === 'host_bloqueado' ? 'host_bloqueado' : 'inesperado'
    if (process.exitCode !== 1) console.log('FAIL ' + codigo)
    process.exitCode = 1
  }
}
