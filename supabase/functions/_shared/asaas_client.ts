import { ASAAS_SANDBOX_BASE, CICLO_ASSINATURA, URLS_CALLBACK, type PlanoPago } from './asaas_planos.ts'

export const ASAAS_TIMEOUT_MS = 60_000
/** 2 GET com retry (2 × 60s) + 1 DELETE (60s) = 180s. O lease fica acima desse teto. */
export const CANCEL_TENTATIVA_MAX_MS = ASAAS_TIMEOUT_MS * 3
export const CANCEL_LEASE_MS = 240_000

export class AsaasErro extends Error {
  readonly codigo = 'provedor'
  /** 4xx definitivo antes de criar. Timeout, rede, 5xx, 408, 429 e corpo inválido após 2xx ficam incertos. */
  readonly definitivo: boolean
  constructor(definitivo = false) {
    super('provedor')
    this.name = 'AsaasErro'
    this.definitivo = definitivo
  }
}

export interface NovoCliente { nome: string, cpfCnpj: string }
export interface NovoCheckout {
  customer: string
  plano: PlanoPago
  valor: number
  nextDueDate: string
  externalReference: string
  nomeItem: string
}

export interface AssinaturaRemota {
  id: string
  deleted: boolean
  status: string | null
  externalReference: string | null
}

export interface AsaasClient {
  criarCliente(input: NovoCliente): Promise<{ id: string }>
  buscarCliente(id: string): Promise<{ id: string } | null>
  criarCheckout(input: NovoCheckout): Promise<{ id: string, url: string }>
  cancelarAssinatura(id: string): Promise<{ deleted: boolean, ausente: boolean }>
  obterAssinatura(id: string): Promise<{ id: string, deleted: boolean, status: string | null }>
  listarAssinaturas(customerId: string): Promise<AssinaturaRemota[]>
  /** Mesma regra fail-closed de listarAssinaturas. O id interno da reserva é o externalReference. */
  listarAssinaturasPorReferencia(externalReference: string): Promise<AssinaturaRemota[]>
}

const ID_OK = /^[A-Za-z0-9_-]{1,80}$/

function idOk(valor: unknown): string | null {
  return typeof valor === 'string' && ID_OK.test(valor) ? valor : null
}

export function urlCheckout(id: string): string {
  return `https://sandbox.asaas.com/checkoutSession/show?id=${encodeURIComponent(id)}`
}

function urlDaResposta(data: Record<string, unknown>, id: string): string {
  if (typeof data.link === 'string') {
    try {
      const url = new URL(data.link)
      if (url.protocol === 'https:' && url.hostname === 'sandbox.asaas.com') return url.toString()
    } catch { /* cai no formato documentado */ }
  }
  // TODO(Hernandes): confirmar no sandbox real se `link` sempre vem preenchido.
  return urlCheckout(id)
}

export function createAsaasClient(opts: {
  fetch: typeof fetch
  apiKey: string
  baseUrl: string
  timeoutMs?: number
}): AsaasClient {
  const timeoutMs = opts.timeoutMs ?? ASAAS_TIMEOUT_MS
  const base = opts.baseUrl.replace(/\/+$/, '')

  async function umaVez(method: string, path: string, body?: unknown): Promise<{ status: number, data: Record<string, unknown> | null }> {
    if (base !== ASAAS_SANDBOX_BASE) throw new AsaasErro(true)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      // Sem retry em POST: repetir no Asaas pode duplicar a cobrança. GET pode repetir uma vez.
      const res = await opts.fetch(base + path, {
        method,
        headers: {
          access_token: opts.apiKey,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        redirect: 'error',
      })
      if (res.status === 404 && (method === 'GET' || method === 'DELETE')) {
        await res.body?.cancel().catch(() => {})
        return { status: 404, data: null }
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        const definitivo = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
        throw new AsaasErro(definitivo)
      }
      try {
        const data = await res.json()
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AsaasErro(false)
        return { status: res.status, data: data as Record<string, unknown> }
      } catch (erro) {
        if (erro instanceof AsaasErro) throw erro
        throw new AsaasErro(false)
      }
    } catch (erro) {
      if (erro instanceof AsaasErro) throw erro
      throw new AsaasErro(false)
    } finally {
      clearTimeout(timer)
    }
  }

  async function chamar(method: string, path: string, body?: unknown, retries = 0): Promise<{ status: number, data: Record<string, unknown> | null }> {
    let restante = method === 'GET' ? retries : 0
    for (;;) {
      try {
        return await umaVez(method, path, body)
      } catch (erro) {
        if (restante <= 0 || !(erro instanceof AsaasErro) || erro.definitivo) throw erro
        restante -= 1
      }
    }
  }

  function remota(data: Record<string, unknown>): AssinaturaRemota {
    const id = idOk(data.id)
    if (!id) throw new AsaasErro(false)
    return {
      id,
      deleted: data.deleted === true,
      status: typeof data.status === 'string' ? data.status : null,
      externalReference: idOk(data.externalReference),
    }
  }

  async function listar(path: string): Promise<AssinaturaRemota[]> {
    const res = await chamar('GET', path, undefined, 1)
    if (res.status === 404 || !res.data || res.data.hasMore === true || !Array.isArray(res.data.data)) throw new AsaasErro(false)
    return res.data.data.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AsaasErro(false)
      return remota(item as Record<string, unknown>)
    })
  }

  return {
    async criarCliente(input) {
      const { data } = await chamar('POST', '/v3/customers', {
        name: input.nome,
        cpfCnpj: input.cpfCnpj,
        notificationDisabled: true,
      })
      const id = idOk(data?.id)
      if (!id) throw new AsaasErro(false)
      return { id }
    },
    async buscarCliente(id) {
      if (!idOk(id)) throw new AsaasErro(true)
      const res = await chamar('GET', '/v3/customers/' + id, undefined, 1)
      if (res.status === 404) return null
      const achado = idOk(res.data?.id)
      if (!achado) throw new AsaasErro(false)
      return { id: achado }
    },
    async criarCheckout(input) {
      if (!idOk(input.customer) || !idOk(input.externalReference)) throw new AsaasErro(true)
      const { data } = await chamar('POST', '/v3/checkouts', {
        billingTypes: ['CREDIT_CARD'],
        chargeTypes: ['RECURRENT'],
        minutesToExpire: 60,
        callback: URLS_CALLBACK,
        items: [{ name: input.nomeItem, value: input.valor, quantity: 1 }],
        customer: input.customer,
        externalReference: input.externalReference,
        subscription: { cycle: CICLO_ASSINATURA, nextDueDate: input.nextDueDate },
      })
      const id = idOk(data?.id)
      if (!id || !data) throw new AsaasErro(false)
      return { id, url: urlDaResposta(data, id) }
    },
    async cancelarAssinatura(id) {
      if (!idOk(id)) throw new AsaasErro(true)
      const res = await chamar('DELETE', '/v3/subscriptions/' + id)
      if (res.status === 404) return { deleted: true, ausente: true }
      if (res.data?.deleted !== true) throw new AsaasErro(false)
      return { deleted: true, ausente: false }
    },
    async obterAssinatura(id) {
      if (!idOk(id)) throw new AsaasErro(true)
      const res = await chamar('GET', '/v3/subscriptions/' + id, undefined, 1)
      if (res.status === 404) return { id, deleted: true, status: null }
      const achado = idOk(res.data?.id)
      if (!achado || !res.data) throw new AsaasErro(false)
      return {
        id: achado,
        deleted: res.data.deleted === true,
        status: typeof res.data.status === 'string' ? res.data.status : null,
      }
    },
    async listarAssinaturas(customerId) {
      if (!idOk(customerId)) throw new AsaasErro(true)
      return listar('/v3/subscriptions?customer=' + encodeURIComponent(customerId) + '&limit=100')
    },
    async listarAssinaturasPorReferencia(externalReference) {
      if (!idOk(externalReference)) throw new AsaasErro(true)
      return listar('/v3/subscriptions?externalReference=' + encodeURIComponent(externalReference) + '&limit=100')
    },
  }
}
