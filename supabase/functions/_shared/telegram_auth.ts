// Criptografia pura: nunca lê ambiente nem faz rede.
const enc = new TextEncoder()
export const INITDATA_MAX_AGE_S = 3600
export const INITDATA_FUTURE_S = 30
export async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)))
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
export async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))))
}
/** Sempre percorre os 32 bytes do digest; não compara strings de segredo. */
export function equalDigest(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < 32; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
export async function constantTimeTextEqual(a: string, b: string): Promise<boolean> {
  const [x,y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])
  return equalDigest(new Uint8Array(x),new Uint8Array(y))
}
export type ValidInitData = { telegramId: string; hash: string; expiresAt: number }
export async function validateInitData(authorization: string | null, botToken: string | undefined, nowS = Math.floor(Date.now()/1000)): Promise<ValidInitData | null> {
  if (!botToken || !authorization?.startsWith('tma ') || authorization.length>16384) return null
  const raw = authorization.slice(4)
  if (!raw || /[\r\n]/.test(raw)) return null
  const params = new URLSearchParams(raw)
  const fields = [...params.entries()]
  if (new Set(fields.map(([k])=>k)).size !== fields.length) return null
  const received = params.get('hash') ?? ''
  if (!/^[a-f0-9]{64}$/.test(received)) return null
  const data = fields.filter(([key])=>key!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n')
  // WebAppData é a chave, o token é a mensagem. Não inverter.
  const secret = await hmac(enc.encode('WebAppData'),botToken)
  const expected = await hmac(secret,data)
  const actual = Uint8Array.from(received.match(/../g)!,v=>parseInt(v,16))
  if (!equalDigest(expected,actual)) return null
  const date = params.get('auth_date') ?? ''
  if (!/^\d{1,12}$/.test(date)) return null
  const timestamp = Number(date)
  if (timestamp <= 0 || timestamp < nowS-INITDATA_MAX_AGE_S || timestamp > nowS+INITDATA_FUTURE_S) return null
  try {
    const user = JSON.parse(params.get('user') ?? '')
    if (!user || !Number.isSafeInteger(user.id) || user.id<=0 || user.is_bot===true) return null
    return { telegramId:String(user.id),hash:received,expiresAt:timestamp+INITDATA_MAX_AGE_S }
  } catch { return null }
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 símbolos, sem 0/1/I/O.
export function generateLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return Array.from(bytes,b=>ALPHABET[b & 31]).join('').match(/.{5}/g)!.join('-')
}
export function normalizeCode(code: string): string | null {
  const normalized = code.toUpperCase().replaceAll('-','')
  return /^[A-HJ-NP-Z2-9]{20}$/.test(normalized) ? normalized : null
}
export async function hashLinkCode(code: string, pepper: string | undefined): Promise<string | null> {
  const normalized = normalizeCode(code)
  if (!pepper || pepper.length<32 || !normalized) return null
  return hex(await hmac(enc.encode(pepper),normalized))
}
export function newSessionProof(): string { return hex(crypto.getRandomValues(new Uint8Array(32))) }
/** Secret curto ou ausente falha fechado. O mesmo piso do pepper do código. */
export function webhookSecretValue(raw: string | undefined): string | undefined {
  return raw && raw.length >= 32 ? raw : undefined
}
