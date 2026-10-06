import { API_BASE, RPC_URL } from '../config'
import { SolSentryGuard } from './client'
import type { OperatorProfile } from './types'
import {
  checkRecipient,
  checkSender,
  type RecipientPolicy,
  type RecipientVerdict,
  type SenderVerdict,
} from './checks'

// Fail closed: if a check cannot run, the answer is "block".
const POLICY: RecipientPolicy = { onCheckError: 'block' }

const guard = new SolSentryGuard({ baseUrl: API_BASE, clientId: 'solsentry-guard-mobile' })

function failedClosed(err: unknown, what: string): RecipientVerdict {
  return {
    decision: 'block',
    reasons: ['CHECK_FAILED'],
    explanation: `${what} could not run (${(err as Error)?.message ?? 'unknown error'}); not sending (fail closed).`,
    risk_score: null,
  }
}

type OperatorLookup = { getOperator: (wallet: string) => Promise<OperatorProfile> }
type CheckGuard = Parameters<typeof checkRecipient>[2] & OperatorLookup

const VERDICTS = new Set(['safe', 'caution', 'dangerous', 'unknown'])

/** The client casts the JSON body without validating it; an odd shape must not turn into Allow. */
export function assertAnalysis(a: unknown): void {
  const x = a as { verdict?: unknown; risk_score?: unknown; flags?: unknown } | null
  if (
    !x ||
    typeof x !== 'object' ||
    typeof x.verdict !== 'string' ||
    !VERDICTS.has(x.verdict) ||
    typeof x.risk_score !== 'number' ||
    !Number.isFinite(x.risk_score) ||
    (x.flags != null && !Array.isArray(x.flags))
  ) {
    throw new Error('unexpected API response')
  }
}

/** Wrap the guard so malformed API bodies throw (the vendored checks then fail closed). */
export function withValidation<G extends CheckGuard>(g: G): G {
  return {
    analyzeProgram: async (x: string) => {
      const a = await g.analyzeProgram(x)
      assertAnalysis(a)
      return a
    },
    checkLookalike: g.checkLookalike.bind(g),
    getOperator: async (w: string) => {
      const o = await g.getOperator(w)
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('unexpected API response')
      return o
    },
  } as unknown as G
}

/**
 * The vendored checkRecipient only asks /v1/contract-analysis, which knows catalogued
 * drainers but not deployer history: a wallet with a CRITICAL operator profile comes back
 * "safe". The sender check already reads /v1/operator; the recipient gets the same rule
 * (CRITICAL/HIGH or >= 2 confirmed rugs -> block, MEDIUM or 1 rug -> warn). A failed
 * operator lookup fails closed, like every other check here. The UI text names only the
 * risk level, never per-operator counts (copy rule: counts are re-verified live, not shown here).
 */
export function applyOperatorScreen(v: RecipientVerdict, operator: OperatorProfile): RecipientVerdict {
  const level = (operator?.risk_level ?? '').toUpperCase()
  const rugs = Number(operator?.confirmed_rugs ?? 0) || 0
  if (level === 'CRITICAL' || level === 'HIGH' || rugs >= 2) {
    if (v.decision === 'block') return { ...v, reasons: [...v.reasons, 'OPERATOR_HIGH_RISK'] }
    return {
      ...v,
      decision: 'block',
      reasons: [...v.reasons, 'OPERATOR_HIGH_RISK'],
      explanation: `Blocked: the recipient's deployer profile is ${level || 'high risk'} in SolSentry's records.`,
    }
  }
  if (level === 'MEDIUM' || rugs === 1) {
    if (v.decision !== 'allow') return { ...v, reasons: [...v.reasons, 'OPERATOR_MEDIUM_RISK'] }
    return {
      ...v,
      decision: 'warn',
      reasons: [...v.reasons, 'OPERATOR_MEDIUM_RISK'],
      explanation: `Warning: the recipient's deployer profile is MEDIUM risk in SolSentry's records.`,
    }
  }
  return v
}

export async function screenRecipient(recipient: string, guardIn: CheckGuard): Promise<RecipientVerdict> {
  const g = withValidation(guardIn)
  try {
    const v = await checkRecipient(recipient, POLICY, g)
    if (v.decision === 'block' && v.reasons.includes('CHECK_FAILED')) return v
    const operator = await g.getOperator(recipient)
    return applyOperatorScreen(v, operator)
  } catch (err) {
    return failedClosed(err, 'Recipient check')
  }
}

export async function runRecipientCheck(recipient: string): Promise<RecipientVerdict> {
  return screenRecipient(recipient, guard)
}

export async function screenSender(
  sender: string,
  g: CheckGuard,
  opts: Parameters<typeof checkSender>[3],
): Promise<SenderVerdict> {
  try {
    return await checkSender(sender, POLICY, withValidation(g), opts)
  } catch (err) {
    return failedClosed(err, 'Source-of-funds check')
  }
}

export async function runSenderCheck(sender: string): Promise<SenderVerdict> {
  try {
    return await screenSender(sender, guard, { rpcUrl: RPC_URL })
  } catch (err) {
    return failedClosed(err, 'Source-of-funds check')
  }
}
