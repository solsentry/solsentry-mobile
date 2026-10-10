// Estimated points, computed on the phone from results SolSentry accepted. This is a display
// estimate: a number kept on a phone can be edited, so the balance that counts is the one the
// server computes from signed results. The rule below is one place on purpose.
import type { ProbeReport } from './probe'
import type { ProviderId } from './providers'

export const POINT_RULE = {
  /** One matched result on a hardware-verified phone. */
  base: 1,
  /** The linked wallet holds a Seeker Genesis Token. */
  genesis: 2,
  /** The read came from an RPC other than SolSentry's own, tested with every capability full. */
  independentRpc: 1.5,
} as const

export interface PointsContext {
  deviceVerified: boolean
  genesis: boolean
  independentRpc: boolean
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

export function multiplier(ctx: PointsContext): number {
  if (!ctx.deviceVerified) return 0
  return POINT_RULE.base * (ctx.genesis ? POINT_RULE.genesis : 1) * (ctx.independentRpc ? POINT_RULE.independentRpc : 1)
}

/** Points are stored as halves so the 1.5 multiplier stays an integer. */
export const toHalves = (points: number): number => Math.round(points * 2)

export function formatPoints(halves: number): string {
  const whole = Math.floor(halves / 2)
  return `${whole.toLocaleString('en-US')}${halves % 2 ? '.5' : ''}`
}

export function multiplierText(m: number): string {
  return `${Number.isInteger(m) ? m : m.toFixed(1)}×`
}
