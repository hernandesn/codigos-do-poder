import { ORIGEM_SITE } from './asaas_planos.ts'

export function corsAsaas(origin: string | null, methods: string): Record<string, string> {
  const headers: Record<string, string> = {
    vary: 'Origin',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  }
  if (origin !== ORIGEM_SITE) return headers
  headers['access-control-allow-origin'] = ORIGEM_SITE
  headers['access-control-allow-methods'] = methods
  headers['access-control-allow-headers'] = 'authorization, content-type, apikey, x-client-info'
  headers['access-control-max-age'] = '86400'
  return headers
}
