// Somente RPCs da 014. Sem acesso direto às tabelas e sem tabelas do chat.
import postgres from 'npm:postgres@3.4.9'
import type { AsaasDb, CancelPrep, EventoDb, PrepCheckout, StatusAssinatura, StatusPublico } from './asaas_db.ts'
function objeto(valor: unknown): Record<string, unknown> {
  if (typeof valor === 'string') return JSON.parse(valor) as Record<string, unknown>
  if (valor && typeof valor === 'object') return valor as Record<string, unknown>
  return {}
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null
}

const STATUS = new Set<StatusAssinatura>([
  'checkout', 'trial', 'ativa', 'inadimplente', 'suspensa', 'cancelamento_solicitado', 'cancelada', 'divergente',
])

function statusConhecido(valor: unknown): valor is StatusAssinatura {
  return typeof valor === 'string' && STATUS.has(valor as StatusAssinatura)
}

export function createPgAsaasDb(url: string): AsaasDb {
  const sql = postgres(url, {
    max: 1, prepare: false, ssl: 'require', connect_timeout: 10, idle_timeout: 20,
    connection: { application_name: 'atlas_asaas_fn' },
  })
  const valor = async (q: PromiseLike<{ v?: unknown }[]>) => (await q)[0]?.v
  return {
    async prepararCheckout(ambiente, userId, plano, nextDue = null) {
      const row = objeto(await valor(sql`select chat_private.asaas_preparar_checkout(${ambiente}, ${userId}::uuid, ${plano}, ${nextDue}::date) as v`))
      const prep: PrepCheckout = {
        ok: row.ok === true,
        assinaturaId: texto(row.assinatura_id) ?? undefined,
        checkoutId: texto(row.checkout_id),
        reutilizado: row.reutilizado === true,
      }
      if (row.code === 'trial_ja_usado' || row.code === 'assinatura_ativa' || row.code === 'checkout_em_andamento' || row.code === 'plano_invalido' || row.code === 'reconciliar') prep.code = row.code
      return prep
    },
    async liberarCheckout(ambiente, userId, plano, nextDue = null) {
      const row = objeto(await valor(sql`select chat_private.asaas_liberar_checkout(${ambiente}, ${userId}::uuid, ${plano}, ${nextDue}::date) as v`))
      const prep: PrepCheckout = {
        ok: row.ok === true,
        assinaturaId: texto(row.assinatura_id) ?? undefined,
        checkoutId: texto(row.checkout_id),
        reutilizado: row.reutilizado === true,
      }
      if (row.code === 'trial_ja_usado' || row.code === 'assinatura_ativa' || row.code === 'checkout_em_andamento' || row.code === 'plano_invalido' || row.code === 'reconciliar') prep.code = row.code
      return prep
    },
    async vincularCheckout(ambiente, userId, assinaturaId, checkoutId) {
      await sql`select chat_private.asaas_vincular_checkout(${ambiente}, ${userId}::uuid, ${assinaturaId}::uuid, ${checkoutId})`
    },
    async vincularAssinaturaRemota(ambiente, userId, assinaturaId, subscriptionId) {
      await sql`select chat_private.asaas_vincular_assinatura_remota(${ambiente}, ${userId}::uuid, ${assinaturaId}::uuid, ${subscriptionId})`
    },
    async descartarCheckout(ambiente, userId, assinaturaId) {
      await sql`select chat_private.asaas_descartar_checkout(${ambiente}, ${userId}::uuid, ${assinaturaId}::uuid)`
    },
    async marcarCheckoutIncerto(ambiente, userId, assinaturaId) {
      await sql`select chat_private.asaas_marcar_checkout_incerto(${ambiente}, ${userId}::uuid, ${assinaturaId}::uuid)`
    },
    async obterCliente(ambiente, userId) {
      const id = await valor(sql`select chat_private.asaas_obter_cliente(${ambiente}, ${userId}::uuid) as v`)
      return typeof id === 'string' ? id : null
    },
    async gravarCliente(ambiente, userId, customerId) {
      await sql`select chat_private.asaas_gravar_cliente(${ambiente}, ${userId}::uuid, ${customerId})`
    },
    async aplicarEvento(evento: EventoDb) {
      const row = objeto(await valor(sql`select chat_private.asaas_aplicar_evento(
        ${evento.ambiente}, ${evento.eventId}, ${evento.tipo}, ${evento.recursoId}, ${evento.subscriptionId},
        ${evento.customerId}, ${evento.checkoutId}, ${evento.externalReference}, ${evento.valor},
        ${evento.vencimento}::date, ${evento.nextDue}::date, ${evento.quando}::timestamptz
      ) as v`))
      return { aplicado: row.aplicado === true, duplicado: row.duplicado === true }
    },
    async lerStatus(ambiente, userId) {
      const row = objeto(await valor(sql`select chat_private.asaas_status(${ambiente}, ${userId}::uuid) as v`))
      const plano = row.plano === 'basico' || row.plano === 'plus' ? row.plano : 'free'
      const status = typeof row.status === 'string' ? row.status : 'free'
      return {
        plano, status, trial_ate: texto(row.trial_ate), pago_ate: texto(row.pago_ate),
        acesso_ate: texto(row.acesso_ate), pode_cancelar: row.pode_cancelar === true,
      } as StatusPublico
    },
    async pedirCancelamento(ambiente, userId) {
      const row = objeto(await valor(sql`select chat_private.asaas_pedir_cancelamento(${ambiente}, ${userId}::uuid) as v`))
      const prep: CancelPrep = {
        ok: row.ok === true,
        ja: row.ja === true,
        refazer: row.refazer === true,
        subscriptionId: texto(row.subscription_id) ?? undefined,
        acesso_ate: texto(row.acesso_ate),
      }
      if (typeof row.status === 'string') prep.status = row.status as CancelPrep['status']
      if (statusConhecido(row.status_anterior)) prep.statusAnterior = row.status_anterior
      if (row.code === 'sem_assinatura' || row.code === 'cancelamento_em_andamento') prep.code = row.code
      if (row.estado === 'pendente' || row.estado === 'concluido' || row.estado === 'falhou') prep.estado = row.estado
      return prep
    },
    async marcarCancelamento(ambiente, userId, subscriptionId) {
      await sql`select chat_private.asaas_marcar_cancelamento(${ambiente}, ${userId}::uuid, ${subscriptionId})`
    },
    async falharCancelamento(ambiente, userId, subscriptionId) {
      await sql`select chat_private.asaas_falhar_cancelamento(${ambiente}, ${userId}::uuid, ${subscriptionId})`
    },
  }
}
