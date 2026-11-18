import type { PlanoPago } from './asaas_planos.ts'

export type Ambiente = 'sandbox' | 'producao'

/** O que a página e o GET mostram. É derivado dos três eixos, não é a fonte da regra. */
export type StatusAssinatura =
  | 'checkout'
  | 'trial'
  | 'ativa'
  | 'inadimplente'
  | 'suspensa'
  | 'cancelamento_solicitado'
  | 'cancelada'
  | 'divergente'

/** Recorrência da cobrança. Encerrada é terminal só para este eixo. */
export type Recorrencia = 'pendente' | 'ativa' | 'cancelamento_pendente' | 'encerrada'

/** Bloqueio financeiro. NULL libera, se a data de acesso ainda valer. Inadimplente não tem carência. */
export type Bloqueio = 'inadimplente' | 'suspensa' | 'divergente'

/** Reserva de checkout. Expirada continua correlacionável. */
export type ReservaCheckout = 'aberta' | 'incerta' | 'expirada'

export type EstadoCancelamento = 'pendente' | 'concluido' | 'falhou'

export interface EventoDb {
  ambiente: Ambiente
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

export interface PrepCheckout {
  ok: boolean
  code?: 'trial_ja_usado' | 'assinatura_ativa' | 'checkout_em_andamento' | 'plano_invalido' | 'reconciliar'
  assinaturaId?: string
  checkoutId?: string | null
  reutilizado?: boolean
}

export interface StatusPublico {
  plano: 'free' | PlanoPago
  status: 'free' | StatusAssinatura
  trial_ate: string | null
  pago_ate: string | null
  acesso_ate: string | null
  pode_cancelar: boolean
}

export interface CancelPrep {
  ok: boolean
  code?: 'sem_assinatura' | 'cancelamento_em_andamento'
  ja?: boolean
  /** Lease vencido ou estado falhou: o handler consulta e refaz o DELETE. */
  refazer?: boolean
  status?: StatusAssinatura
  statusAnterior?: StatusAssinatura
  subscriptionId?: string
  acesso_ate?: string | null
  estado?: EstadoCancelamento
}

export interface AsaasDb {
  prepararCheckout(ambiente: Ambiente, userId: string, plano: PlanoPago, nextDue?: string | null): Promise<PrepCheckout>
  /** Depois do GET vazio. Não apaga a reserva expirada. */
  liberarCheckout(ambiente: Ambiente, userId: string, plano: PlanoPago, nextDue?: string | null): Promise<PrepCheckout>
  vincularCheckout(ambiente: Ambiente, userId: string, assinaturaId: string, checkoutId: string): Promise<void>
  /** Liga a assinatura remota à reserva antiga. Não grava data de acesso. */
  vincularAssinaturaRemota(ambiente: Ambiente, userId: string, assinaturaId: string, subscriptionId: string): Promise<void>
  descartarCheckout(ambiente: Ambiente, userId: string, assinaturaId: string): Promise<void>
  marcarCheckoutIncerto(ambiente: Ambiente, userId: string, assinaturaId: string): Promise<void>
  obterCliente(ambiente: Ambiente, userId: string): Promise<string | null>
  gravarCliente(ambiente: Ambiente, userId: string, customerId: string): Promise<void>
  aplicarEvento(evento: EventoDb): Promise<{ aplicado: boolean, duplicado: boolean }>
  lerStatus(ambiente: Ambiente, userId: string): Promise<StatusPublico>
  pedirCancelamento(ambiente: Ambiente, userId: string): Promise<CancelPrep>
  marcarCancelamento(ambiente: Ambiente, userId: string, subscriptionId: string): Promise<void>
  falharCancelamento(ambiente: Ambiente, userId: string, subscriptionId: string): Promise<void>
}
