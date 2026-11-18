import { planoPorCentavos, precoCentavos, type PlanoPago } from './asaas_planos.ts'
import type { Ambiente, Bloqueio, EstadoCancelamento, EventoDb, Recorrencia, ReservaCheckout, StatusAssinatura } from './asaas_db.ts'
import { instanteAnterior, somarMesIso } from './asaas_datas.ts'

export interface LinhaAssinatura {
  id: string
  ambiente: Ambiente
  userId: string
  subscriptionId: string | null
  checkoutId: string | null
  plano: PlanoPago
  /** Espelho do que a página lê. Quem decide acesso é recorrencia + bloqueio + data. */
  status: StatusAssinatura
  recorrencia: Recorrencia
  bloqueio: Bloqueio | null
  reserva: ReservaCheckout
  trialAte: string | null
  pagoAte: string | null
  ultimoEventoEm: string | null
  precoCentavos: number | null
  nextDuePlanejado: string | null
  resultadoIncerto: boolean
  /** Preenchido quando a intenção foi gravada antes do POST. A expiração não apaga essa linha. */
  envioEm: string | null
  criadoEm: string
  atualizadoEm: string
}

const STATUS_ABERTO = new Set<StatusAssinatura>([
  'trial', 'ativa', 'inadimplente', 'suspensa', 'cancelamento_solicitado', 'divergente',
])

const HISTORICO_TRIAL = new Set<StatusAssinatura>([
  'trial', 'ativa', 'inadimplente', 'suspensa', 'cancelamento_solicitado', 'cancelada', 'divergente',
])

export interface AchoLinha {
  linha: LinhaAssinatura | null
  ignorado: boolean
}

export interface ContextoTransicao {
  linhas: LinhaAssinatura[]
  trials: Set<string>
}

export function centavosDe(valor: number | null): number | null {
  if (valor === null || !Number.isFinite(valor)) return null
  const centavos = Math.round(valor * 100)
  if (!Number.isSafeInteger(centavos)) return null
  return centavos
}

export function maiorData(atual: string | null, novo: string | null): string | null {
  if (!atual) return novo
  if (!novo) return atual
  return atual >= novo ? atual : novo
}

/** Diferença de calendário de 0 ou 1 dia. Datas YYYY-MM-DD, sem fuso. */
export function datasDentroDaTolerancia(evento: string | null, planejado: string | null): boolean {
  if (!evento || !planejado) return false
  const a = Date.parse(evento + 'T00:00:00Z')
  const b = Date.parse(planejado + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= 86_400_000
}

export function chaveTrial(ambiente: Ambiente, userId: string): string {
  return ambiente + ':' + userId
}

/** Status exibido. Bloqueio ganha da recorrência: suspensa cancelada continua suspensa. */
export function derivarStatus(linha: {
  recorrencia: Recorrencia
  bloqueio: Bloqueio | null
  trialAte: string | null
  pagoAte: string | null
}): StatusAssinatura {
  if (linha.bloqueio) return linha.bloqueio
  if (linha.recorrencia === 'pendente') return 'checkout'
  if (linha.recorrencia === 'cancelamento_pendente') return 'cancelamento_solicitado'
  if (linha.recorrencia === 'encerrada') return 'cancelada'
  if (linha.trialAte && !linha.pagoAte) return 'trial'
  return 'ativa'
}

/** Traduz o status legado que os testes gravam direto na linha. */
export function eixosDoStatus(status: StatusAssinatura): { recorrencia: Recorrencia, bloqueio: Bloqueio | null } {
  if (status === 'checkout') return { recorrencia: 'pendente', bloqueio: null }
  if (status === 'cancelamento_solicitado') return { recorrencia: 'cancelamento_pendente', bloqueio: null }
  if (status === 'cancelada') return { recorrencia: 'encerrada', bloqueio: null }
  if (status === 'inadimplente' || status === 'suspensa' || status === 'divergente') {
    return { recorrencia: 'ativa', bloqueio: status }
  }
  return { recorrencia: 'ativa', bloqueio: null }
}

function recorrenciaValida(valor: string | undefined): valor is Recorrencia {
  return valor === 'pendente' || valor === 'ativa' || valor === 'cancelamento_pendente' || valor === 'encerrada'
}

/**
 * Se o teste escreveu `status` por fora, os eixos acompanham esse status.
 * Se os eixos já batem com o status, eles mandam (suspensa encerrada não vira cancelada).
 */
export function alinharLinha(linha: LinhaAssinatura): void {
  if (!recorrenciaValida(linha.recorrencia)) {
    const eixos = eixosDoStatus(linha.status)
    linha.recorrencia = eixos.recorrencia
    linha.bloqueio = eixos.bloqueio
  }
  if (linha.reserva !== 'aberta' && linha.reserva !== 'enviando' && linha.reserva !== 'incerta' && linha.reserva !== 'expirada') {
    linha.reserva = linha.resultadoIncerto ? 'incerta' : 'aberta'
  }
  const derivado = derivarStatus(linha)
  if (linha.status !== derivado) {
    const eixos = eixosDoStatus(linha.status)
    linha.recorrencia = eixos.recorrencia
    linha.bloqueio = eixos.bloqueio
    linha.status = derivarStatus(linha)
  }
}

export function publicarStatus(linha: LinhaAssinatura): void {
  linha.status = derivarStatus(linha)
}

/**
 * Inadimplente não tem carência: bloqueia como suspensa e divergente.
 * Encerrar a recorrência não cria acesso. A data precisa estar no futuro.
 */
export function concederAcesso(linha: LinhaAssinatura, hoje: string): boolean {
  if (linha.bloqueio) return false
  const fim = linha.pagoAte || linha.trialAte
  if (!fim || fim < hoje) return false
  return linha.recorrencia === 'ativa'
    || linha.recorrencia === 'cancelamento_pendente'
    || linha.recorrencia === 'encerrada'
}

export function podeCancelar(linha: LinhaAssinatura): boolean {
  if (!linha.subscriptionId) return false
  return linha.recorrencia === 'ativa' || linha.recorrencia === 'pendente'
}

/**
 * Lease ativo ou cancelamento já concluído escondem o botão.
 * `falhou` ou lease vencido devolvem os dois sinais para a página tentar de novo.
 */
export function decisaoCancelamento(
  linha: LinhaAssinatura | null,
  op: { estado: EstadoCancelamento, leaseAte: string | null } | null,
  agoraMs: number,
): { pode_cancelar: boolean, pode_tentar_de_novo: boolean } {
  if (!linha?.subscriptionId) return { pode_cancelar: false, pode_tentar_de_novo: false }
  if (linha.recorrencia === 'ativa' || linha.recorrencia === 'pendente') {
    return { pode_cancelar: true, pode_tentar_de_novo: false }
  }
  if (linha.recorrencia !== 'cancelamento_pendente') return { pode_cancelar: false, pode_tentar_de_novo: false }
  const leaseVivo = !!op && op.estado === 'pendente' && !!op.leaseAte && Date.parse(op.leaseAte) > agoraMs
  if (leaseVivo || op?.estado === 'concluido') return { pode_cancelar: false, pode_tentar_de_novo: false }
  return { pode_cancelar: true, pode_tentar_de_novo: true }
}

export function historicoDeTrial(linhas: LinhaAssinatura[], atual: LinhaAssinatura, trials: Set<string>): boolean {
  if (trials.has(chaveTrial(atual.ambiente, atual.userId))) return true
  return linhas.some((linha) =>
    linha !== atual
    && linha.id !== atual.id
    && linha.ambiente === atual.ambiente
    && linha.userId === atual.userId
    && (HISTORICO_TRIAL.has(linha.status) || !!linha.subscriptionId || !!linha.trialAte || !!linha.pagoAte
      || linha.recorrencia === 'encerrada' || linha.bloqueio !== null)
  )
}

/**
 * Sem fallback para "outra assinatura aberta do customer".
 * Liga subscription_id a linha pendente só com checkout_id ou externalReference
 * e com o customer da linha. Reserva expirada continua achável por esses ids.
 * Subscription que não bate é ignorada.
 */
export function acharLinha(linhas: LinhaAssinatura[], evento: EventoDb, userId: string | null): AchoLinha {
  const doAmbiente = linhas.filter((linha) => linha.ambiente === evento.ambiente)
  const porSub = evento.subscriptionId
    ? doAmbiente.find((linha) => linha.subscriptionId === evento.subscriptionId) ?? null
    : null
  const porCheckout = evento.checkoutId
    ? doAmbiente.find((linha) => linha.checkoutId === evento.checkoutId) ?? null
    : null
  const porRef = evento.externalReference
    ? doAmbiente.find((linha) => linha.id === evento.externalReference) ?? null
    : null
  if (porCheckout && porRef && porCheckout.id !== porRef.id) return { linha: null, ignorado: true }
  const porChave = porCheckout ?? porRef
  if (porSub && porChave && porSub.id !== porChave.id) return { linha: null, ignorado: true }
  if (porSub) {
    if (userId && porSub.userId !== userId) return { linha: null, ignorado: true }
    return { linha: porSub, ignorado: false }
  }
  if (porChave) {
    if (!userId || porChave.userId !== userId) return { linha: null, ignorado: true }
    if (evento.subscriptionId && porChave.subscriptionId && porChave.subscriptionId !== evento.subscriptionId) {
      return { linha: null, ignorado: true }
    }
    return { linha: porChave, ignorado: false }
  }
  if (evento.subscriptionId && userId) {
    const outra = doAmbiente.some((linha) =>
      linha.userId === userId
      && linha.recorrencia !== 'encerrada'
      && linha.status !== 'cancelada'
      && linha.subscriptionId !== evento.subscriptionId
    )
    if (outra) return { linha: null, ignorado: true }
  }
  return { linha: null, ignorado: false }
}

function novaLinha(base: Omit<LinhaAssinatura, 'criadoEm' | 'atualizadoEm' | 'precoCentavos' | 'nextDuePlanejado' | 'resultadoIncerto' | 'reserva' | 'envioEm'> & {
  quando: string
  precoCentavos?: number | null
  nextDuePlanejado?: string | null
}): LinhaAssinatura {
  const linha: LinhaAssinatura = {
    id: base.id,
    ambiente: base.ambiente,
    userId: base.userId,
    subscriptionId: base.subscriptionId,
    checkoutId: base.checkoutId,
    plano: base.plano,
    status: base.status,
    recorrencia: base.recorrencia,
    bloqueio: base.bloqueio,
    reserva: 'aberta',
    trialAte: base.trialAte,
    pagoAte: base.pagoAte,
    ultimoEventoEm: base.ultimoEventoEm,
    precoCentavos: base.precoCentavos ?? null,
    nextDuePlanejado: base.nextDuePlanejado ?? null,
    resultadoIncerto: false,
    envioEm: null,
    criadoEm: base.quando,
    atualizadoEm: base.quando,
  }
  publicarStatus(linha)
  return linha
}

function comIds(linha: LinhaAssinatura, evento: EventoDb): Pick<LinhaAssinatura, 'subscriptionId' | 'checkoutId'> {
  return {
    subscriptionId: linha.subscriptionId ?? evento.subscriptionId,
    checkoutId: linha.checkoutId ?? evento.checkoutId,
  }
}

export interface Transicao {
  linha: LinhaAssinatura | null
  mudou: boolean
  motivo: 'ok' | 'sem_linha' | 'terminal' | 'antigo' | 'desconhecido'
}

/**
 * Espelho da RPC chat_private.asaas_aplicar_evento.
 * Recorrência encerrada não reabre e PAYMENT_CONFIRMED não estende pago_ate.
 * Estorno, chargeback, atraso e captura recusada ainda gravam o bloqueio.
 * Encerrar não apaga bloqueio. pago_ate confirmado, fora do encerramento, nunca encolhe.
 * CREATED/CHECKOUT_PAID só viram trial a partir da reserva, inclusive expirada.
 */
export function transicionar(
  linha: LinhaAssinatura | null,
  evento: EventoDb,
  userId: string | null,
  ctx: ContextoTransicao = { linhas: [], trials: new Set() },
): Transicao {
  if (linha) alinharLinha(linha)
  const tipo = evento.tipo
  const estorno = tipo === 'PAYMENT_REFUNDED' || tipo === 'PAYMENT_CHARGEBACK_REQUESTED'
  if (linha && !estorno && instanteAnterior(evento.quando, linha.ultimoEventoEm)) return { linha, mudou: false, motivo: 'antigo' }
  const encerrada = linha?.recorrencia === 'encerrada'
  if (tipo === 'SUBSCRIPTION_CREATED' || tipo === 'CHECKOUT_PAID') {
    if (encerrada) return { linha, mudou: false, motivo: 'terminal' }
    return paraTrial(linha, evento, userId, ctx)
  }
  if (tipo === 'PAYMENT_CONFIRMED' || tipo === 'PAYMENT_RECEIVED') {
    if (encerrada) return { linha, mudou: false, motivo: 'terminal' }
    return paraPaga(linha, evento, userId)
  }
  if (tipo === 'PAYMENT_OVERDUE' || tipo === 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED') {
    return aplicarBloqueio(linha, evento, 'inadimplente')
  }
  if (tipo === 'PAYMENT_REFUNDED' || tipo === 'PAYMENT_CHARGEBACK_REQUESTED') {
    return aplicarBloqueio(linha, evento, 'suspensa')
  }
  if (tipo === 'SUBSCRIPTION_INACTIVATED' || tipo === 'SUBSCRIPTION_DELETED') return encerrar(linha, evento)
  return { linha, mudou: false, motivo: 'desconhecido' }
}

function aplicarBloqueio(linha: LinhaAssinatura | null, evento: EventoDb, bloqueio: Bloqueio): Transicao {
  if (!linha) return { linha: null, mudou: false, motivo: 'sem_linha' }
  const atual = linha.bloqueio
  const proximo: Bloqueio = bloqueio === 'inadimplente' && (atual === 'suspensa' || atual === 'divergente')
    ? atual
    : bloqueio
  const ultimo = linha.ultimoEventoEm && instanteAnterior(evento.quando, linha.ultimoEventoEm)
    ? linha.ultimoEventoEm
    : evento.quando
  const next: LinhaAssinatura = {
    ...linha,
    ...comIds(linha, evento),
    bloqueio: proximo,
    resultadoIncerto: false,
    ultimoEventoEm: ultimo,
    atualizadoEm: evento.quando,
  }
  publicarStatus(next)
  return { mudou: true, motivo: 'ok', linha: next }
}

function encerrar(linha: LinhaAssinatura | null, evento: EventoDb): Transicao {
  if (!linha) return { linha: null, mudou: false, motivo: 'sem_linha' }
  if (linha.recorrencia === 'encerrada') return { linha, mudou: false, motivo: 'terminal' }
  const next: LinhaAssinatura = {
    ...linha,
    ...comIds(linha, evento),
    recorrencia: 'encerrada',
    resultadoIncerto: false,
    ultimoEventoEm: evento.quando,
    atualizadoEm: evento.quando,
  }
  publicarStatus(next)
  return { mudou: true, motivo: 'ok', linha: next }
}

function paraDivergente(linha: LinhaAssinatura, evento: EventoDb): Transicao {
  const ids = comIds(linha, evento)
  const recorrencia: Recorrencia = linha.recorrencia === 'cancelamento_pendente' || linha.recorrencia === 'encerrada'
    ? linha.recorrencia
    : 'ativa'
  const next: LinhaAssinatura = {
    ...linha,
    ...ids,
    recorrencia,
    bloqueio: 'divergente',
    reserva: 'aberta',
    resultadoIncerto: false,
    ultimoEventoEm: evento.quando,
    atualizadoEm: evento.quando,
  }
  publicarStatus(next)
  return { mudou: true, motivo: 'ok', linha: next }
}

function paraTrial(linha: LinhaAssinatura | null, evento: EventoDb, userId: string | null, ctx: ContextoTransicao): Transicao {
  if (!linha || linha.status !== 'checkout' || linha.recorrencia !== 'pendente') {
    if (!linha) return { linha: null, mudou: false, motivo: 'sem_linha' }
    const ids = comIds(linha, evento)
    const mudouIds = ids.subscriptionId !== linha.subscriptionId || ids.checkoutId !== linha.checkoutId
    const next: LinhaAssinatura = {
      ...linha, ...ids, resultadoIncerto: false, ultimoEventoEm: evento.quando, atualizadoEm: evento.quando,
    }
    publicarStatus(next)
    return { mudou: mudouIds, motivo: 'ok', linha: next }
  }
  const catalogo = precoCentavos(linha.plano)
  const centavos = centavosDe(evento.valor)
  const precoOk = linha.precoCentavos !== null && linha.precoCentavos === catalogo && centavos === linha.precoCentavos
  const dataOk = datasDentroDaTolerancia(evento.nextDue, linha.nextDuePlanejado)
  if (!precoOk || !dataOk || !userId || userId !== linha.userId || historicoDeTrial(ctx.linhas, linha, ctx.trials)) {
    return paraDivergente(linha, evento)
  }
  ctx.trials.add(chaveTrial(linha.ambiente, linha.userId))
  const next: LinhaAssinatura = {
    ...linha,
    ...comIds(linha, evento),
    recorrencia: 'ativa',
    bloqueio: null,
    reserva: 'aberta',
    trialAte: evento.nextDue,
    resultadoIncerto: false,
    ultimoEventoEm: evento.quando,
    atualizadoEm: evento.quando,
  }
  publicarStatus(next)
  return { mudou: true, motivo: 'ok', linha: next }
}

function paraPaga(linha: LinhaAssinatura | null, evento: EventoDb, userId: string | null): Transicao {
  const pago = evento.vencimento ? somarMesIso(evento.vencimento) : null
  if (!linha) {
    const plano = planoPorCentavos(centavosDe(evento.valor))
    if (!userId || !plano || !pago) return { linha: null, mudou: false, motivo: 'sem_linha' }
    return {
      mudou: true,
      motivo: 'ok',
      linha: novaLinha({
        id: crypto.randomUUID(),
        ambiente: evento.ambiente,
        userId,
        subscriptionId: evento.subscriptionId,
        checkoutId: evento.checkoutId,
        plano,
        status: 'ativa',
        recorrencia: 'ativa',
        bloqueio: null,
        trialAte: null,
        pagoAte: pago,
        ultimoEventoEm: evento.quando,
        quando: evento.quando,
        precoCentavos: precoCentavos(plano),
      }),
    }
  }
  const ids = comIds(linha, evento)
  const centavos = centavosDe(evento.valor)
  if (centavos === null || centavos !== precoCentavos(linha.plano)) {
    return paraDivergente(linha, evento)
  }
  const recorrencia: Recorrencia = linha.recorrencia === 'cancelamento_pendente' ? 'cancelamento_pendente' : 'ativa'
  const bloqueio = linha.recorrencia === 'cancelamento_pendente' ? linha.bloqueio : null
  const next: LinhaAssinatura = {
    ...linha,
    ...ids,
    recorrencia,
    bloqueio,
    reserva: 'aberta',
    pagoAte: maiorData(linha.pagoAte, pago),
    resultadoIncerto: false,
    ultimoEventoEm: evento.quando,
    atualizadoEm: evento.quando,
  }
  publicarStatus(next)
  return { mudou: true, motivo: 'ok', linha: next }
}

export function assinaturaAberta(status: StatusAssinatura): boolean {
  return STATUS_ABERTO.has(status)
}

export function acessoDaLinha(linha: LinhaAssinatura): string | null {
  return linha.pagoAte || linha.trialAte
}
