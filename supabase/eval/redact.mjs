// Segunda passagem, depois de redactSecrets do chat_core.
// Os marcadores não reintroduzem sk-or-, Bearer nem eyJ.

export function filtroSegredos(text) {
  return String(text)
    .replace(/sk-or-[A-Za-z0-9_*-]*/gi, '[chave-redigida]')
    .replace(/Bearer\s+\S+/gi, '[autorizacao-redigida]')
    .replace(/Bearer/gi, '[autorizacao-redigida]')
    .replace(/eyJ[A-Za-z0-9_.-]*/g, '[jwt-redigido]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[dsn-redigida]')
    .replace(/postgresql:\/\/\*\*\*/gi, '[dsn-redigida]')
}

export function redigir(text, redactSecrets) {
  const first = typeof redactSecrets === 'function' ? redactSecrets(String(text)) : String(text)
  return filtroSegredos(first)
}
