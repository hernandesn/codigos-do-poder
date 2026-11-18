// Compara o digest SHA-256 dos dois lados, sempre nos 32 bytes. Não compara o segredo cru.
const encoder = new TextEncoder()

function igualDigest(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < 32; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export async function tokenWebhookConfere(recebido: string, esperado: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(recebido)),
    crypto.subtle.digest('SHA-256', encoder.encode(esperado)),
  ])
  return igualDigest(new Uint8Array(x), new Uint8Array(y))
}

export function codigoErro(erro: unknown): string {
  if (!erro || typeof erro !== 'object') return ''
  const code = (erro as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/** 42883 função inexistente, 42P01 tabela inexistente, SEM_URL sem ATLAS_CHAT_DB_URL. */
export function falhaDeSchema(erro: unknown): boolean {
  const code = codigoErro(erro)
  return code === '42883' || code === '42P01' || code === 'SEM_URL'
}

const CHAVES_LOG = new Set([
  'fn', 'evento', 'pedido_id', 'plano', 'resultado', 'http', 'modo',
  'event_id', 'recurso_id', 'subscription_id', 'classificacao',
])

export function logSeguro(
  log: ((entrada: Record<string, string>) => void) | undefined,
  entrada: Record<string, string | null | undefined>,
) {
  if (!log) return
  const saida: Record<string, string> = {}
  for (const [chave, valor] of Object.entries(entrada)) {
    if (!CHAVES_LOG.has(chave) || valor == null || valor === '') continue
    saida[chave] = String(valor).slice(0, 120)
  }
  log(saida)
}
