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

/**
 * The vendored checkRecipient only asks /v1/contract-analysis, which knows catalogued
 * drainers but not deployer history: a wallet with a CRITICAL operator profile comes back
 * "safe". The sender check already reads /v1/operator; the recipient gets the same rule
 * (CRITICAL/HIGH or >= 2 confirmed rugs -> block, MEDIUM or 1 rug -> warn). A failed
 * operator lookup fails closed, like every other check here.
 */
export function applyOperatorScreen(v: RecipientVerdict, operator: OperatorProfile): RecipientVerdict {
  const level = (operator?.risk_level ?? '').toUpperCase()
  const rugs = Number(operator?.confirmed_rugs ?? 0) || 0
  const summary = typeof operator?.summary === 'string' ? operator.summary : ''
  if (level === 'CRITICAL' || level === 'HIGH' || rugs >= 2) {
    if (v.decision === 'block') return { ...v, reasons: [...v.reasons, 'OPERATOR_HIGH_RISK'] }
    return {
      ...v,
      decision: 'block',
      reasons: [...v.reasons, 'OPERATOR_HIGH_RISK'],
      explanation: `Blocked: recipient has a ${level || 'high-risk'} deployer profile${summary ? ` (${summary})` : ''}.`,
    }
  }
  if (level === 'MEDIUM' || rugs === 1) {
    if (v.decision !== 'allow') return { ...v, reasons: [...v.reasons, 'OPERATOR_MEDIUM_RISK'] }
    return {
      ...v,
      decision: 'warn',
      reasons: [...v.reasons, 'OPERATOR_MEDIUM_RISK'],
      explanation: `Warning: recipient has a MEDIUM deployer profile${summary ? ` (${summary})` : ''}.`,
    }
  }
  return v
}

export async function screenRecipient(
  recipient: string,
  g: Parameters<typeof checkRecipient>[2] & OperatorLookup,
): Promise<RecipientVerdict> {
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

export async function runSenderCheck(sender: string): Promise<SenderVerdict> {
  try {
    return await checkSender(sender, POLICY, guard, { rpcUrl: RPC_URL })
  } catch (err) {
    return failedClosed(err, 'Source-of-funds check')
  }
}
