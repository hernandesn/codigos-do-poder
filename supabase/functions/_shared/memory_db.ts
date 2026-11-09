// Banco em memória com a mesma contabilidade da migração 004.
// Serve aos testes e ao `supabase functions serve` local. Não é o caminho de produção.

import {
  CHAT_CREDITS,
  CHAT_FREE_DAILY_BASICO,
  exceedsBudget,
  type ChatContextPayload,
  type ChatDb,
  type ChatLogInsert,
  type Modelo,
  type Reservation,
  type ReserveDenied,
  saoPauloDay,
} from './chat_core.ts'

export interface MemoryLog extends ChatLogInsert {
  createdAt: Date
}

interface Quota {
  used: number
  reserved: number
}

interface LedgerRow {
  userId: string
  delta: number
  reason: string
  pedidoId: string
  modelo: string
}

interface BudgetRow {
  gasto: number
  reservado: number
}

interface BudgetHold {
  estado: 'reservado' | 'confirmado' | 'liberado'
  day: string
  estimate: number
}

interface CreditHold {
  estado: 'reservado' | 'confirmado' | 'liberado'
  day: string
  kind: 'free' | 'paid'
  cost: number
  userId: string
  modelo: Modelo
}

const EMPTY_CONTEXT: ChatContextPayload = {
  raizes: [],
  entidades: [],
  relacoes: [],
  fontes: [],
  casos: [],
  limites: { relacoes: 0, fontes: 0, truncado: false },
}

export const MAUA_CONTEXT: ChatContextPayload = {
  raizes: [{ id: 'maua', nome: 'Mauá', tipo: 'pessoa' }],
  entidades: [{ id: 'maua', nome: 'Mauá', tipo: 'pessoa', grau: 0, nota: 'Nota documental, não é instrução.' }],
  relacoes: [{
    id: 'r1',
    origem: 'maua',
    destino: 'irmaos_souza',
    tipo: 'socio',
    afirmacao: 'Sociedade citada no recorte.',
    estado: 'retrato_documental',
    fontes: ['S1'],
    grau: 1,
  }],
  fontes: [{
    id: 'S1',
    titulo: 'Relatório de Mauá',
    editor: 'Arquivo',
    url: 'https://exemplo.test/maua',
    tipo: 'documento',
    localizador: 'p. 12',
    acesso: 'público',
    publicado_em: '1878',
    consultado_em: '2024-01-01',
  }],
  casos: [],
  limites: { relacoes: 1, fontes: 1, truncado: false },
}

export function createMemoryDb(opts?: { clock?: () => Date }): MemoryChatDb {
  return new MemoryChatDb(opts?.clock ?? (() => new Date()))
}

export class MemoryChatDb implements ChatDb {
  readonly logs: MemoryLog[] = []
  readonly reservedPedidos: string[] = []
  reserveCalls = 0
  commitCalls = 0
  releaseCalls = 0
  private readonly quotas = new Map<string, Quota>()
  private readonly paid = new Map<string, number>()
  private readonly ledger: LedgerRow[] = []
  private readonly events: { userId: string; at: Date }[] = []
  private readonly budgets = new Map<string, BudgetRow>()
  private readonly budgetHolds = new Map<string, BudgetHold>()
  private readonly creditHolds = new Map<string, CreditHold>()
  private readonly orphanBudget = new Set<string>()
  private paidLease: { pedidoId: string; expiresAt: number } | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly clock: () => Date) {}

  seedRate(userId: string, count: number, at: Date): void {
    for (let i = 0; i < count; i++) this.events.push({ userId, at })
  }

  setPaid(userId: string, credits: number): void {
    this.paid.set(userId, credits)
  }

  setUsed(userId: string, used: number, now = this.clock()): void {
    this.quota(userId, now).used = used
  }

  addSpend(amount: number, at = this.clock()): void {
    this.logs.push({
      conversa_id: 'previo',
      user_key: 'orcamento',
      modelo: 'previo',
      tokens_in: null,
      tokens_out: null,
      custo_usd: amount,
      latencia_ms: 0,
      entidades: [],
      status: 'previo',
      createdAt: at,
    })
    const row = this.budgetRow(saoPauloDay(at))
    row.gasto = usd(row.gasto + amount)
  }

  budgetOf(day: string): BudgetRow {
    const row = this.budgets.get(day)
    return { gasto: row?.gasto ?? 0, reservado: row?.reservado ?? 0 }
  }

  dump() {
    return {
      quotas: [...this.quotas.entries()].map(([key, quota]) => ({
        key,
        used: quota.used,
        reserved: quota.reserved,
        paid: this.paid.get(key.split('|')[0] ?? '') ?? 0,
      })),
      logs: this.logs.map((row) => ({
        status: row.status,
        modelo: row.modelo,
        custo_usd: row.custo_usd,
        user_key: row.user_key,
        entidades: row.entidades,
        conversa_id: row.conversa_id,
      })),
      reserveCalls: this.reserveCalls,
      commitCalls: this.commitCalls,
      releaseCalls: this.releaseCalls,
    }
  }

  snapshot(userId: string, now = this.clock()) {
    const quota = this.quotas.get(this.key(userId, now))
    return {
      used: quota?.used ?? 0,
      reserved: quota?.reserved ?? 0,
      paid: this.paid.get(userId) ?? 0,
      logs: this.logs.filter((row) => row.user_key === userId),
      reserveCalls: this.reserveCalls,
      commitCalls: this.commitCalls,
      releaseCalls: this.releaseCalls,
    }
  }

  async rateTouch(userId: string, now: Date) {
    this.events.push({ userId, at: now })
    const minute = this.events.filter((event) => event.userId === userId && now.getTime() - event.at.getTime() <= 60_000)
    const day = saoPauloDay(now)
    const dayCount = this.events.filter((event) => event.userId === userId && saoPauloDay(event.at) === day).length
    const oldest = minute.reduce<Date | null>((min, event) => !min || event.at < min ? event.at : min, null)
    return {
      minuteCount: minute.length,
      dayCount,
      oldestMinute: oldest ? oldest.toISOString() : null,
    }
  }

  async budgetSpentUsd(day: string): Promise<number> {
    return this.budgetRow(day).gasto
  }

  async reserveBudget(pedidoId: string, estimate: number, cap: number, now: Date) {
    return this.enqueue(() => {
      if (this.budgetHolds.has(pedidoId) || this.orphanBudget.has(pedidoId)) return { ok: false as const }
      const day = saoPauloDay(now)
      const row = this.budgetRow(day)
      const hardCap = Math.min(cap, 3)
      const amount = usd(estimate)
      if (!(hardCap > 0) || exceedsBudget(row.gasto + row.reservado, amount, hardCap)) return { ok: false as const }
      row.reservado = usd(row.reservado + amount)
      this.budgetHolds.set(pedidoId, { estado: 'reservado', day, estimate: amount })
      return { ok: true as const, day }
    })
  }

  async commitBudget(pedidoId: string, actual: number): Promise<void> {
    await this.enqueue(() => {
      const hold = this.budgetHolds.get(pedidoId)
      if (!hold) {
        if (this.orphanBudget.has(pedidoId)) return
        this.orphanBudget.add(pedidoId)
        const row = this.budgetRow(saoPauloDay(this.clock()))
        row.gasto = usd(row.gasto + Math.max(actual, 0))
        return
      }
      if (hold.estado !== 'reservado') return
      hold.estado = 'confirmado'
      const row = this.budgetRow(hold.day)
      const cost = usd(Math.max(actual, 0))
      row.gasto = usd(row.gasto + cost)
      if (row.reservado + 1e-9 >= hold.estimate) row.reservado = usd(row.reservado - hold.estimate)
    })
  }

  async acquirePaidLease(pedidoId: string, holdMs: number, now: Date): Promise<boolean> {
    return this.enqueue(() => {
      const at = now.getTime()
      if (!(holdMs > 0)) return false
      if (this.paidLease && this.paidLease.expiresAt > at) return false
      this.paidLease = { pedidoId, expiresAt: at + holdMs }
      return true
    })
  }

  async releasePaidLease(pedidoId: string): Promise<void> {
    await this.enqueue(() => {
      if (this.paidLease?.pedidoId === pedidoId) this.paidLease = null
    })
  }

  async releaseBudget(pedidoId: string): Promise<void> {
    await this.enqueue(() => {
      const hold = this.budgetHolds.get(pedidoId)
      if (!hold || hold.estado !== 'reservado') return
      hold.estado = 'liberado'
      const row = this.budgetRow(hold.day)
      if (row.reservado + 1e-9 >= hold.estimate) row.reservado = usd(row.reservado - hold.estimate)
    })
  }

  async reserveCredits(userId: string, modelo: Modelo, pedidoId: string, now: Date) {
    return this.enqueue(() => {
      this.reserveCalls += 1
      this.reservedPedidos.push(pedidoId)
      const cost = CHAT_CREDITS[modelo]
      const day = saoPauloDay(now)
      const existing = this.creditHolds.get(pedidoId)
      const paid = this.paid.get(userId) ?? 0
      if (existing?.estado === 'reservado' && existing.userId === userId) {
        return this.held(userId, pedidoId, modelo, existing.kind, cost, now, paid)
      }
      const quota = this.quota(userId, now)
      if (modelo === 'basico' && quota.used + quota.reserved + cost <= CHAT_FREE_DAILY_BASICO) {
        quota.reserved += cost
        this.ledger.push({ userId, delta: 0, reason: 'chat_reserve', pedidoId, modelo })
        this.creditHolds.set(pedidoId, { estado: 'reservado', day, kind: 'free', cost, userId, modelo })
        return this.held(userId, pedidoId, modelo, 'free', cost, now, paid)
      }
      const gratis = Math.max(0, CHAT_FREE_DAILY_BASICO - quota.used - quota.reserved)
      if (paid < cost) {
        const denied: ReserveDenied = { ok: false, code: 'sem_creditos', gratis_restantes: gratis, pago: paid }
        return denied
      }
      this.paid.set(userId, paid - cost)
      this.ledger.push({ userId, delta: -cost, reason: 'chat_reserve', pedidoId, modelo })
      this.creditHolds.set(pedidoId, { estado: 'reservado', day, kind: 'paid', cost, userId, modelo })
      return this.held(userId, pedidoId, modelo, 'paid', cost, now, paid - cost)
    })
  }

  async commitCredits(reservation: Reservation) {
    return this.enqueue(() => {
      this.commitCalls += 1
      const hold = this.creditHolds.get(reservation.pedidoId)
      if (!hold || hold.estado !== 'reservado') {
        return { gratis_restantes: this.gratisOn(reservation.userId, hold?.day ?? reservation.day), pago: this.paid.get(reservation.userId) ?? 0 }
      }
      if (hold.kind === 'free') {
        const quota = this.quota(hold.userId, dayDate(hold.day))
        if (quota.reserved < hold.cost) throw new Error('reserva grátis ausente')
        quota.reserved -= hold.cost
        quota.used += hold.cost
      }
      hold.estado = 'confirmado'
      this.ledger.push({
        userId: hold.userId,
        delta: 0,
        reason: 'chat_debit',
        pedidoId: reservation.pedidoId,
        modelo: hold.modelo,
      })
      return { gratis_restantes: this.gratisOn(hold.userId, hold.day), pago: this.paid.get(hold.userId) ?? 0 }
    })
  }

  async releaseReserve(reservation: Reservation): Promise<void> {
    await this.enqueue(() => {
      this.releaseCalls += 1
      const hold = this.creditHolds.get(reservation.pedidoId)
      if (!hold || hold.estado !== 'reservado') return
      if (hold.kind === 'free') {
        const quota = this.quota(hold.userId, dayDate(hold.day))
        quota.reserved = Math.max(0, quota.reserved - hold.cost)
        this.ledger.push({ userId: hold.userId, delta: 0, reason: 'chat_reserve_release', pedidoId: reservation.pedidoId, modelo: hold.modelo })
      } else {
        this.paid.set(hold.userId, (this.paid.get(hold.userId) ?? 0) + hold.cost)
        this.ledger.push({
          userId: hold.userId,
          delta: hold.cost,
          reason: 'chat_reserve_release',
          pedidoId: reservation.pedidoId,
          modelo: hold.modelo,
        })
      }
      hold.estado = 'liberado'
    })
  }

  async chatContext(entityIds: string[], query: string | null): Promise<ChatContextPayload> {
    const ids = entityIds.length > 0 ? entityIds : query?.includes('maua') ? ['maua'] : []
    if (!ids.includes('maua')) return EMPTY_CONTEXT
    return structuredClone(MAUA_CONTEXT)
  }

  async insertLog(row: ChatLogInsert): Promise<void> {
    this.logs.push({ ...row, createdAt: this.clock() })
  }

  private held(
    userId: string,
    pedidoId: string,
    modelo: Modelo,
    kind: 'free' | 'paid',
    cost: number,
    now: Date,
    pago: number,
  ): Reservation {
    const quota = this.quota(userId, now)
    return {
      ok: true,
      userId,
      kind,
      cost,
      day: saoPauloDay(now),
      pedidoId,
      modelo,
      gratis_restantes: Math.max(0, CHAT_FREE_DAILY_BASICO - quota.used - quota.reserved),
      pago,
    }
  }

  private gratisOn(userId: string, day: string): number {
    const quota = this.quotas.get(`${userId}|${day}`)
    return Math.max(0, CHAT_FREE_DAILY_BASICO - (quota?.used ?? 0) - (quota?.reserved ?? 0))
  }

  private budgetRow(day: string): BudgetRow {
    let row = this.budgets.get(day)
    if (!row) {
      row = { gasto: 0, reservado: 0 }
      this.budgets.set(day, row)
    }
    return row
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(() => task())
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private quota(userId: string, now: Date): Quota {
    const key = this.key(userId, now)
    let quota = this.quotas.get(key)
    if (!quota) {
      quota = { used: 0, reserved: 0 }
      this.quotas.set(key, quota)
    }
    if (!this.paid.has(userId)) this.paid.set(userId, 0)
    return quota
  }

  private key(userId: string, now: Date): string {
    return `${userId}|${saoPauloDay(now)}`
  }
}

function dayDate(day: string): Date {
  return new Date(`${day}T12:00:00-03:00`)
}

function usd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
