// Estimated points, computed on the phone from results SolSentry accepted. This is a display
// estimate: a number kept on a phone can be edited, so the balance that counts is the one the
// server computes from signed results. The rule below is one place on purpose.
import type { ProbeReport } from './probe'
import type { ProviderId } from './providers'

// Rule decided 11/10/2026 22:30 (PROPOSTA_badges_multiplicadores, "DECIDIDO"): bonuses add up, they do
// not multiply. 1 point per matched result, +0.2 attested device, +0.3 Seeker Genesis wallet, +0.1 own
// tested RPC; at most 1.6. The server (integrations/kyw/points.py) is the record; this is its mirror.
export const POINT_RULE = {
  /** One matched, signed result. */
  base: 1,
  /** Points a phone can earn per day while the server treats it as not attested. */
  dailyCap: 200,
  /** SolSentry checked this phone's hardware key (class attested). */
  attested: 0.2,
  /** The linked wallet holds a Seeker Genesis Token (class attested_genesis). */
  genesis: 0.3,
  /** The read came from the user's own RPC, tested with every capability full. */
  independentRpc: 0.1,
  /** Points per SKR (integrations/kyw/points.py SKR_PER_POINT = 1/40). */
  pointsPerSkr: 40,
} as const

export interface PointsContext {
  deviceVerified: boolean
  genesis: boolean
  independentRpc: boolean
}

/** The server's classes (integrations/kyw/points.py): attested = SolSentry verified the key; genesis adds a linked Genesis wallet. */
export type UserClass = 'unattested' | 'attested' | 'attested_genesis'

/**
 * What SolSentry holds wins over what the phone remembers: a key verified once on the phone may
 * have no attestation on the server (a cached "verified" is not a class). Own RPC stays local.
 */
export function withServerClass(ctx: PointsContext, userClass: UserClass | null): PointsContext {
  if (userClass === null) return ctx
  return { ...ctx, deviceVerified: userClass !== 'unattested', genesis: userClass === 'attested_genesis' }
}

/** True when the report for this provider measured every capability as full and found a safe pace. */
export function isFullRpc(report: ProbeReport | null | undefined): boolean {
  if (!report) return false
  const c = report.capabilities
  return [c.C1, c.C2, c.C3, c.C4, c.C5].every((x) => x.class === 'full') && c.C6.min_interval_ms !== null
}

export function independentRpc(provider: ProviderId, report: ProbeReport | null | undefined): boolean {
  return provider !== 'solsentry' && isFullRpc(report)
}

/**
 * What one matched result adds to the estimate today: the base when the result went out signed and
 * the UTC day is under the cap. `matchedToday` counts the matched, signed results of that day so far.
 */
export function earnedNow(p: { signed: boolean; matchedToday: number }): number {
  return p.signed && p.matchedToday < POINT_RULE.dailyCap ? POINT_RULE.base : 0
}

/** Points one matched result earns on this phone: the base plus each bonus it holds (bonuses need an attested key). */
export function pointsPerResult(ctx: PointsContext): number {
  if (!ctx.deviceVerified) return POINT_RULE.base
  const p = POINT_RULE.base + POINT_RULE.attested + (ctx.genesis ? POINT_RULE.genesis : 0) + (ctx.independentRpc ? POINT_RULE.independentRpc : 0)
  return Math.round(p * 10) / 10
}

/** Points are stored as halves (rev. 1 had a 1.5 multiplier); today only whole points are added. */
export const toHalves = (points: number): number => Math.round(points * 2)

export function formatPoints(halves: number): string {
  const whole = Math.floor(halves / 2)
  return `${whole.toLocaleString('en-US')}${halves % 2 ? '.5' : ''}`
}

/** 1.5 → "1.5", 1 → "1.0": points per result, always one decimal. */
export function pointsText(p: number): string {
  return p.toFixed(1)
}

/** A bonus as the app shows it: 0.3 → "+0.3". */
export function bonusText(b: number): string {
  return `+${b.toFixed(1)}`
}

/** Shown while the linked wallet is known to hold no Genesis Token and the user has not closed it for that wallet. */
export function showNoGenesis(wallet: { address: string; genesis: boolean; sgt: { status: string } } | null, seen: string | null): boolean {
  return wallet !== null && !wallet.genesis && wallet.sgt.status === 'none' && seen !== wallet.address
}
