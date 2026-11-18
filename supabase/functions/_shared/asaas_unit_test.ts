import { ASAAS_TIMEOUT_MS, CANCEL_LEASE_MS, CANCEL_TENTATIVA_MAX_MS, AsaasErro, createAsaasClient, urlCheckout } from './asaas_client.ts'
import { cpfCnpjValido, cnpjValido, cpfValido } from './asaas_cpf.ts'
import { dataIsoNoFuso, nextDueDate, parseInstanteAsaas, somarMesIso } from './asaas_datas.ts'
import { acharLinha, assinaturaAberta, centavosDe, transicionar, type LinhaAssinatura } from './asaas_estado.ts'
import { criarMemoriaAsaas } from './asaas_memoria.ts'
import { LIMITES_PLANO, PRECO_CENTAVOS, PRECO_REAIS, TETO_GLOBAL_USD_DIA, TRIAL_DIAS, beneficios } from './asaas_planos.ts'
import { ASAAS_SANDBOX_BASE } from './asaas_planos.ts'
import { tokenWebhookConfere } from './asaas_token.ts'
import type { EventoDb } from './asaas_db.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const CHAVE = 'chave_sintetica_sandbox_0123456789abcd'

function assert(cond: unknown, msg?: string) {
  if (!cond) throw new Error(msg || 'asserção')
}
function equal(a: unknown, b: unknown) {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  if (ja !== jb) throw new Error('esperado ' + jb + ' obtido ' + ja)
}

Deno.test('limites e preços do servidor batem com o plano definido', () => {
  equal(LIMITES_PLANO.free, { basico_dia: 20, avancado_ciclo: 0 })
  equal(LIMITES_PLANO.basico, { basico_dia: 150, avancado_ciclo: 20 })
  equal(LIMITES_PLANO.plus, { basico_dia: 150, avancado_ciclo: 100 })
  equal(PRECO_CENTAVOS, { basico: 990, plus: 2990 })
  equal(PRECO_REAIS, { basico: 9.9, plus: 29.9 })
  equal(TETO_GLOBAL_USD_DIA, 3)
  equal(TRIAL_DIAS, 7)
  assert(beneficios.plus.nota.includes('Plus não é o modelo Avançado'))
  assert(beneficios.basico.basico_dia === 150 && beneficios.plus.avancado_ciclo === 100)
  assert(!assinaturaAberta('checkout') && !assinaturaAberta('cancelada'))
  assert(assinaturaAberta('divergente') && assinaturaAberta('trial'))
})

Deno.test('CPF e CNPJ exigem dígitos verificadores', () => {
  assert(cpfValido('52998224725'))
  assert(!cpfValido('52998224726'))
  assert(!cpfValido('11111111111'))
  assert(cnpjValido('11444777000161'))
  assert(!cnpjValido('11444777000160'))
  assert(cpfCnpjValido('529.982.247-25'))
  assert(cpfCnpjValido('11.444.777/0001-61'))
  assert(!cpfCnpjValido('123'))
  assert(!cpfCnpjValido(''))
})

Deno.test('nextDueDate soma 7 dias no fuso America/Sao_Paulo, inclusive virada', () => {
  const casos: Array<[string, string]> = [
    ['2026-11-18T15:00:00Z', '2026-11-25 00:00:00'],
    ['2026-12-01T02:30:00Z', '2026-12-07 00:00:00'],
    ['2026-12-01T03:30:00Z', '2026-12-08 00:00:00'],
    ['2026-01-28T15:00:00Z', '2026-02-04 00:00:00'],
    ['2026-01-31T15:00:00Z', '2026-02-07 00:00:00'],
    ['2026-12-28T15:00:00Z', '2027-01-04 00:00:00'],
  ]
  for (const [iso, esperado] of casos) equal(nextDueDate(new Date(iso), 7), esperado)
  equal(dataIsoNoFuso(new Date('2026-12-01T02:30:00Z'), 'America/Sao_Paulo'), '2026-11-30')
  equal(somarMesIso('2026-01-31'), '2026-02-28')
  equal(somarMesIso('2024-01-31'), '2024-02-29')
  equal(somarMesIso('2026-03-31'), '2026-04-30')
  equal(somarMesIso('2026-12-31'), '2027-01-31')
  equal(somarMesIso('nao-data'), null)
  equal(parseInstanteAsaas('2026-11-18 10:00:00', new Date('2026-01-01T00:00:00Z')), '2026-11-18T13:00:00.000Z')
  equal(centavosDe(9.9), 990)
  equal(centavosDe(29.9), 2990)
  equal(centavosDe(null), null)
})

Deno.test('token do webhook compara os dois digests e não o texto cru', async () => {
  const certo = 'a'.repeat(40)
  assert(await tokenWebhookConfere(certo, certo))
  assert(!(await tokenWebhookConfere('b'.repeat(40), certo)))
  assert(!(await tokenWebhookConfere('curto', certo)))
  assert(!(await tokenWebhookConfere('', certo)))
})

Deno.test('cliente Asaas: timeout, sem retry, sem vazar corpo e URL só do sandbox', async () => {
  equal(ASAAS_TIMEOUT_MS >= 60_000, true)
  equal(CANCEL_TENTATIVA_MAX_MS, ASAAS_TIMEOUT_MS * 3)
  equal(CANCEL_TENTATIVA_MAX_MS < CANCEL_LEASE_MS, true)
  equal(CANCEL_LEASE_MS, 240_000)
  let chamadas = 0
  const pendente = createAsaasClient({
    apiKey: CHAVE,
    baseUrl: ASAAS_SANDBOX_BASE,
    timeoutMs: 30,
    fetch: (_url, init) => new Promise((_ok, rejeita) => {
      chamadas += 1
      init?.signal?.addEventListener('abort', () => {
        const erro = new Error('abortado')
        erro.name = 'AbortError'
        rejeita(erro)
      })
    }),
  })
  let codigo = ''
  try {
    await Promise.race([
      pendente.criarCliente({ nome: 'Maria Exemplo', cpfCnpj: '52998224725' }),
      new Promise((_ok, rejeita) => setTimeout(() => rejeita(new Error('timeout do teste')), 500)),
    ])
  }
  catch (erro) {
    codigo = erro instanceof AsaasErro ? erro.codigo : 'outro'
    assert(erro instanceof AsaasErro && erro.definitivo === false)
  }
  equal(codigo, 'provedor')
  equal(chamadas, 1)

  chamadas = 0
  let leu = false
  const falho = createAsaasClient({
    apiKey: CHAVE,
    baseUrl: ASAAS_SANDBOX_BASE,
    fetch: async () => {
      chamadas += 1
      return {
        ok: false,
        status: 400,
        body: { cancel: async () => {} },
        json: async () => { leu = true; return { errors: [{ description: 'CORPO_REMOTO_NAO_VAZAR' }] } },
        text: async () => { leu = true; return 'CORPO_REMOTO_NAO_VAZAR' },
      } as unknown as Response
    },
  })
  try { await falho.criarCheckout({ customer: 'cus_teste123', plano: 'basico', valor: 9.9, nextDueDate: '2026-11-25 00:00:00', externalReference: USER, nomeItem: 'Plano Básico' }) }
  catch (erro: unknown) {
    assert(erro instanceof AsaasErro)
    if (!(erro instanceof AsaasErro)) throw erro
    assert(erro.definitivo === true)
    assert(!String(erro).includes('CORPO_REMOTO_NAO_VAZAR'))
  }
  equal(chamadas, 1)
  equal(leu, false)

  let foi = false
  const fora = createAsaasClient({
    apiKey: CHAVE,
    baseUrl: 'https://api.asaas.com',
    fetch: async () => { foi = true; throw new Error('rede') },
  })
  let fechado = false
  try { await fora.criarCliente({ nome: 'Maria Exemplo', cpfCnpj: '52998224725' }) }
  catch (erro) { fechado = erro instanceof AsaasErro }
  assert(fechado && !foi)

  const envios: string[] = []
  const ok = createAsaasClient({
    apiKey: CHAVE,
    baseUrl: ASAAS_SANDBOX_BASE + '/',
    fetch: async (input, init) => {
      envios.push(String(input))
      assert(init?.redirect === 'error')
      assert(init?.signal)
      const headers = new Headers(init?.headers)
      equal(headers.get('access_token'), CHAVE)
      if (String(input).endsWith('/v3/checkouts')) {
        const corpo = JSON.parse(String(init?.body))
        equal(corpo.billingTypes, ['CREDIT_CARD'])
        equal(corpo.chargeTypes, ['RECURRENT'])
        equal(corpo.minutesToExpire, 60)
        equal(corpo.items, [{ name: 'Plano Básico', value: 9.9, quantity: 1 }])
        equal(corpo.subscription, { cycle: 'MONTHLY', nextDueDate: '2026-11-25 00:00:00' })
        equal(corpo.customer, 'cus_teste123')
        return Response.json({ id: 'chk_teste123', link: 'https://evil.example/phish' })
      }
      return Response.json({ id: 'cus_teste123' })
    },
  })
  const sessao = await ok.criarCheckout({
    customer: 'cus_teste123', plano: 'basico', valor: 9.9, nextDueDate: '2026-11-25 00:00:00',
    externalReference: USER, nomeItem: 'Plano Básico',
  })
  equal(sessao.url, urlCheckout('chk_teste123'))
  equal(envios[0], ASAAS_SANDBOX_BASE + '/v3/checkouts')
  const sumiu = createAsaasClient({
    apiKey: CHAVE,
    baseUrl: ASAAS_SANDBOX_BASE,
    fetch: async () => ({ ok: false, status: 404, body: { cancel: async () => {} }, json: async () => { throw new Error('leu 404') } }) as unknown as Response,
  })
  equal(await sumiu.buscarCliente('cus_teste123'), null)
  equal((await sumiu.cancelarAssinatura('sub_teste123')).ausente, true)

  let tentativasGet = 0
  const repetiu = createAsaasClient({
    apiKey: CHAVE,
    baseUrl: ASAAS_SANDBOX_BASE,
    fetch: async () => {
      tentativasGet += 1
      if (tentativasGet === 1) return new Response('ocupado', { status: 500 })
      return Response.json({ data: [{ id: 'sub_lista1', deleted: false, status: 'ACTIVE', externalReference: USER }], hasMore: false })
    },
  })
  const lista = await repetiu.listarAssinaturas('cus_teste123')
  equal(tentativasGet, 2)
  equal(lista[0].id, 'sub_lista1')
  let tentativasPost = 0
  const postUnico = createAsaasClient({
    apiKey: CHAVE,
    baseUrl: ASAAS_SANDBOX_BASE,
    fetch: async () => {
      tentativasPost += 1
      return new Response('falhou', { status: 500 })
    },
  })
  let postFalhou = false
  try { await postUnico.criarCliente({ nome: 'Maria Exemplo', cpfCnpj: '52998224725' }) }
  catch (erro) { postFalhou = erro instanceof AsaasErro }
  assert(postFalhou)
  equal(tentativasPost, 1)
})

Deno.test('transição não regride, cancelada é terminal e divergente ainda aceita pagamento novo', () => {
  const base: LinhaAssinatura = {
    id: USER, ambiente: 'sandbox', userId: USER, subscriptionId: 'sub_teste123', checkoutId: null,
    plano: 'basico', status: 'ativa', recorrencia: 'ativa', bloqueio: null, reserva: 'aberta', trialAte: null, pagoAte: '2027-01-18', ultimoEventoEm: '2026-11-18T15:00:00.000Z',
    precoCentavos: 990, nextDuePlanejado: null, resultadoIncerto: false, envioEm: null,
    criadoEm: '2026-11-18T12:00:00.000Z', atualizadoEm: '2026-11-18T15:00:00.000Z',
  }
  const evento = (tipo: string, quando: string, valor: number | null): EventoDb => ({
    ambiente: 'sandbox', eventId: 'evt_' + tipo + quando, tipo, recursoId: 'pay_1', subscriptionId: 'sub_teste123',
    customerId: 'cus_teste123', checkoutId: null, externalReference: null, valor, vencimento: '2026-12-18',
    nextDue: '2026-11-25', quando,
  })
  const antigo = transicionar(base, evento('PAYMENT_OVERDUE', '2026-11-18T14:00:00.000Z', null), USER)
  equal(antigo.motivo, 'antigo')
  equal(antigo.linha?.status, 'ativa')
  const divergente = transicionar(base, evento('PAYMENT_CONFIRMED', '2026-11-18T16:00:00.000Z', 1), USER)
  equal(divergente.linha?.status, 'divergente')
  const recuperou = transicionar(divergente.linha, evento('PAYMENT_CONFIRMED', '2026-11-18T17:00:00.000Z', 9.9), USER)
  equal(recuperou.linha?.status, 'ativa')
  equal(recuperou.linha?.pagoAte, '2027-01-18')
  const cancelada = { ...base, status: 'cancelada' as const }
  const terminal = transicionar(cancelada, evento('PAYMENT_CONFIRMED', '2026-11-19T17:00:00.000Z', 9.9), USER)
  equal(terminal.motivo, 'terminal')
  equal(terminal.linha?.status, 'cancelada')
  equal(terminal.linha?.recorrencia, 'encerrada')
  const estorno = transicionar(terminal.linha, evento('PAYMENT_REFUNDED', '2026-11-19T18:00:00.000Z', 9.9), USER)
  equal(estorno.linha?.bloqueio, 'suspensa')
  equal(estorno.linha?.status, 'suspensa')
  equal(estorno.linha?.recorrencia, 'encerrada')
  equal(estorno.linha?.pagoAte, '2027-01-18')
  const parado = transicionar(estorno.linha, evento('PAYMENT_CONFIRMED', '2026-11-19T19:00:00.000Z', 9.9), USER)
  equal(parado.motivo, 'terminal')
  equal(parado.linha?.bloqueio, 'suspensa')
  equal(parado.linha?.recorrencia, 'encerrada')
  equal(parado.linha?.pagoAte, '2027-01-18')
  const longo = { ...base, pagoAte: '2027-06-01' }
  const curto = transicionar(longo, evento('PAYMENT_CONFIRMED', '2026-11-18T18:00:00.000Z', 9.9), USER)
  equal(curto.linha?.pagoAte, '2027-06-01')
  const estende = transicionar(curto.linha, {
    ...evento('PAYMENT_RECEIVED', '2026-11-18T19:00:00.000Z', 9.9),
    vencimento: '2027-08-01',
  }, USER)
  equal(estende.linha?.pagoAte, '2027-09-01')
  const encerrada = transicionar(base, evento('SUBSCRIPTION_DELETED', '2026-11-18T18:10:00.000Z', null), USER)
  equal(encerrada.linha?.recorrencia, 'encerrada')
  equal(encerrada.linha?.ultimoEventoEm, '2026-11-18T18:10:00.000Z')
  const fora = transicionar(encerrada.linha, evento('PAYMENT_REFUNDED', '2026-11-18T18:09:00.000Z', 9.9), USER)
  equal(fora.motivo, 'ok')
  equal(fora.linha?.bloqueio, 'suspensa')
  equal(fora.linha?.recorrencia, 'encerrada')
  equal(fora.linha?.pagoAte, '2027-01-18')
  equal(fora.linha?.ultimoEventoEm, '2026-11-18T18:10:00.000Z')
  const atraso = transicionar(fora.linha, evento('PAYMENT_OVERDUE', '2026-11-18T18:09:30.000Z', null), USER)
  equal(atraso.motivo, 'antigo')
  equal(atraso.linha?.bloqueio, 'suspensa')
  const cronologico = transicionar(
    transicionar({ ...base, ultimoEventoEm: '2026-11-18T18:00:00.000Z' }, evento('PAYMENT_REFUNDED', '2026-11-18T18:09:00.000Z', 9.9), USER).linha,
    evento('SUBSCRIPTION_DELETED', '2026-11-18T18:10:00.000Z', null),
    USER,
  )
  equal(cronologico.linha?.bloqueio, 'suspensa')
  equal(cronologico.linha?.recorrencia, 'encerrada')
  equal(cronologico.linha?.ultimoEventoEm, '2026-11-18T18:10:00.000Z')
  const chargeback = transicionar(encerrada.linha, evento('PAYMENT_CHARGEBACK_REQUESTED', '2026-11-18T18:08:00.000Z', 9.9), USER)
  equal(chargeback.motivo, 'ok')
  equal(chargeback.linha?.bloqueio, 'suspensa')
  equal(chargeback.linha?.ultimoEventoEm, '2026-11-18T18:10:00.000Z')
})

Deno.test('correlação ignora outra assinatura e o trial exige preço e data da reserva', () => {
  const aberta: LinhaAssinatura = {
    id: 'linha-a', ambiente: 'sandbox', userId: USER, subscriptionId: 'sub_atual', checkoutId: null,
    plano: 'basico', status: 'ativa', recorrencia: 'ativa', bloqueio: null, reserva: 'aberta', trialAte: null, pagoAte: '2027-06-01', ultimoEventoEm: null,
    precoCentavos: 990, nextDuePlanejado: null, resultadoIncerto: false, envioEm: null,
    criadoEm: '2026-11-18T12:00:00.000Z', atualizadoEm: '2026-11-18T12:00:00.000Z',
  }
  const outra: EventoDb = {
    ambiente: 'sandbox', eventId: 'evt_outra', tipo: 'PAYMENT_CONFIRMED', recursoId: 'pay_outra',
    subscriptionId: 'sub_outra', customerId: 'cus_teste123', checkoutId: null, externalReference: null,
    valor: 9.9, vencimento: '2026-12-18', nextDue: null, quando: '2026-11-18T16:00:00.000Z',
  }
  const achado = acharLinha([aberta], outra, USER)
  equal(achado.ignorado, true)
  equal(achado.linha, null)
  const reserva: LinhaAssinatura = {
    ...aberta, id: 'linha-reserva', status: 'checkout', recorrencia: 'pendente', bloqueio: null, reserva: 'aberta',
    subscriptionId: null, checkoutId: 'chk_reserva',
    pagoAte: null, precoCentavos: 990, nextDuePlanejado: '2026-11-25',
  }
  const baseEvento: EventoDb = {
    ...outra, tipo: 'SUBSCRIPTION_CREATED', subscriptionId: 'sub_nova', checkoutId: 'chk_reserva',
    externalReference: reserva.id, valor: 9.9, nextDue: '2026-11-25', vencimento: null,
  }
  const trials = new Set<string>()
  const ok = transicionar(reserva, baseEvento, USER, { linhas: [reserva], trials })
  equal(ok.linha?.status, 'trial')
  equal(ok.linha?.trialAte, '2026-11-25')
  const fora = transicionar(reserva, { ...baseEvento, eventId: 'evt_fora', nextDue: '2026-11-27' }, USER, { linhas: [reserva], trials: new Set() })
  equal(fora.linha?.status, 'divergente')
  equal(fora.linha?.trialAte, null)
  const caro = transicionar(reserva, { ...baseEvento, eventId: 'evt_caro', valor: 29.9, nextDue: '2026-11-25' }, USER, { linhas: [reserva], trials: new Set() })
  equal(caro.linha?.status, 'divergente')
  equal(trials.size, 1)
  const expirada: LinhaAssinatura = { ...reserva, id: 'linha-exp', reserva: 'expirada', checkoutId: 'chk_exp' }
  const achadoExp = acharLinha([expirada], { ...baseEvento, eventId: 'evt_exp', checkoutId: 'chk_exp', externalReference: 'linha-exp', subscriptionId: 'sub_exp' }, USER)
  equal(achadoExp.ignorado, false)
  equal(achadoExp.linha?.id, 'linha-exp')
  const ligado = transicionar(expirada, { ...baseEvento, eventId: 'evt_exp_ok', checkoutId: 'chk_exp', externalReference: 'linha-exp', subscriptionId: 'sub_exp' }, USER, { linhas: [expirada], trials: new Set() })
  equal(ligado.linha?.status, 'trial')
  equal(ligado.motivo, 'ok')
})

Deno.test('anotarSubscription é gancho de teste e não mexe em linha cancelada', async () => {
  const mem = criarMemoriaAsaas()
  const prep = await mem.db.prepararCheckout('sandbox', USER, 'basico')
  mem.anotarSubscription(USER, 'sub_anotado')
  equal(mem.linhas[0].subscriptionId, 'sub_anotado')
  equal(prep.ok, true)
  mem.linhas[0].status = 'cancelada'
  let falhou = false
  try { mem.anotarSubscription(USER, 'sub_outra') } catch { falhou = true }
  assert(falhou)
})
