import { ASAAS_SANDBOX_BASE } from './asaas_planos.ts'
import type { Ambiente, AsaasDb, EventoDb } from './asaas_db.ts'
import { dataIsoDeTexto, parseInstanteAsaas } from './asaas_datas.ts'
import { falhaDeSchema, logSeguro, tokenWebhookConfere } from './asaas_token.ts'
import { JsonBodyReadError, readJsonWithByteLimit } from './read_json.ts'

const ID_OK = /^[A-Za-z0-9_-]{1,80}$/
const EVENTO_ID = /^[A-Za-z0-9_.:&=-]{1,120}$/

export interface DepsWebhook {
  ambiente: Ambiente
  token: () => string | undefined
  baseUrl: () => string | undefined
  db: () => Promise<AsaasDb>
  log?: (entrada: Record<string, string>) => void
  now?: () => Date
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? valor as Record<string, unknown> : null
}

function textoId(valor: unknown): string | null {
  if (typeof valor !== 'string') return null
  const texto = valor.trim()
  return ID_OK.test(texto) ? texto : null
}

function idAninhado(valor: unknown): string | null {
  return textoId(valor) ?? textoId(objeto(valor)?.id)
}

function numero(valor: unknown): number | null {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor
  if (typeof valor === 'string' && /^-?\d+(\.\d+)?$/.test(valor)) return Number(valor)
  return null
}

export interface EventoNormalizado {
  eventId: string
  tipo: string
  recursoId: string | null
  subscriptionId: string | null
  customerId: string | null
  checkoutId: string | null
  externalReference: string | null
  valor: number | null
  vencimento: string | null
  nextDue: string | null
  quando: string
}

/** Só copia os campos de negócio. CPF, e-mail, cartão e o corpo cru não saem daqui. */
export function normalizarEvento(body: unknown, agora: Date): EventoNormalizado | null {
  const row = objeto(body)
  if (!row) return null
  const eventId = typeof row.id === 'string' && EVENTO_ID.test(row.id.trim()) ? row.id.trim() : null
  const tipo = typeof row.event === 'string' ? row.event.trim() : ''
  if (!eventId || !tipo || tipo.length > 80) return null
  const payment = objeto(row.payment)
  const subscription = objeto(row.subscription)
  const checkout = objeto(row.checkout)
  const recursoId = idAninhado(payment?.id) ?? idAninhado(subscription?.id) ?? idAninhado(checkout?.id)
  const subscriptionId = idAninhado(payment?.subscription) ?? idAninhado(subscription?.id) ?? idAninhado(checkout?.subscription)
  const customerId = textoId(payment?.customer) ?? textoId(subscription?.customer) ?? textoId(checkout?.customer)
  const checkoutId = textoId(checkout?.id)
  const externalReference = textoId(payment?.externalReference) ?? textoId(subscription?.externalReference) ?? textoId(checkout?.externalReference)
  const valor = numero(payment?.value) ?? numero(subscription?.value) ?? numero(checkout?.value)
  const vencimento = dataIsoDeTexto(payment?.dueDate) ?? dataIsoDeTexto(payment?.originalDueDate)
  const nextDue = dataIsoDeTexto(subscription?.nextDueDate) ?? dataIsoDeTexto(checkout?.nextDueDate) ?? dataIsoDeTexto(payment?.nextDueDate)
  const quando = parseInstanteAsaas(typeof row.dateCreated === 'string' ? row.dateCreated : null, agora)
  return { eventId, tipo, recursoId, subscriptionId, customerId, checkoutId, externalReference, valor, vencimento, nextDue, quando }
}

function eventoDb(ambiente: Ambiente, evento: EventoNormalizado): EventoDb {
  return { ambiente, ...evento }
}

export function createWebhookHttp(d: DepsWebhook) {
  const json = (value: unknown, status = 200) => Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json({ code: 'pedido_invalido', message: 'Use POST.' }, 405)
    const configurado = d.token() ?? ''
    if (configurado.length < 32 || configurado.length > 256) {
      return json({ code: 'configuracao_ausente', message: 'Webhook indisponível.' }, 503)
    }
    const header = req.headers.get('asaas-access-token') ?? ''
    if (header.length > 256 || !await tokenWebhookConfere(header, configurado)) {
      return json({ code: 'nao_autorizado', message: 'Token recusado.' }, 401)
    }
    if (d.ambiente === 'producao') {
      // TODO(Hernandes): produção ainda não configurada. A chave de produção virá com outro nome.
      return json({ code: 'configuracao_ausente', message: 'Webhook de produção indisponível.' }, 503)
    }
    if ((d.baseUrl() ?? '') !== ASAAS_SANDBOX_BASE) {
      return json({ code: 'configuracao_ausente', message: 'Webhook indisponível.' }, 503)
    }
    let body: unknown
    try {
      body = await readJsonWithByteLimit(req)
    } catch (erro) {
      const status = erro instanceof JsonBodyReadError ? erro.status : 400
      return json({ code: 'pedido_invalido', message: 'Corpo inválido ou muito grande.' }, status)
    }
    const evento = normalizarEvento(body, d.now?.() ?? new Date())
    if (!evento) return json({ code: 'pedido_invalido', message: 'Evento inválido.' }, 400)
    const soLog = () => {
      d.log?.({
        fn: 'sandbox_asaas_webhook',
        modo: 'so_log',
        evento: evento.tipo,
        event_id: evento.eventId,
        recurso_id: evento.recursoId ?? '',
        subscription_id: evento.subscriptionId ?? '',
      })
      return json({ ok: true })
    }
    try {
      const db = await d.db()
      await db.aplicarEvento(eventoDb('sandbox', evento))
      logSeguro(d.log, { fn: 'sandbox_asaas_webhook', evento: evento.tipo, event_id: evento.eventId, resultado: 'aplicado' })
      return json({ ok: true })
    } catch (erro) {
      if (falhaDeSchema(erro)) return soLog()
      logSeguro(d.log, { fn: 'sandbox_asaas_webhook', evento: evento.tipo, event_id: evento.eventId, classificacao: 'falha_interna', pedido_id: crypto.randomUUID() })
      return json({ code: 'rede', message: 'Não foi possível registrar o evento.' }, 502)
    }
  }
}
