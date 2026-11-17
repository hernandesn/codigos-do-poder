// Pares de raízes sem aresta direta no recorte. Derivado no TS; não vem da RPC.
// Ligação direta: relação com {origem, destino} no par (qualquer direção) ou item
// de ligacoes_entre_raizes com via null. Caminho por intermediário continua lacuna.

import type { ChatContextPayload } from './chat_core.ts'

export interface LacunaEntreRaizes {
  de: string
  para: string
  marcador: 'sem ligação direta documentada'
  via?: string[]
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`
}

export function lacunasEntreRaizes(ctx: ChatContextPayload): LacunaEntreRaizes[] {
  const roots = (ctx.raizes ?? []).filter((root) => root && typeof root.id === 'string' && root.id)
  if (roots.length < 2) return []

  const direct = new Set<string>()
  for (const rel of ctx.relacoes ?? []) {
    if (rel?.origem && rel?.destino) direct.add(pairKey(rel.origem, rel.destino))
  }
  const vias = new Map<string, string[]>()
  for (const link of ctx.ligacoes_entre_raizes ?? []) {
    if (!link?.de || !link?.para) continue
    const key = pairKey(link.de, link.para)
    if (link.via === null) {
      direct.add(key)
      continue
    }
    if (typeof link.via !== 'string' || !link.via) continue
    const list = vias.get(key) ?? []
    if (!list.includes(link.via)) list.push(link.via)
    vias.set(key, list)
  }

  const out: LacunaEntreRaizes[] = []
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const de = roots[i].id
      const para = roots[j].id
      if (de === para) continue
      const key = pairKey(de, para)
      if (direct.has(key)) continue
      const lacuna: LacunaEntreRaizes = { de, para, marcador: 'sem ligação direta documentada' }
      const via = vias.get(key)
      if (via && via.length) lacuna.via = via
      out.push(lacuna)
    }
  }
  return out
}
