// Estimated points, computed on the phone from results SolSentry accepted. This is a display
// estimate: a number kept on a phone can be edited, so the balance that counts is the one the
// server computes from signed results. The rule below is one place on purpose.
import type { ProbeReport } from './probe'
import type { ProviderId } from './providers'

// Rule closed 10/10/2026 (rev. 2). Until the server binds the key to its attestation and the wallet
// to its Genesis token, it treats every phone as not attested: base points, daily cap, no
// multiplier. The estimate follows what the server counts today; the multipliers are shown as planned.
export const POINT_RULE = {
  /** One matched, signed result. */
  base: 1,
  /** Points a phone can earn per day while the server treats it as not attested. */
  dailyCap: 200,
  /** The linked wallet holds a Seeker Genesis Token (server rule since 11/10). */
  genesis: 2,
  /** The read came from the user's own RPC, tested with every capability full. */
  independentRpc: 1.1,
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

/** Planned multiplier for this phone (not applied to the estimate yet). */
export function multiplier(ctx: PointsContext): number {
  if (!ctx.deviceVerified) return 0
  return POINT_RULE.base * (ctx.genesis ? POINT_RULE.genesis : 1) * (ctx.independentRpc ? POINT_RULE.independentRpc : 1)
}

/** Points are stored as halves (rev. 1 had a 1.5 multiplier); today only whole points are added. */
export const toHalves = (points: number): number => Math.round(points * 2)

export function formatPoints(halves: number): string {
  const whole = Math.floor(halves / 2)
  return `${whole.toLocaleString('en-US')}${halves % 2 ? '.5' : ''}`
}

export function multiplierText(m: number): string {
  return `${Number.isInteger(m) ? m : m.toFixed(1)}×`
}
