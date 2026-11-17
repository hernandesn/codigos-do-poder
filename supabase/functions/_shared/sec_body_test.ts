import { readJsonWithByteLimit, JsonBodyReadError } from './read_json.ts'
import { handleChatRequest } from '../chat/handler.ts'
import { fixtureEnv, fixtureRequest } from './sec_http_fixture.ts'
function check(ok: boolean, label: string) { if (!ok) throw new Error(label) }
function req(body: BodyInit, headers?: HeadersInit) {
  return new Request('http://127.0.0.1/chat', { method: 'POST', body, headers, ...{ duplex: 'half' } })
}
Deno.test('SEC-03 corpo sem Content-Length acima de 65 KB cancela e retorna HTTP 413', async () => {
  fixtureEnv()
  let canceled = false
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(c) { pulls++; c.enqueue(new Uint8Array(32_768).fill(32)) },
    cancel() { canceled = true },
  }, { highWaterMark: 0 })
  const request = await fixtureRequest(body)
  check(!request.headers.has('content-length'), 'sem cabeçalho de tamanho')
  const response = await handleChatRequest(request)
  check(response.status === 413, 'status HTTP 413')
  check((await response.text()).includes('pedido_invalido'), 'erro público genérico')
  check(canceled && pulls === 3, 'para na primeira ultrapassagem, sem parsear')
})
Deno.test('SEC-03 UTF-8, fronteira exata, Content-Length falso e JSON inválido', async () => {
  const exact = '"' + 'x'.repeat(65_534) + '"'
  check((await readJsonWithByteLimit(req(exact)) as string).length === 65_534, '65536 bytes aceitos')
  for (const [body, headers] of [
    ['"' + '你'.repeat(25_000) + '"', undefined],
    ['x'.repeat(65_537), { 'content-length': '1' }],
    ['{}', { 'content-length': '65537' }],
  ] as const) {
    let status = 0
    try { await readJsonWithByteLimit(req(body, headers)) } catch (e) { if (e instanceof JsonBodyReadError) status = e.status }
    check(status === 413, 'limite por bytes mesmo com cabeçalho falso')
  }
  let invalid = false
  try { await readJsonWithByteLimit(req('{')) } catch { invalid = true }
  check(invalid, 'JSON inválido recusado')
})
Deno.test('SEC-03 prazo total cancela stream sem fim', async () => {
  let canceled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true } })
  let status = 0
  try { await readJsonWithByteLimit(req(body), 65_536, 15) } catch (e) { if (e instanceof JsonBodyReadError) status = e.status }
  check(status === 408 && canceled, 'prazo expira e cancela leitor')
})
