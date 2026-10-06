const LAMPORTS_PER_SOL = 1_000_000_000n
const U64_MAX = 18_446_744_073_709_551_615n
const BAD_AMOUNT = 'Enter an amount like 0.05'

/**
 * SOL amount (decimal string) to lamports without floating point. Throws on bad input.
 * Accepts a comma decimal separator ("0,05", as the pt-BR keypad types) and ".5".
 */
export function parseSolToLamports(input: string): bigint {
  const s = input.trim().replace(',', '.')
  if (!/^(\d+)?(\.\d{1,9})?$/.test(s) || !/\d/.test(s)) throw new Error(BAD_AMOUNT)
  const [whole = '', frac = ''] = s.split('.')
  const lamports = BigInt(whole || '0') * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, '0'))
  if (lamports <= 0n) throw new Error('Amount must be greater than zero.')
  if (lamports > U64_MAX) throw new Error(BAD_AMOUNT)
  return lamports
}

export const STALE_VERDICT_MESSAGE = 'This check is out of date. Run it again before sending.'

/** Throws if the verdict is older than `maxAgeMs`; called right before the transaction is built. */
export function assertVerdictFresh(checkedAt: number, maxAgeMs: number, now: number = Date.now()): void {
  if (!Number.isFinite(checkedAt) || now - checkedAt > maxAgeMs) throw new Error(STALE_VERDICT_MESSAGE)
}

/** Lamports back to a plain SOL string (no float), trailing zeros trimmed. */
export function formatLamportsAsSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}
