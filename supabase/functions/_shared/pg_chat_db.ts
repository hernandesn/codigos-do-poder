// Conexão direta como chat_fn. Uma conexão por isolate, sem prepared statement:
// o pooler em modo transaction (porta 6543) não guarda sessão.
// Cada método espera a query anterior terminar. postgres.js encadeia por padrão
// e, com max 1, uma segunda query simultânea pode misturar a resposta.

import postgres from 'npm:postgres@3.4.9'
import type { ChatDb, ChatLogInsert, Modelo, Reservation, ReserveDenied } from './chat_core.ts'

type Sql = ReturnType<typeof postgres>

let singleton: Sql | null = null

export function createPgChatDb(url: string): ChatDb {
  if (!singleton) {
    singleton = postgres(url, {
      max: 1,
      prepare: false,
      ssl: 'require',
      connect_timeout: 10,
      idle_timeout: 20,
      connection: { application_name: 'atlas_chat_fn' },
    })
  }
  return adapt(singleton)
}

function adapt(sql: Sql): ChatDb {
  return {
    async rateTouch(userId) {
      const result = await one(sql`select chat_private.chat_rate_touch(${userId}) as result`)
      return {
        minuteCount: numberField(result, 'minute_count'),
        dayCount: numberField(result, 'day_count'),
        oldestMinute: typeof result.oldest_minute === 'string' ? result.oldest_minute : null,
      }
    },
    async budgetSpentUsd(day) {
      const rows = await sql<{ spent: number }[]>`
        select coalesce(gasto_usd, 0)::float8 as spent
        from chat_private.budget_daily
        where dia = ${day}::date
      `
      return Number(rows[0]?.spent ?? 0)
    },
    async reserveBudget(pedidoId, estimate, cap) {
      const result = await one(sql`
        select chat_private.chat_budget_reserve(${pedidoId}::uuid, ${estimate}, ${cap}) as result
      `)
      if (result.ok !== true) return { ok: false as const }
      const day = String(result.day ?? '').slice(0, 10)
      if (!day) throw new Error('budget sem dia')
      return { ok: true as const, day }
    },
    async commitBudget(pedidoId, actual) {
      const result = await one(sql`
        select chat_private.chat_budget_commit(${pedidoId}::uuid, ${actual}) as result
      `)
      if (result.ok !== true) throw new Error('budget commit recusado')
    },
    async releaseBudget(pedidoId) {
      await one(sql`
        select chat_private.chat_budget_release(${pedidoId}::uuid) as result
      `)
    },
    async acquirePaidLease(pedidoId, holdMs) {
      const seconds = Math.ceil(holdMs / 1000)
      const rows = await sql<{ ok: boolean }[]>`
        select chat_private.chat_paid_acquire(${pedidoId}::uuid, (${String(seconds)} || ' seconds')::interval) as ok
      `
      return rows[0]?.ok === true
    },
    async releasePaidLease(pedidoId) {
      await sql`select chat_private.chat_paid_release(${pedidoId}::uuid)`
    },
    async reserveCredits(userId, modelo, pedidoId) {
      const result = await one(sql`select chat_private.chat_reserve_credits(${userId}::uuid, ${modelo}, ${pedidoId}::uuid) as result`)
      if (result.ok !== true) {
        const denied: ReserveDenied = {
          ok: false,
          code: 'sem_creditos',
          gratis_restantes: numberField(result, 'gratis_restantes'),
          pago: numberField(result, 'pago'),
        }
        return denied
      }
      const reservation: Reservation = {
        ok: true,
        userId,
        kind: result.kind === 'paid' ? 'paid' : 'free',
        cost: numberField(result, 'cost'),
        day: String(result.day).slice(0, 10),
        pedidoId,
        modelo: modelo as Modelo,
        gratis_restantes: numberField(result, 'gratis_restantes'),
        pago: numberField(result, 'pago'),
      }
      return reservation
    },
    async commitCredits(reservation) {
      const result = await one(sql`
        select chat_private.chat_commit_credits(
          ${reservation.userId}::uuid,
          ${reservation.modelo},
          ${reservation.kind},
          ${reservation.cost},
          ${reservation.day}::date,
          ${reservation.pedidoId}::uuid
        ) as result
      `)
      if (result.ok !== true) throw new Error('commit recusado')
      return {
        gratis_restantes: numberField(result, 'gratis_restantes'),
        pago: numberField(result, 'pago'),
      }
    },
    async releaseReserve(reservation) {
      await one(sql`
        select chat_private.chat_release_reserve(
          ${reservation.userId}::uuid,
          ${reservation.modelo},
          ${reservation.kind},
          ${reservation.cost},
          ${reservation.day}::date,
          ${reservation.pedidoId}::uuid
        ) as result
      `)
    },
    async chatContext(entityIds, query) {
      const rows = await sql<{ ctx: unknown }[]>`
        select public.chat_context(${entityIds}::text[], ${query}, 60, 40) as ctx
      `
      const ctx = rows[0]?.ctx
      const parsed = typeof ctx === 'string' ? JSON.parse(ctx) : ctx
      return parsed ?? { raizes: [], entidades: [], relacoes: [], fontes: [] }
    },
    async insertLog(row: ChatLogInsert) {
      await sql`
        insert into chat_private.chat_logs
          (conversa_id, user_key, modelo, tokens_in, tokens_out, custo_usd, latencia_ms, entidades, status)
        values
          (${row.conversa_id}, ${row.user_key}, ${row.modelo}, ${row.tokens_in}, ${row.tokens_out},
           ${row.custo_usd}, ${row.latencia_ms}, ${row.entidades}::text[], ${row.status})
      `
    },
  }
}

async function one(query: PromiseLike<{ result?: unknown }[]>): Promise<Record<string, unknown>> {
  const rows = await query
  const value = rows[0]?.result
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>
  if (value && typeof value === 'object') return value as Record<string, unknown>
  return {}
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key] ?? 0)
  return Number.isFinite(value) ? value : 0
}
