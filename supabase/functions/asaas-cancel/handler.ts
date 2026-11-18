import { ASAAS_SANDBOX_BASE, ORIGEM_SITE } from '../_shared/asaas_planos.ts'
import { corsAsaas } from '../_shared/asaas_cors.ts'
import type { AsaasClient } from '../_shared/asaas_client.ts'
import type { AsaasDb } from '../_shared/asaas_db.ts'
import { falhaDeSchema, logSeguro } from '../_shared/asaas_token.ts'
import { JsonBodyReadError, readJsonWithByteLimit } from '../_shared/read_json.ts'

export interface DepsCancel {
  authenticate: (header: string | null) => Promise<string | null>
  db: () => Promise<AsaasDb>
  baseUrl: () => string | undefined
  criarAsaas: () => AsaasClient | null
  log?: (entrada: Record<string, string>) => void
}

// O user vem só do JWT. subscription_id e user_id do corpo são lidos e descartados.
// A operação fica em asaas_cancelamentos. ja só quando ela está concluída ou a recorrência já encerrou.
// Lease válido responde cancelamento_em_andamento e não chama o Asaas de novo.
// Lease vencido ou falhou refaz o DELETE. Se o GET mostrar deleted, conclui sem outro DELETE.
// Falha do DELETE grava falhou e devolve 502. Não devolve a linha ao estado anterior.
// Encerrar não apaga bloqueio. Até o fim de pago_ate ou trial_ate o plano continua, se não houver bloqueio.

async function descartarCorpo(req: Request) {
  const tamanho = Number(req.headers.get('content-length') ?? 0)
  if (!req.body && !tamanho) return
  await readJsonWithByteLimit(req)
}

export function createAsaasCancelHandler(d: DepsCancel) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('origin')
    const headers = corsAsaas(origin, 'GET, POST, OPTIONS')
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers })
    const falhaRpc = (erro: unknown) => {
      if (falhaDeSchema(erro)) return json({ code: 'configuracao_ausente', message: 'Assinatura temporariamente indisponível.' }, 503)
      logSeguro(d.log, { fn: 'asaas-cancel', evento: 'status', classificacao: 'falha_interna', pedido_id: crypto.randomUUID() })
      return json({ code: 'rede', message: 'Não foi possível consultar a assinatura.' }, 502)
    }
    if (origin && origin !== ORIGEM_SITE) return json({ code: 'origem_recusada', message: 'Origem não permitida.' }, 403)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (req.method !== 'GET' && req.method !== 'POST') return json({ code: 'pedido_invalido', message: 'Use GET ou POST.' }, 405)
    const userId = await d.authenticate(req.headers.get('authorization'))
    if (!userId) return json({ code: 'sem_login', message: 'Entre na sua conta para ver a assinatura.' }, 401)
    if (d.baseUrl() !== ASAAS_SANDBOX_BASE) {
      return json({ code: 'configuracao_ausente', message: 'Assinatura temporariamente indisponível.' }, 503)
    }
    if (req.method === 'POST') {
      try {
        await descartarCorpo(req)
      } catch (erro) {
        const status = erro instanceof JsonBodyReadError ? erro.status : 400
        return json({ code: 'pedido_invalido', message: 'Corpo inválido ou muito grande.' }, status)
      }
    }
    let db: AsaasDb
    try {
      db = await d.db()
    } catch (erro) {
      return falhaRpc(erro)
    }
    if (req.method === 'GET') {
      try {
        return json(await db.lerStatus('sandbox', userId))
      } catch (erro) {
        return falhaRpc(erro)
      }
    }
    let prep
    try {
      prep = await db.pedirCancelamento('sandbox', userId)
    } catch (erro) {
      return falhaRpc(erro)
    }
    if (!prep.ok || !prep.subscriptionId) return json({ code: 'sem_assinatura', message: 'Não há assinatura para cancelar.' }, 404)
    if (prep.ja) return json({ status: prep.status, ja: true, acesso_ate: prep.acesso_ate ?? null })
    if (prep.code === 'cancelamento_em_andamento') {
      return json({ code: 'cancelamento_em_andamento', message: 'O cancelamento desta assinatura já está em andamento.' }, 409)
    }
    const asaas = d.criarAsaas()
    const falhar = async () => {
      await db.falharCancelamento('sandbox', userId, prep.subscriptionId!)
    }
    if (!asaas) {
      try {
        await falhar()
      } catch (erro) {
        return falhaRpc(erro)
      }
      return json({ code: 'configuracao_ausente', message: 'Assinatura temporariamente indisponível.' }, 503)
    }
    if (prep.refazer) {
      try {
        const remota = await asaas.obterAssinatura(prep.subscriptionId)
        if (remota.deleted) {
          try {
            await db.marcarCancelamento('sandbox', userId, prep.subscriptionId)
          } catch (erro) {
            return falhaRpc(erro)
          }
          return json({ status: prep.status, ja: false, acesso_ate: prep.acesso_ate ?? null })
        }
      } catch {
        // GET incerto: o DELETE no Asaas é idempotente e segue abaixo.
      }
    }
    try {
      await asaas.cancelarAssinatura(prep.subscriptionId)
    } catch {
      try {
        await falhar()
      } catch (erro) {
        return falhaRpc(erro)
      }
      logSeguro(d.log, { fn: 'asaas-cancel', evento: 'cancelar', classificacao: 'falha_interna', pedido_id: crypto.randomUUID() })
      return json({ code: 'provedor', message: 'Não foi possível cancelar a assinatura.' }, 502)
    }
    try {
      await db.marcarCancelamento('sandbox', userId, prep.subscriptionId)
    } catch (erro) {
      return falhaRpc(erro)
    }
    let statusResposta = prep.status
    try {
      const atual = await db.lerStatus('sandbox', userId)
      if (atual.status !== 'free') statusResposta = atual.status
    } catch {
      // A marcação já entrou. A resposta fica com o status da reserva.
    }
    logSeguro(d.log, { fn: 'asaas-cancel', evento: 'cancelar', resultado: 'cancelamento_solicitado' })
    return json({ status: statusResposta, ja: false, acesso_ate: prep.acesso_ate ?? null })
  }
}
