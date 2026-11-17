import { createMemoryDb } from './memory_db.ts'

function check(ok: boolean, label: string) { if (!ok) throw new Error(label) }
const USER = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-11-11T12:00:00Z')

Deno.test('SEC-02 memória não grava bloqueios de minuto ou dia', async () => {
  for (const kind of ['minute', 'day']) {
    const db = createMemoryDb()
    db.seedRate(USER, kind === 'minute' ? 10 : 200, kind === 'minute' ? NOW : new Date(NOW.getTime() - 120_000))
    const before = db.rateEventCount(USER)
    for (let i = 0; i < 50; i++) {
      const rate = await db.rateTouch(USER, NOW)
      check(kind === 'minute' ? rate.minuteCount === 11 : rate.dayCount === 201, 'contagem bloqueadora estável')
    }
    check(db.rateEventCount(USER) === before, 'zero INSERT após bloqueio')
  }
})

Deno.test('SEC-02 fronteira, exceção privada e concorrência em memória', async () => {
  const db = createMemoryDb()
  db.seedRate(USER, 9, NOW)
  check((await db.rateTouch(USER, NOW)).minuteCount === 10, 'décimo aceito')
  await Promise.all(Array.from({ length: 20 }, () => db.rateTouch(USER, NOW)))
  check(db.rateEventCount(USER) === 10, 'concorrência não ultrapassa dez')
  db.setUnlimited(USER)
  const rate = await db.rateTouch(USER, NOW)
  check(rate.minuteCount === 0 && rate.dayCount === 0, 'exceção continua ilimitada')
  check(db.rateEventCount(USER) === 11, 'exceção continua registrada')
  const later = await db.rateTouch('outro', new Date(NOW.getTime() + 61_000))
  check(later.minuteCount === 1, 'outro usuário independente')
})
