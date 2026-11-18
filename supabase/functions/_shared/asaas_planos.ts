// Limites consumíveis pelo próximo PR do chat. Esta etapa não liga nada ao chat.
// Plus é o plano pago de R$ 29,90. Não é o modelo "Avançado".
// O teto global de US$ 3/dia continua valendo para todos, inclusive o gratuito.

export const ASAAS_SANDBOX_BASE = 'https://api-sandbox.asaas.com'
export const ORIGEM_SITE = 'https://aion.hernandesnogueira.com.br'
export const CICLO_ASSINATURA = 'MONTHLY'
export const TRIAL_DIAS = 7
export const CHECKOUT_MINUTOS = 60
export const TETO_GLOBAL_USD_DIA = 3
export const ANTIABUSO_BASICO_DIA = 150

export const LIMITES_PLANO = {
  free: { basico_dia: 20, avancado_ciclo: 0 },
  basico: { basico_dia: 150, avancado_ciclo: 20 },
  plus: { basico_dia: 150, avancado_ciclo: 100 },
} as const

export const PRECO_CENTAVOS = { basico: 990, plus: 2990 } as const
export const PRECO_REAIS = { basico: 9.9, plus: 29.9 } as const

export const NOME_ITEM = { basico: 'Plano Básico', plus: 'Plano Plus' } as const

export const beneficios = {
  free: {
    basico_dia: LIMITES_PLANO.free.basico_dia,
    avancado_ciclo: LIMITES_PLANO.free.avancado_ciclo,
    nota: 'Com login: 20 perguntas Básico por dia, como hoje. Avançado: 0.',
  },
  basico: {
    preco: '9.90',
    ciclo: CICLO_ASSINATURA,
    basico_dia: LIMITES_PLANO.basico.basico_dia,
    avancado_ciclo: LIMITES_PLANO.basico.avancado_ciclo,
    nota: 'Básico ilimitado com teto anti-abuso de 150 perguntas por dia e 20 Avançado por mês-calendário da assinatura (do vencimento pago ao próximo).',
  },
  plus: {
    preco: '29.90',
    ciclo: CICLO_ASSINATURA,
    basico_dia: LIMITES_PLANO.plus.basico_dia,
    avancado_ciclo: LIMITES_PLANO.plus.avancado_ciclo,
    nota: 'Básico ilimitado com o mesmo anti-abuso de 150/dia e 100 Avançado por mês. Plus não é o modelo Avançado.',
  },
} as const

export const URLS_CALLBACK = {
  successUrl: ORIGEM_SITE + '/cancelar.html?retorno=sucesso',
  cancelUrl: ORIGEM_SITE + '/cancelar.html?retorno=cancelado',
  expiredUrl: ORIGEM_SITE + '/cancelar.html?retorno=expirado',
} as const

export type PlanoPago = 'basico' | 'plus'
export type PlanoNome = 'free' | PlanoPago

export function precoCentavos(plano: PlanoPago): number {
  return PRECO_CENTAVOS[plano]
}

export function planoPorCentavos(centavos: number | null): PlanoPago | null {
  if (centavos === PRECO_CENTAVOS.basico) return 'basico'
  if (centavos === PRECO_CENTAVOS.plus) return 'plus'
  return null
}
