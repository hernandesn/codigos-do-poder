// Autenticação inteiramente sintética, criada somente em memória para testes locais.
const FIXTURE_SECRET = 'sec-local-fixture-only'
export function fixtureEnv() {
  Deno.env.set('JWT_SECRET', FIXTURE_SECRET)
  Deno.env.set('SUPABASE_URL', 'https://fixture.invalid')
  Deno.env.set('CHAT_DB', 'memory')
  Deno.env.set('CHAT_DAILY_BUDGET_USD', '3')
}
export async function fixtureRequest(body: BodyInit): Promise<Request> {
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  const encode = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)))
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: '11111111-1111-4111-8111-111111111111', role: 'authenticated', aud: 'authenticated', iss: 'https://fixture.invalid/auth/v1', exp: Math.floor(Date.now() / 1000) + 60 })}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(FIXTURE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))))
  return new Request('http://127.0.0.1/chat', { method: 'POST', body, headers: { authorization: `Bearer ${data}.${sig}` }, ...{ duplex: 'half' } })
}
