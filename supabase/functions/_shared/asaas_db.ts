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

/** Reserva de checkout. `enviando` é a intenção gravada antes do POST. Expirada continua correlacionável. */
export type ReservaCheckout = 'aberta' | 'enviando' | 'incerta' | 'expirada'

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
  /** Geração observada no preparar. A liberação só vale com este número. */
  geracao?: number
}

export interface StatusPublico {
  plano: 'free' | PlanoPago
  status: 'free' | StatusAssinatura
  trial_ate: string | null
  pago_ate: string | null
  acesso_ate: string | null
  pode_cancelar: boolean
  /** Operação falhou ou o lease venceu: a página mostra nova tentativa. */
  pode_tentar_de_novo: boolean
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
  /** Identidade da tentativa. Conclusão e falha só gravam se ela ainda for a atual. */
  tentativaId?: string
}

export interface AsaasDb {
  prepararCheckout(ambiente: Ambiente, userId: string, plano: PlanoPago, nextDue?: string | null): Promise<PrepCheckout>
  /**
   * Depois das consultas vazias. Exige a geração lida no preparar.
   * Recusa se ela mudou ou se há reserva aberta, enviando ou incerta.
   */
  liberarCheckout(ambiente: Ambiente, userId: string, plano: PlanoPago, nextDue: string | null | undefined, geracao: number): Promise<PrepCheckout>
  vincularCheckout(ambiente: Ambiente, userId: string, assinaturaId: string, checkoutId: string): Promise<void>
  /** Liga a assinatura remota à reserva antiga. Não grava data de acesso. */
  vincularAssinaturaRemota(ambiente: Ambiente, userId: string, assinaturaId: string, subscriptionId: string): Promise<void>
  descartarCheckout(ambiente: Ambiente, userId: string, assinaturaId: string): Promise<void>
  /** Intenção gravada antes do POST. O id da linha é o externalReference. Não apaga a linha. */
  marcarCheckoutEnviando(ambiente: Ambiente, userId: string, assinaturaId: string): Promise<void>
  /**
   * Só depois de 4xx definitivo do POST: o provedor respondeu que não criou.
   * Não serve para timeout, 5xx nem processo morto.
   */
  descartarEnvioRecusado(ambiente: Ambiente, userId: string, assinaturaId: string): Promise<void>
  marcarCheckoutIncerto(ambiente: Ambiente, userId: string, assinaturaId: string): Promise<void>
  obterCliente(ambiente: Ambiente, userId: string): Promise<string | null>
  gravarCliente(ambiente: Ambiente, userId: string, customerId: string): Promise<void>
  aplicarEvento(evento: EventoDb): Promise<{ aplicado: boolean, duplicado: boolean }>
  lerStatus(ambiente: Ambiente, userId: string): Promise<StatusPublico>
  pedirCancelamento(ambiente: Ambiente, userId: string): Promise<CancelPrep>
  /** Devolve false se a tentativa não é mais a atual. */
  marcarCancelamento(ambiente: Ambiente, userId: string, subscriptionId: string, tentativaId: string): Promise<boolean>
  /** Devolve false se a tentativa não é mais a atual. */
  falharCancelamento(ambiente: Ambiente, userId: string, subscriptionId: string, tentativaId: string): Promise<boolean>
}
