import { API_BASE, RPC_URL } from '../config'
import { SolSentryGuard } from './client'
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

export async function runRecipientCheck(recipient: string): Promise<RecipientVerdict> {
  try {
    return await checkRecipient(recipient, POLICY, guard)
  } catch (err) {
    return failedClosed(err, 'Recipient check')
  }
}

export async function runSenderCheck(sender: string): Promise<SenderVerdict> {
  try {
    return await checkSender(sender, POLICY, guard, { rpcUrl: RPC_URL })
  } catch (err) {
    return failedClosed(err, 'Source-of-funds check')
  }
}
