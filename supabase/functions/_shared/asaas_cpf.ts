export function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, '')
}

export function cpfValido(digitos: string): boolean {
  if (!/^\d{11}$/.test(digitos) || /^(\d)\1{10}$/.test(digitos)) return false
  const digito = (len: number) => {
    let soma = 0
    for (let i = 0; i < len; i++) soma += Number(digitos[i]) * (len + 1 - i)
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }
  return digito(9) === Number(digitos[9]) && digito(10) === Number(digitos[10])
}

export function cnpjValido(digitos: string): boolean {
  if (!/^\d{14}$/.test(digitos) || /^(\d)\1{13}$/.test(digitos)) return false
  const peso1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const peso2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const digito = (pesos: number[], len: number) => {
    let soma = 0
    for (let i = 0; i < len; i++) soma += Number(digitos[i]) * pesos[i]
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }
  return digito(peso1, 12) === Number(digitos[12]) && digito(peso2, 13) === Number(digitos[13])
}

export function cpfCnpjValido(valor: string): boolean {
  const digitos = somenteDigitos(valor)
  if (digitos.length === 11) return cpfValido(digitos)
  if (digitos.length === 14) return cnpjValido(digitos)
  return false
}
