import { ASAAS_SANDBOX_BASE, NOME_ITEM, ORIGEM_SITE, PRECO_REAIS, TRIAL_DIAS } from '../_shared/asaas_planos.ts'
import { corsAsaas } from '../_shared/asaas_cors.ts'
import { cpfCnpjValido, somenteDigitos } from '../_shared/asaas_cpf.ts'
import { AsaasErro, urlCheckout, type AsaasClient, type AssinaturaRemota } from '../_shared/asaas_client.ts'
import type { AsaasDb, PrepCheckout } from '../_shared/asaas_db.ts'
import { nextDueDate } from '../_shared/asaas_datas.ts'
import { falhaDeSchema, logSeguro } from '../_shared/asaas_token.ts'
import { JsonBodyReadError, readJsonWithByteLimit } from '../_shared/read_json.ts'

export interface DepsCheckout {
  authenticate: (header: string | null) => Promise<string | null>
  db: () => Promise<AsaasDb>
  baseUrl: () => string | undefined
  criarAsaas: () => AsaasClient | null
  now?: () => Date
  log?: (entrada: Record<string, string>) => void
}

// Decisão 18/11/2026: um trial por usuário neste ambiente. Se já houve assinatura
// (paga, cancelada ou divergente), a nova tentativa é recusada com trial_ja_usado.
// Não se cria outra com nextDueDate = hoje. Preço, plano e datas saem daqui, nunca do corpo.
// valor, value, price e nextDueDate enviados pelo cliente são ignorados.
// A reserva cobre a janela do checkout (60 min). Resultado incerto não apaga a linha.
// A intenção `enviando` é gravada antes do POST, com o id interno como externalReference.
// Reserva enviando, incerta ou com checkout_id, ao expirar, fica correlacionável e não é apagada.
// Antes de substituir, o handler consulta GET por customer e por externalReference.
// Falha de qualquer consulta recusa o checkout. POST no Asaas não tem retry.
// Nesta etapa o único ambiente é o sandbox.

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? valor as Record<string, unknown> : null
}

type JsonFn = (value: unknown, status?: number) => Response

/**
 * Reserva potencialmente enviada. Consulta por externalReference e, se houver, por customer.
 * Qualquer falha recusa. Lista vazia só libera com a geração lida no preparar.
 * Assinatura remota não deletada vincula a reserva antiga e recusa outro checkout.
 * Não grava data de acesso. O POST do checkout novo só acontece depois das listas vazias.
 */
async function reconciliar(
  db: AsaasDb,
  asaas: AsaasClient,
  userId: string,
  plano: 'basico' | 'plus',
  planejado: string,
  assinaturaId: string,
  geracao: number,
  json: JsonFn,
): Promise<PrepCheckout | Response> {
  const customer = await db.obterCliente('sandbox', userId)
  let listas: AssinaturaRemota[][]
  try {
    const consultas = [asaas.listarAssinaturasPorReferencia(assinaturaId)]
    if (customer) consultas.push(asaas.listarAssinaturas(customer))
    listas = await Promise.all(consultas)
  } catch {
    return json({ code: 'checkout_em_andamento', message: 'Não foi possível confirmar se já existe uma assinatura. Tente de novo.' }, 503)
  }
  const vivas: AssinaturaRemota[] = []
  const vistos = new Set<string>()
  for (const item of listas.flat()) {
    if (item.deleted === true || vistos.has(item.id)) continue
    vistos.add(item.id)
    vivas.push(item)
  }
  if (!vivas.length) return db.liberarCheckout('sandbox', userId, plano, planejado, geracao)
  const preferida = vivas.find((item) => item.externalReference === assinaturaId)
    ?? vivas.find((item) => item.externalReference)
    ?? vivas[0]
  const candidatos = [preferida.externalReference, assinaturaId].filter((id): id is string => !!id)
  const unicos = [...new Set(candidatos)]
  for (const id of unicos) {
    try {
      await db.vincularAssinaturaRemota('sandbox', userId, id, preferida.id)
      return json({ code: 'assinatura_ativa', message: 'Já existe uma assinatura nesta conta.' }, 409)
    } catch (erro) {
      const msg = erro instanceof Error ? erro.message : ''
      if (msg.includes('sub_duplicada')) {
        return json({ code: 'assinatura_ativa', message: 'Já existe uma assinatura nesta conta.' }, 409)
      }
    }
  }
  return json({ code: 'provedor', message: 'Não foi possível iniciar o checkout.' }, 502)
}

export function createAsaasCheckoutHandler(d: DepsCheckout) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('origin')
    const headers = corsAsaas(origin, 'POST, OPTIONS')
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers })
    const falhaRpc = (erro: unknown) => {
      if (falhaDeSchema(erro)) return json({ code: 'configuracao_ausente', message: 'Assinatura temporariamente indisponível.' }, 503)
      logSeguro(d.log, { fn: 'asaas-checkout', evento: 'checkout', classificacao: 'falha_interna', pedido_id: crypto.randomUUID() })
      return json({ code: 'rede', message: 'Não foi possível iniciar o checkout.' }, 502)
    }
    if (origin && origin !== ORIGEM_SITE) return json({ code: 'origem_recusada', message: 'Origem não permitida.' }, 403)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (req.method !== 'POST') return json({ code: 'pedido_invalido', message: 'Use POST.' }, 405)
    const userId = await d.authenticate(req.headers.get('authorization'))
    if (!userId) return json({ code: 'sem_login', message: 'Entre na sua conta para assinar.' }, 401)
    if (d.baseUrl() !== ASAAS_SANDBOX_BASE) {
      return json({ code: 'configuracao_ausente', message: 'Assinatura temporariamente indisponível.' }, 503)
    }
    const asaas = d.criarAsaas()
    if (!asaas) return json({ code: 'configuracao_ausente', message: 'Assinatura temporariamente indisponível.' }, 503)
    let body: unknown
    try {
      body = await readJsonWithByteLimit(req)
    } catch (erro) {
      const status = erro instanceof JsonBodyReadError ? erro.status : 400
      return json({ code: 'pedido_invalido', message: 'Corpo inválido ou muito grande.' }, status)
    }
    const row = objeto(body)
    if (!row) return json({ code: 'pedido_invalido', message: 'Corpo inválido ou muito grande.' }, 400)
    const plano = row.plano
    if (plano !== 'basico' && plano !== 'plus') return json({ code: 'plano_invalido', message: 'Escolha o plano Básico ou Plus.' }, 400)
    const nome = typeof row.nome === 'string' ? row.nome.trim() : ''
    if (nome.length < 2 || nome.length > 120 || /[\u0000-\u001f]/.test(nome)) {
      return json({ code: 'pedido_invalido', message: 'Informe o nome de cobrança.' }, 400)
    }
    const documento = typeof row.cpfCnpj === 'string' ? row.cpfCnpj : ''
    if (!cpfCnpjValido(documento)) return json({ code: 'cpf_invalido', message: 'CPF ou CNPJ inválido.' }, 400)
    let db: AsaasDb
    try {
      db = await d.db()
    } catch (erro) {
      return falhaRpc(erro)
    }
    const planejado = nextDueDate(d.now?.() ?? new Date(), TRIAL_DIAS).slice(0, 10)
    let prep
    try {
      prep = await db.prepararCheckout('sandbox', userId, plano, planejado)
    } catch (erro) {
      return falhaRpc(erro)
    }
    if (prep.code === 'reconciliar' && prep.assinaturaId) {
      try {
        const seguido = await reconciliar(db, asaas, userId, plano, planejado, prep.assinaturaId, prep.geracao ?? -1, json)
        if (seguido instanceof Response) return seguido
        prep = seguido
      } catch (erro) {
        return falhaRpc(erro)
      }
    }
    if (!prep.ok || !prep.assinaturaId) {
      const code = prep.code ?? 'pedido_invalido'
      const message = code === 'trial_ja_usado'
        ? 'O período inicial desta conta neste ambiente já foi usado.'
        : code === 'assinatura_ativa'
          ? 'Já existe uma assinatura nesta conta.'
          : 'Já existe um checkout em andamento.'
      return json({ code, message }, 409)
    }
    if (prep.reutilizado && prep.checkoutId) return json({ url: urlCheckout(prep.checkoutId) })
    const reserva = prep.assinaturaId
    try {
      let customer = await db.obterCliente('sandbox', userId)
      if (customer) {
        const achou = await asaas.buscarCliente(customer)
        if (!achou) customer = null
      }
      if (!customer) {
        const criado = await asaas.criarCliente({ nome, cpfCnpj: somenteDigitos(documento) })
        await db.gravarCliente('sandbox', userId, criado.id)
        customer = await db.obterCliente('sandbox', userId) ?? criado.id
      }
      await db.marcarCheckoutEnviando('sandbox', userId, reserva)
      const sessao = await asaas.criarCheckout({
        customer,
        plano,
        valor: PRECO_REAIS[plano],
        nextDueDate: nextDueDate(d.now?.() ?? new Date(), TRIAL_DIAS),
        externalReference: reserva,
        nomeItem: NOME_ITEM[plano],
      })
      await db.vincularCheckout('sandbox', userId, reserva, sessao.id)
      logSeguro(d.log, { fn: 'asaas-checkout', evento: 'checkout', plano, resultado: 'ok' })
      return json({ url: sessao.url })
    } catch (erro) {
      if (erro instanceof AsaasErro && erro.definitivo) {
        await db.descartarEnvioRecusado('sandbox', userId, reserva).catch(() => {})
        await db.descartarCheckout('sandbox', userId, reserva).catch(() => {})
      } else {
        await db.marcarCheckoutIncerto('sandbox', userId, reserva).catch(() => {})
      }
      if (falhaDeSchema(erro)) return falhaRpc(erro)
      const code = erro instanceof AsaasErro ? 'provedor' : 'rede'
      logSeguro(d.log, { fn: 'asaas-checkout', evento: 'checkout', plano, classificacao: 'falha_interna', pedido_id: crypto.randomUUID() })
      return json({ code, message: 'Não foi possível iniciar o checkout.' }, 502)
    }
  }
}
