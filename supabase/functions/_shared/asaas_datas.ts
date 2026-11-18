// Datas de cobrança no fuso do Asaas (America/Sao_Paulo, UTC−3, sem horário de verão).

export function dataIsoNoFuso(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const pegar = (tipo: string) => parts.find((p) => p.type === tipo)?.value ?? ''
  return `${pegar('year')}-${pegar('month')}-${pegar('day')}`
}

export function somarDiasIso(iso: string, dias: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + dias))
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${mm}-${dd}`
}

/** Mesmo clamp do PostgreSQL: 31/01 + 1 mês = 28/02 (ou 29 em ano bissexto). */
export function somarMesIso(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  const y = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const alvo = new Date(Date.UTC(y, month, 1))
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate()
  const dt = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth(), Math.min(day, ultimo)))
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${mm}-${dd}`
}

export function nextDueDate(now: Date, dias: number): string {
  return `${somarDiasIso(dataIsoNoFuso(now, 'America/Sao_Paulo'), dias)} 00:00:00`
}

export function dataIsoDeTexto(valor: unknown): string | null {
  if (typeof valor !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(valor)
  return match ? match[1] : null
}

/** Sem fuso na string do Asaas: interpreta como America/Sao_Paulo. */
export function parseInstanteAsaas(valor: string | null, agora: Date): string {
  if (valor && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(valor)) {
    const norm = valor.replace(' ', 'T')
    const comFuso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(norm) ? norm : norm + '-03:00'
    const ms = Date.parse(comFuso)
    if (Number.isFinite(ms)) return new Date(ms).toISOString()
  }
  const dia = dataIsoDeTexto(valor)
  if (dia) {
    const ms = Date.parse(dia + 'T00:00:00-03:00')
    if (Number.isFinite(ms)) return new Date(ms).toISOString()
  }
  return agora.toISOString()
}

export function instanteAnterior(evento: string, ultimo: string | null): boolean {
  if (!ultimo) return false
  const a = Date.parse(evento)
  const b = Date.parse(ultimo)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return a < b
}
