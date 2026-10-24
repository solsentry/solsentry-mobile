import type { UserClass } from './points'

// Balance that SolSentry computes from the signed results of this device (GET /v1/kyw/points).
// Until the route answers, the app shows its own estimate; a failed read is "not known", never zero.

export interface ServerPoints {
  points: number
  matched: number
  /** ISO time of the first counted result, or null before any. */
  since: string | null
  /** `cap` is null for a device the server does not cap. `resetsAt` (epoch ms) is when the cap window
   * ends, null until the server sends `today.resets_at`. */
  today: { counted: number; cap: number | null; resetsAt: number | null }
  /** The link SolSentry holds for this device (address abbreviated by the server), or null. */
  wallet: { address: string; linkId: number; points: number | null } | null
  /** SKR the server owes this device or its wallet (CONTRATO_APP_para_DEV_EXEC_skr_claim); null until the server sends it. */
  skr: SkrBalance | null
  /** The class SolSentry holds for this key now; null when the server did not send a known one. */
  userClass: UserClass | null
  /** Matched results of the linked wallet per local day (every key, last 28 days); null without a link or from an older server. */
  days: Record<string, number> | null
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
  /** SKR held by `openClaim`, left out of `balanceRaw`; null when there is none or the server does not send it. */
  openClaimRaw: bigint | null
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
  // Optional field: an older server leaves it out, and a bad value only loses the held figure.
  const openClaimRaw = s.open_claim === null ? null : rawAmount(s.open_claim_amount)
  return { balanceRaw, window: { earnedRaw, capRaw }, minClaimRaw, pool: s.pool, openClaim: s.open_claim, openClaimRaw }
}

/** A claim this phone cancelled in the wallet, kept until the server stops holding that claim id. */
export interface CancelledClaim {
  claimId: string
  amountRaw: bigint
}

/** SKR held by an unsent claim: the server's figure, else the amount of that same claim if this phone cancelled it. */
export function heldSkr(s: SkrBalance, cancelled: CancelledClaim | null): bigint | null {
  if (!s.openClaim) return null
  return s.openClaimRaw ?? (cancelled?.claimId === s.openClaim ? cancelled.amountRaw : null)
}

/** What Claim pays: an open claim is carried on for its own amount, else the whole balance. */
export function claimAmount(s: SkrBalance, cancelled: CancelledClaim | null): bigint {
  return heldSkr(s, cancelled) ?? s.balanceRaw
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
    today: { counted: today.counted, cap: today.cap, resetsAt: parseResetsAt(today.resets_at) },
    wallet: parseWallet(b.wallet),
    skr: parseSkr(b.skr),
    userClass: b.user_class === 'unattested' || b.user_class === 'attested' || b.user_class === 'attested_genesis' ? b.user_class : null,
    days: parseDays(b.days),
  }
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** `days` as the server sends it; a bad entry drops the whole field (the grid keeps the phone's history). */
export function parseDays(v: unknown): Record<string, number> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v)) {
    if (!DAY_KEY.test(k) || !count(n) || !Number.isInteger(n)) return null
    out[k] = n
  }
  return out
}

/** Minutes to add to UTC for this phone's local time (Brazil: -180), as `/points` takes it. */
export function tzOffsetMin(at: number): number {
  const m = -new Date(at).getTimezoneOffset()
  return Number.isInteger(m) && m >= -840 && m <= 840 ? m : 0
}

/** The grid's day counts: the wallet's (every phone) where they are higher than this phone's own. */
export function mergeDays(local: Record<string, number>, wallet: Record<string, number> | null): Record<string, number> {
  if (!wallet) return local
  const out = { ...local }
  for (const [k, n] of Object.entries(wallet)) out[k] = Math.max(out[k] ?? 0, n)
  return out
}

/** `resets_at` as an ISO time or as epoch seconds; anything else is "not known". */
export function parseResetsAt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 1_600_000_000 && v < 4_000_000_000) return Math.round(v * 1000)
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

function parseWallet(v: unknown): ServerPoints['wallet'] {
  if (typeof v !== 'object' || v === null) return null
  const w = v as Record<string, unknown>
  if (typeof w.address !== 'string' || typeof w.link_id !== 'number') return null
  // Points written under this wallet, on any phone; the top-level `points` is this phone's.
  return { address: w.address, linkId: w.link_id, points: count(w.points) ? w.points : null }
}

/** Null on any failure (route not deployed, network, bad body): the caller keeps the local estimate. */
export async function fetchServerPoints(
  deps: { fetch: typeof fetch; apiBase: string; tzOffsetMin?: number; via?: { host: string; digest: string } | null },
  deviceKeyId: string,
): Promise<ServerPoints | null> {
  try {
    const tz = deps.tzOffsetMin ?? tzOffsetMin(Date.now())
    // The RPC in use now, so the SKR cap shown follows the same rule as the award.
    const via = deps.via ?? null
    const viaQuery = via ? `&rpc_host=${encodeURIComponent(via.host)}&rpc_url_digest=${via.digest}` : ''
    const res = await deps.fetch(`${deps.apiBase}/v1/kyw/points?device_key_id=${encodeURIComponent(deviceKeyId)}&tz_offset_min=${tz}${viaQuery}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return parseServerPoints(await res.json())
  } catch {
    return null
  }
}

/** The points figure to headline: the linked wallet's total (the account), else this phone's.
 * Points never move between phone and wallet; this only picks which total leads. */
export function headlinePoints(s: ServerPoints): number {
  return s.wallet?.points ?? s.points
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
