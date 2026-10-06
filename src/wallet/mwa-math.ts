const LAMPORTS_PER_SOL = 1_000_000_000n

/** SOL amount (decimal string) to lamports without floating point. Throws on bad input. */
export function parseSolToLamports(input: string): bigint {
  const s = input.trim()
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error('Enter an amount in SOL with at most 9 decimals.')
  const [whole, frac = ''] = s.split('.')
  const lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, '0'))
  if (lamports <= 0n) throw new Error('Amount must be greater than zero.')
  return lamports
}
