// Balance that SolSentry computes from the signed results of this device (GET /v1/kyw/points).
// Until the route answers, the app shows its own estimate; a failed read is "not known", never zero.

export interface ServerPoints {
  points: number
  matched: number
  /** ISO time of the first counted result, or null before any. */
  since: string | null
  /** `cap` is null for a device the server does not cap. */
  today: { counted: number; cap: number | null }
  /** The link SolSentry holds for this device (address abbreviated by the server), or null. */
  wallet: { address: string; linkId: number } | null
  /** SKR the server owes this device or its wallet (CONTRATO_APP_para_DEV_EXEC_skr_claim); null until the server sends it. */
  skr: SkrBalance | null
}

export interface SkrBalance {
  /** In base units (6 decimals); the phone never derives it from points. Belongs to the linked wallet. */
  balanceRaw: bigint
  /** SKR earned in this window and the cap the server pays under (a valid own-RPC probe lifts it). */
  window: { earnedRaw: bigint; capRaw: bigint }
  minClaimRaw: bigint
  /** unknown = SolSentry has not read the pool yet. */
  pool: 'ok' | 'empty' | 'unknown'
  openClaim: string | null
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

const units = (v: unknown): bigint | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null)

/** A non-negative integer sent as a decimal string, or null. */
export function rawAmount(v: unknown): bigint | null {
  return typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : units(v)
}

export function parseSkr(v: unknown): SkrBalance | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as Record<string, unknown>
  const w = s.window as Record<string, unknown> | null | undefined
  const balanceRaw = units(s.balance)
  const minClaimRaw = units(s.claim_min)
  const earnedRaw = w ? units(w.earned) : null
  const capRaw = w ? units(w.cap) : null
  if (s.decimals !== 6 || balanceRaw === null || minClaimRaw === null || earnedRaw === null || capRaw === null) return null
  if (s.pool !== 'ok' && s.pool !== 'empty' && s.pool !== 'unknown') return null
  if (s.open_claim !== null && typeof s.open_claim !== 'string') return null
  return { balanceRaw, window: { earnedRaw, capRaw }, minClaimRaw, pool: s.pool, openClaim: s.open_claim }
}

/** Cap 0 = this device earns no SKR now (Seeker phase: Genesis wallets only); points still count. */
export function skrClosed(s: SkrBalance): boolean {
  return s.window.capRaw === 0n
}

/** The fields the app reads; anything else in the body is ignored. Null when the body is not a balance. */
export function parseServerPoints(body: unknown): ServerPoints | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const today = b.today as Record<string, unknown> | null | undefined
  if (!count(b.points) || !count(b.matched)) return null
  if (b.since !== null && typeof b.since !== 'string') return null
  if (typeof today !== 'object' || today === null || !count(today.counted)) return null
  if (today.cap !== null && !count(today.cap)) return null
  return {
    points: b.points,
    matched: b.matched,
    since: b.since,
    today: { counted: today.counted, cap: today.cap },
    wallet: parseWallet(b.wallet),
    skr: parseSkr(b.skr),
  }
}

function parseWallet(v: unknown): ServerPoints['wallet'] {
  if (typeof v !== 'object' || v === null) return null
  const w = v as Record<string, unknown>
  return typeof w.address === 'string' && typeof w.link_id === 'number' ? { address: w.address, linkId: w.link_id } : null
}

/** Null on any failure (route not deployed, network, bad body): the caller keeps the local estimate. */
export async function fetchServerPoints(
  deps: { fetch: typeof fetch; apiBase: string },
  deviceKeyId: string,
): Promise<ServerPoints | null> {
  try {
    const res = await deps.fetch(`${deps.apiBase}/v1/kyw/points?device_key_id=${encodeURIComponent(deviceKeyId)}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return parseServerPoints(await res.json())
  } catch {
    return null
  }
}

/** Up to two decimals: whole while no multiplier applies, 1.1× results leave a fraction. */
export function formatServerPoints(points: number): string {
  return points.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** SKR from base units: up to the 6 decimals it has, trailing zeros dropped, thousands grouped. */
export function formatSkr(raw: bigint): string {
  const whole = raw / 1_000_000n
  const frac = (raw % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac ? `${w}.${frac}` : w
}

/** The mockup's figure: whole and two decimals large, the next two small (`100.02` `56`). */
export function skrFigure(raw: bigint): { main: string; tail: string } {
  const whole = (raw / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (raw % 1_000_000n).toString().padStart(6, '0')
  return { main: `${whole}.${frac.slice(0, 2)}`, tail: frac.slice(2, 4) }
}
