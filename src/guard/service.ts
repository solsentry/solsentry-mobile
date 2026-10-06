import { API_BASE, RPC_URL } from '../config'
import { SolSentryGuard } from './client'
import type { LookalikeResult, OperatorProfile } from './types'
import {
  buildContacts,
  contactsFromHistory,
  fetchWalletRecipients,
  lookalikeExplanation,
  markContactsPartial,
  partialLookalikeExplanation,
} from './contacts'
import type { HistoryEntry } from '../state/history-logic'
import {
  checkRecipient,
  checkSender,
  type RecipientPolicy,
  type RecipientVerdict,
  type SenderVerdict,
} from './checks'

// Fail closed: if a check cannot run, the answer is "block".
const POLICY: RecipientPolicy = { onCheckError: 'block' }

export const RPC_TIMEOUT_MS = 10_000
const API_TIMEOUT_MS = 10_000

// The client's own 8 s timer stops at the headers; this wrapper also bounds the body read.
const guard = new SolSentryGuard({
  baseUrl: API_BASE,
  clientId: 'solsentry-guard-mobile',
  fetch: fetchWithTimeout((u, i) => globalThis.fetch(u, i), API_TIMEOUT_MS, 'SolSentry API request'),
})

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

export const QUOTA_MESSAGE = 'SolSentry free daily quota reached on this network; try again later.'

/** The anonymous API tier is 50 credits/day per IP: say that, instead of a bare "API 429". Still a Block. */
function explainQuota(e: unknown): unknown {
  return (e as { status?: number } | null)?.status === 429 ? new Error(QUOTA_MESSAGE) : e
}

/** Wrap the guard so malformed API bodies throw (the vendored checks then fail closed). */
export function withValidation<G extends CheckGuard>(g: G): G {
  return {
    analyzeProgram: async (x: string) => {
      const a = await g.analyzeProgram(x).catch((e) => {
        throw explainQuota(e)
      })
      assertAnalysis(a)
      return a
    },
    checkLookalike: (d: string, c: string[]) =>
      g.checkLookalike(d, c).catch((e) => {
        throw explainQuota(e)
      }),
    getOperator: async (w: string) => {
      const o = await g.getOperator(w).catch((e) => {
        throw explainQuota(e)
      })
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

/**
 * The API answers "safe" for a mint or a program ID, but SOL sent to either is lost (mint) or
 * the transfer fails (program). A recipient that is not a wallet is never plain Allow.
 * Only raises severity: an existing block stays as it is, a warn only goes up to block.
 */
export function applyKindScreen(v: RecipientVerdict): RecipientVerdict {
  const kind = v.analysis?.kind
  if (typeof kind !== 'string' || kind === '' || kind === 'wallet' || v.decision === 'block') return v
  const reasons = [...v.reasons, 'NOT_A_WALLET']
  if (kind === 'mint') {
    return {
      ...v,
      decision: 'block',
      reasons,
      explanation: 'Blocked: this address is a token mint, not a wallet. SOL sent to a token mint is lost.',
    }
  }
  if (kind === 'program') {
    return {
      ...v,
      decision: 'block',
      reasons,
      explanation: 'Blocked: this address is a program, not a wallet. A transfer to a program does not reach a person.',
    }
  }
  if (v.decision === 'warn') return { ...v, reasons }
  return {
    ...v,
    decision: 'warn',
    reasons,
    explanation: `Warning: this address is not a plain wallet (${kind}). Check it before sending.`,
  }
}

/**
* The live /v1/lookalike-check answers { suspect, confidence, findings: [{ original_contact, ... }] },
 * while the vendored checkRecipient reads { is_lookalike, findings: [{ contact }] }. Without this
 * mapping the check would run and never fire. The API reports a finding when EITHER end matches
 * (>= 4 chars) and rates plain string collisions "weak". Poisoning addresses copy BOTH ends, so:
 * both ends match (or the API says suspect) -> lookalike, Block; one end only -> Warning
 * (vanity prefixes are common). A finding without match lengths is treated as both ends (strict).
 */
const MATCH_LEN = 4
const BOTH_ENDS = 'both_ends'
const ONE_END = 'one_end'

export function normalizeLookalike(raw: unknown, destination: string): LookalikeResult {
  const r = (raw ?? {}) as {
    findings?: { original_contact?: string; contact?: string; prefix_match?: number; suffix_match?: number }[]
    suspect?: boolean
    is_lookalike?: boolean
  }
  // Unexpected shape: neither a verdict field nor a findings array -> cannot tell, fail closed.
  if (typeof r.suspect !== 'boolean' && typeof r.is_lookalike !== 'boolean' && !Array.isArray(r.findings)) {
    throw new Error('unexpected /v1/lookalike-check response shape')
  }
  const findings = (Array.isArray(r.findings) ? r.findings : []).map((f) => {
    const p = typeof f.prefix_match === 'number' ? f.prefix_match : MATCH_LEN
    const sfx = typeof f.suffix_match === 'number' ? f.suffix_match : MATCH_LEN
    return {
      contact: f.original_contact ?? f.contact ?? '',
      similarity: p + sfx,
      reason: p >= MATCH_LEN && sfx >= MATCH_LEN ? BOTH_ENDS : ONE_END,
    }
  })
  // Both-ends findings first, so the explanation names the strongest match.
  findings.sort((a, b) => (a.reason === b.reason ? b.similarity - a.similarity : a.reason === BOTH_ENDS ? -1 : 1))
  return {
    destination,
    is_lookalike: r.is_lookalike === true || r.suspect === true || findings.some((f) => f.reason === BOTH_ENDS),
    findings,
  }
}

type LookalikeSource = { checkLookalike: (d: string, c: string[]) => Promise<unknown> }

export async function screenRecipient(
  recipient: string,
  guardIn: CheckGuard,
  contacts: string[] = [],
): Promise<RecipientVerdict> {
  const g = withValidation(guardIn)
  try {
    const known = contacts.filter((c) => c && c !== recipient)
    // The vendored check swallows a lookalike error into a bare CHECK_FAILED; keep it to show the reason.
    let lookalikeError: unknown
    const wrapped = {
      analyzeProgram: (a: string) => g.analyzeProgram(a),
      checkLookalike: async (d: string, c: string[]) => {
        try {
          return normalizeLookalike(await (g as unknown as LookalikeSource).checkLookalike(d, c), d)
        } catch (e) {
          lookalikeError = e
          throw e
        }
      },
    } as Parameters<typeof checkRecipient>[2]
    let v = await checkRecipient(recipient, { ...POLICY, contacts: known }, wrapped)
    if (lookalikeError !== undefined) return failedClosed(lookalikeError, 'Lookalike check')
    if (v.reasons.includes('LOOKALIKE')) {
      v = { ...v, decision: 'block', explanation: lookalikeExplanation(recipient, v.lookalike?.findings[0]?.contact) }
    } else if (v.decision !== 'block' && v.lookalike?.findings.length) {
      v = {
        ...v,
        decision: 'warn',
        reasons: [...v.reasons, 'LOOKALIKE_PARTIAL'],
        explanation: partialLookalikeExplanation(recipient, v.lookalike.findings[0].contact),
      }
    }
    if (v.decision === 'block' && v.reasons.includes('CHECK_FAILED')) return v
    const operator = await g.getOperator(recipient)
    return applyKindScreen(applyOperatorScreen(v, operator))
  } catch (err) {
    return failedClosed(err, 'Recipient check')
  }
}

export interface ContactSources {
  history: HistoryEntry[]
  /** Connected wallet address, if any; enables the on-chain recent-recipients source. */
  wallet?: string | null
}

export async function runRecipientCheck(recipient: string, src?: ContactSources): Promise<RecipientVerdict> {
  const onChain = src?.wallet ? await fetchWalletRecipients(src.wallet, RPC_URL) : { recipients: [], ok: true }
  const contacts = buildContacts(recipient, [contactsFromHistory(src?.history ?? []), onChain.recipients])
  const v = await screenRecipient(recipient, guard, contacts)
  return onChain.ok ? v : markContactsPartial(v)
}


/**
 * fetch that gives up after `ms`, counting the response BODY too: the body is read inside the
 * deadline and handed back as a buffered Response. A server that sends headers and then stalls
 * becomes an error (-> Block), not a frozen screen.
 */
export function fetchWithTimeout(base: typeof fetch, ms: number = RPC_TIMEOUT_MS, what = 'RPC request'): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`))
      }, ms)
    })
    const buffered = base(input, { ...init, signal: ctrl.signal }).then(
      async (res) =>
        new Response(await res.text(), { status: res.status, statusText: res.statusText, headers: res.headers }),
    )
    return Promise.race([buffered, timeout]).finally(() => clearTimeout(timer))
  }) as typeof fetch
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
    return await screenSender(sender, guard, {
      rpcUrl: RPC_URL,
      fetch: fetchWithTimeout((u, i) => globalThis.fetch(u, i)),
    })
  } catch (err) {
    return failedClosed(err, 'Source-of-funds check')
  }
}
