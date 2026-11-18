import type { Ambiente, AsaasDb, EstadoCancelamento, StatusPublico } from './asaas_db.ts'
import { CHECKOUT_MINUTOS, precoCentavos, type PlanoPago } from './asaas_planos.ts'
import { dataIsoNoFuso } from './asaas_datas.ts'
import {
  acessoDaLinha, acharLinha, alinharLinha, concederAcesso, derivarStatus, podeCancelar, publicarStatus, transicionar,
  type LinhaAssinatura,
} from './asaas_estado.ts'

const PROIBIDAS = ['credit_balances', 'credit_ledger', 'free_quota_daily', 'unlimited_users']
const JANELA_MS = CHECKOUT_MINUTOS * 60 * 1000
const LEASE_MS = 90_000

export interface CancelamentoMem {
  ambiente: Ambiente
  userId: string
  assinaturaId: string
  subscriptionId: string
  estado: EstadoCancelamento
  tentativas: number
  leaseAte: string | null
}

export function criarMemoriaAsaas(now: () => Date = () => new Date()) {
  const linhas: LinhaAssinatura[] = []
  const clientes = new Map<string, string>()
  const porCliente = new Map<string, string>()
  const eventos = new Set<string>()
  const trials = new Set<string>()
  const cancelamentos: CancelamentoMem[] = []
  const tocadas: string[] = []
  let transicoes = 0

  const tocar = (nome: string) => {
    if (PROIBIDAS.some((item) => nome.includes(item))) throw new Error('tabela do chat')
    tocadas.push(nome)
  }

  const hoje = () => dataIsoNoFuso(now(), 'America/Sao_Paulo')
  const iso = () => now().toISOString()
  const alinhar = () => { for (const linha of linhas) alinharLinha(linha) }
  const lease = () => new Date(now().getTime() + LEASE_MS).toISOString()

  const aberta = (linha: LinhaAssinatura) =>
    linha.recorrencia === 'ativa' || linha.recorrencia === 'cancelamento_pendente'
    || (linha.subscriptionId !== null && linha.recorrencia !== 'encerrada')

  const historico = (linha: LinhaAssinatura) =>
    linha.recorrencia === 'ativa' || linha.recorrencia === 'cancelamento_pendente' || linha.recorrencia === 'encerrada'
    || linha.subscriptionId !== null || linha.trialAte !== null || linha.pagoAte !== null || linha.bloqueio !== null

  const dentro = (linha: LinhaAssinatura) => Date.parse(linha.atualizadoEm) > now().getTime() - JANELA_MS

  const db: AsaasDb = {
    async prepararCheckout(ambiente, userId, plano, nextDue = null) {
      tocar('chat_private.asaas_preparar_checkout')
      alinhar()
      const minhas = linhas.filter((linha) => linha.ambiente === ambiente && linha.userId === userId)
      if (minhas.some(aberta)) return { ok: false, code: 'assinatura_ativa' }
      if (minhas.some(historico) || trials.has(ambiente + ':' + userId)) return { ok: false, code: 'trial_ja_usado' }
      const reutil = minhas.find((linha) =>
        linha.recorrencia === 'pendente' && linha.reserva !== 'expirada' && linha.checkoutId && dentro(linha)
      )
      if (reutil) return { ok: true, assinaturaId: reutil.id, checkoutId: reutil.checkoutId, reutilizado: true }
      if (minhas.some((linha) =>
        linha.recorrencia === 'pendente' && linha.reserva !== 'expirada' && !linha.checkoutId && dentro(linha)
      )) {
        return { ok: false, code: 'checkout_em_andamento' }
      }
      for (const linha of minhas) {
        if (linha.recorrencia === 'pendente' && linha.reserva !== 'expirada' && !dentro(linha)
          && (linha.checkoutId || linha.resultadoIncerto || linha.reserva === 'incerta')) {
          linha.reserva = 'expirada'
          linha.atualizadoEm = iso()
        }
      }
      const expiradas = minhas.filter((linha) => linha.recorrencia === 'pendente' && linha.reserva === 'expirada')
      if (expiradas.length) {
        expiradas.sort((a, b) => Number(!!b.checkoutId) - Number(!!a.checkoutId) || b.atualizadoEm.localeCompare(a.atualizadoEm))
        return { ok: false, code: 'reconciliar', assinaturaId: expiradas[0].id }
      }
      for (let i = linhas.length - 1; i >= 0; i--) {
        const linha = linhas[i]
        if (linha.ambiente === ambiente && linha.userId === userId && linha.recorrencia === 'pendente'
          && linha.reserva === 'aberta' && !linha.checkoutId && !linha.resultadoIncerto && !dentro(linha)) {
          linhas.splice(i, 1)
        }
      }
      return inserirPendente(ambiente, userId, plano, nextDue)
    },
    async liberarCheckout(ambiente, userId, plano, nextDue = null) {
      tocar('chat_private.asaas_liberar_checkout')
      alinhar()
      const minhas = linhas.filter((linha) => linha.ambiente === ambiente && linha.userId === userId)
      if (minhas.some(aberta)) return { ok: false, code: 'assinatura_ativa' }
      if (minhas.some((linha) => linha.recorrencia === 'pendente' && linha.reserva === 'aberta' && dentro(linha))) {
        return { ok: false, code: 'checkout_em_andamento' }
      }
      return inserirPendente(ambiente, userId, plano, nextDue)
    },
    async vincularCheckout(ambiente, userId, assinaturaId, checkoutId) {
      tocar('chat_private.asaas_vincular_checkout')
      alinhar()
      const linha = linhas.find((item) => item.id === assinaturaId && item.userId === userId && item.ambiente === ambiente && item.recorrencia === 'pendente')
      if (!linha) throw new Error('checkout_ausente')
      linha.checkoutId = checkoutId
      linha.resultadoIncerto = false
      linha.reserva = 'aberta'
      linha.atualizadoEm = iso()
      publicarStatus(linha)
    },
    async vincularAssinaturaRemota(ambiente, userId, assinaturaId, subscriptionId) {
      tocar('chat_private.asaas_vincular_assinatura_remota')
      alinhar()
      const linha = linhas.find((item) => item.id === assinaturaId && item.userId === userId && item.ambiente === ambiente)
      if (!linha || linha.recorrencia === 'encerrada') throw new Error('checkout_ausente')
      if (linhas.some((item) => item !== linha && item.ambiente === ambiente && item.subscriptionId === subscriptionId)) {
        throw new Error('sub_duplicada')
      }
      linha.subscriptionId = subscriptionId
      linha.recorrencia = 'ativa'
      linha.atualizadoEm = iso()
      publicarStatus(linha)
    },
    async descartarCheckout(ambiente, userId, assinaturaId) {
      tocar('chat_private.asaas_descartar_checkout')
      alinhar()
      const indice = linhas.findIndex((item) =>
        item.id === assinaturaId && item.userId === userId && item.ambiente === ambiente
        && item.recorrencia === 'pendente' && item.reserva === 'aberta' && !item.checkoutId && !item.resultadoIncerto
      )
      if (indice >= 0) linhas.splice(indice, 1)
    },
    async marcarCheckoutIncerto(ambiente, userId, assinaturaId) {
      tocar('chat_private.asaas_marcar_checkout_incerto')
      alinhar()
      const linha = linhas.find((item) => item.id === assinaturaId && item.userId === userId && item.ambiente === ambiente && item.recorrencia === 'pendente')
      if (!linha) return
      linha.resultadoIncerto = true
      linha.reserva = 'incerta'
      linha.atualizadoEm = iso()
    },
    async obterCliente(ambiente, userId) {
      tocar('chat_private.asaas_obter_cliente')
      return clientes.get(ambiente + ':' + userId) ?? null
    },
    async gravarCliente(ambiente, userId, customerId) {
      tocar('chat_private.asaas_gravar_cliente')
      const chave = ambiente + ':' + userId
      if (!clientes.has(chave)) {
        clientes.set(chave, customerId)
        porCliente.set(ambiente + ':' + customerId, userId)
      }
    },
    async aplicarEvento(evento) {
      tocar('chat_private.asaas_aplicar_evento')
      alinhar()
      const chave = evento.ambiente + ':' + evento.eventId
      if (eventos.has(chave)) return { aplicado: false, duplicado: true }
      eventos.add(chave)
      const userId = evento.customerId ? porCliente.get(evento.ambiente + ':' + evento.customerId) ?? null : null
      const achado = acharLinha(linhas, evento, userId)
      if (achado.ignorado) return { aplicado: true, duplicado: false }
      const atual = achado.linha
      const resultado = transicionar(atual, evento, userId, { linhas, trials })
      if (resultado.linha && resultado.linha !== atual) {
        if (!atual) linhas.push(resultado.linha)
        else Object.assign(atual, resultado.linha)
      }
      if (resultado.mudou) transicoes += 1
      return { aplicado: true, duplicado: false }
    },
    async lerStatus(ambiente, userId) {
      tocar('chat_private.asaas_status')
      alinhar()
      const minhas = linhas.filter((linha) => linha.ambiente === ambiente && linha.userId === userId)
      minhas.sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm))
      return statusDe(minhas[0] ?? null, hoje())
    },
    async pedirCancelamento(ambiente, userId) {
      tocar('chat_private.asaas_pedir_cancelamento')
      alinhar()
      const minhas = linhas.filter((linha) => linha.ambiente === ambiente && linha.userId === userId && linha.subscriptionId)
      const alvo = minhas.find((linha) => linha.recorrencia !== 'encerrada')
      if (alvo?.subscriptionId) {
        const op = cancelamentos.find((item) => item.ambiente === ambiente && item.assinaturaId === alvo.id)
        if (op?.estado === 'concluido') {
          return { ok: true, ja: true, status: alvo.status, subscriptionId: alvo.subscriptionId, acesso_ate: alvo.pagoAte || alvo.trialAte, estado: 'concluido' as const }
        }
        if (op?.estado === 'pendente' && op.leaseAte && Date.parse(op.leaseAte) > now().getTime()) {
          return {
            ok: true, ja: false, code: 'cancelamento_em_andamento' as const, refazer: false,
            status: alvo.status, subscriptionId: alvo.subscriptionId, acesso_ate: alvo.pagoAte || alvo.trialAte, estado: op.estado,
          }
        }
        const anterior = alvo.status
        if (!op) {
          alvo.recorrencia = 'cancelamento_pendente'
          alvo.atualizadoEm = iso()
          publicarStatus(alvo)
          cancelamentos.push({
            ambiente, userId, assinaturaId: alvo.id, subscriptionId: alvo.subscriptionId,
            estado: 'pendente', tentativas: 1, leaseAte: lease(),
          })
          return {
            ok: true, ja: false, refazer: false, status: alvo.status, statusAnterior: anterior,
            subscriptionId: alvo.subscriptionId, acesso_ate: alvo.pagoAte || alvo.trialAte, estado: 'pendente' as const,
          }
        }
        op.estado = 'pendente'
        op.tentativas += 1
        op.leaseAte = lease()
        op.subscriptionId = alvo.subscriptionId
        return {
          ok: true, ja: false, refazer: true, status: alvo.status, statusAnterior: anterior,
          subscriptionId: alvo.subscriptionId, acesso_ate: alvo.pagoAte || alvo.trialAte, estado: 'pendente' as const,
        }
      }
      const encerrada = minhas.find((linha) => linha.recorrencia === 'encerrada')
      if (encerrada?.subscriptionId) {
        const op = cancelamentos.find((item) => item.ambiente === ambiente && item.assinaturaId === encerrada.id)
        if (op && op.estado !== 'concluido') {
          op.estado = 'concluido'
          op.leaseAte = null
        }
        return { ok: true, ja: true, status: encerrada.status, subscriptionId: encerrada.subscriptionId, acesso_ate: encerrada.pagoAte || encerrada.trialAte, estado: 'concluido' as const }
      }
      return { ok: false, code: 'sem_assinatura' as const }
    },
    async marcarCancelamento(ambiente, userId, subscriptionId) {
      tocar('chat_private.asaas_marcar_cancelamento')
      alinhar()
      const op = cancelamentos.find((item) => item.ambiente === ambiente && item.userId === userId && item.subscriptionId === subscriptionId)
      if (op && op.estado !== 'concluido') {
        op.estado = 'concluido'
        op.leaseAte = null
      }
      const linha = linhas.find((item) => item.ambiente === ambiente && item.userId === userId && item.subscriptionId === subscriptionId)
      if (!linha || linha.recorrencia === 'encerrada') return
      linha.recorrencia = 'cancelamento_pendente'
      linha.atualizadoEm = iso()
      publicarStatus(linha)
    },
    async falharCancelamento(ambiente, userId, subscriptionId) {
      tocar('chat_private.asaas_falhar_cancelamento')
      const op = cancelamentos.find((item) => item.ambiente === ambiente && item.userId === userId && item.subscriptionId === subscriptionId)
      if (!op || op.estado !== 'pendente') return
      op.estado = 'falhou'
      op.leaseAte = null
    },
  }

  function inserirPendente(ambiente: Ambiente, userId: string, plano: PlanoPago, nextDue: string | null) {
    const quando = iso()
    const id = crypto.randomUUID()
    const linha: LinhaAssinatura = {
      id, ambiente, userId, subscriptionId: null, checkoutId: null, plano,
      status: 'checkout', recorrencia: 'pendente', bloqueio: null, reserva: 'aberta',
      trialAte: null, pagoAte: null, ultimoEventoEm: null,
      precoCentavos: precoCentavos(plano), nextDuePlanejado: nextDue, resultadoIncerto: false,
      criadoEm: quando, atualizadoEm: quando,
    }
    publicarStatus(linha)
    linhas.push(linha)
    return { ok: true, assinaturaId: id, checkoutId: null, reutilizado: false }
  }

  return {
    db,
    tocadas,
    linhas,
    cancelamentos,
    get transicoes() { return transicoes },
    get qtdEventos() { return eventos.size },
    anotarSubscription(userId: string, subscriptionId: string, ambiente: Ambiente = 'sandbox') {
      alinhar()
      const linha = linhas.find((item) => item.userId === userId && item.ambiente === ambiente && item.recorrencia !== 'encerrada')
      if (!linha) throw new Error('sem linha')
      linha.subscriptionId = subscriptionId
    },
  }
}

function statusDe(linha: LinhaAssinatura | null, hoje: string): StatusPublico {
  if (!linha) return livre()
  const fim = acessoDaLinha(linha)
  if (linha.recorrencia === 'encerrada' && !linha.bloqueio && (!fim || fim < hoje)) return livre()
  const vigente = concederAcesso(linha, hoje)
  return {
    plano: vigente ? linha.plano : 'free',
    status: linha.status,
    trial_ate: linha.trialAte,
    pago_ate: linha.pagoAte,
    acesso_ate: linha.pagoAte || linha.trialAte,
    pode_cancelar: podeCancelar(linha),
  }
}

function livre(): StatusPublico {
  return { plano: 'free', status: 'free', trial_ate: null, pago_ate: null, acesso_ate: null, pode_cancelar: false }
}

export type MemoriaAsaas = ReturnType<typeof criarMemoriaAsaas>
