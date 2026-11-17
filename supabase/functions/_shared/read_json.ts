/** Limite total de recebimento; inclui esperas entre chunks. Sem reinício por chunk. */
export const CHAT_BODY_TIMEOUT_MS = 5_000
export const CHAT_BODY_MAX_BYTES = 65_536

export class JsonBodyReadError extends Error {
  readonly status: number
  constructor(status: number) { super('pedido_invalido'); this.status = status }
}

/** Conta bytes efetivamente recebidos; Content-Length é somente uma otimização. */
export async function readJsonWithByteLimit(req: Request, limit = CHAT_BODY_MAX_BYTES, timeoutMs = CHAT_BODY_TIMEOUT_MS): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? 0) > limit) {
    void req.body?.cancel().catch(() => {})
    throw new JsonBodyReadError(413)
  }
  if (!req.body) throw new JsonBodyReadError(400)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new JsonBodyReadError(408))
      void reader.cancel().catch(() => {})
    }, timeoutMs)
  })
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), expired])
      if (done) break
      size += value.byteLength
      if (size > limit) {
        void reader.cancel().catch(() => {})
        throw new JsonBodyReadError(413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}
