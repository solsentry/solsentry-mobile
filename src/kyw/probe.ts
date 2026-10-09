// Capability probe (probe_version "0"), device side. Spec: SPEC_DEV_CASE_sonda_capacidade_2026-10-09.
// It measures what the chosen RPC can do for this user: recent and old transactions, signature
// pages, account state, and the request pace that does not hit a rate limit. The targets are
// public and come from the server; the key never leaves the phone and only the host is reported.
// The report is a declaration measured by the declarant: the server must re-check by sample.

export interface ProbeTargets {
  probe_version: string
  recent_signature: string
  archival_signature: string
  page_address: string
  page_before_signature: string
  account: string
  read: { encoding: string; maxSupportedTransactionVersion: number; commitment: string }
}

export type CapabilityClass = 'full' | 'limited' | 'none' | 'rate_limited' | 'version'

export interface Capability {
  class: CapabilityClass
  ms?: number
  page_size?: number
  /** Short fixed code. Never an endpoint, a URL or a response body. */
  reason?: 'rpc_error' | 'http_error' | 'timeout' | 'not_available' | 'empty_page' | 'invalid_response' | 'rate_limited' | 'version'
}

export interface ProbeReport {
  probe_version: string
  rpc_host: string
  measured_at: string
  capabilities: {
    C1: Capability
    C2: Capability
    C3: Capability
    C4: Capability
    C5: Capability
    C6: { min_interval_ms: number | null }
  }
  client: { kind: string; version: string }
}

export interface ProbeDeps {
  /** fetch that rejects on a deadline covering the body. */
  fetch: typeof fetch
  /** Full RPC URL; may carry the user's key. Used only as the request target. */
  url: string
  /** What may be reported. */
  host: string
  targets: ProbeTargets
  clientVersion: string
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export const PROBE_VERSION = '0'
export const PAGE_LIMIT = 1000
/** Calls per pace burst. */
export const PACE_BURST = 3
/** Gaps tried between the calls of a burst, shortest first (spec section 5). */
export const PACE_GAPS_MS = [250, 600, 1200] as const
/** A class is good for this long, then the phone is treated as C1-only until it probes again. */
export const PROBE_TTL_MS = 6 * 60 * 60 * 1000

type Outcome =
  | { kind: 'result'; result: unknown; ms: number }
  | { kind: 'fail'; capability: Capability; noAnswer?: boolean }

async function call(deps: ProbeDeps, method: string, params: unknown[]): Promise<Outcome> {
  const started = deps.now()
  let res: Response
  let text: string
  try {
    res = await deps.fetch(deps.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    text = await res.text()
  } catch (e) {
    const timeout = e instanceof Error && /timed out/i.test(e.message)
    return { kind: 'fail', capability: { class: 'none', reason: timeout ? 'timeout' : 'rpc_error' }, noAnswer: true }
  }
  const ms = Math.max(0, Math.round(deps.now() - started))
  if (res.status === 429) return { kind: 'fail', capability: { class: 'rate_limited', reason: 'rate_limited' } }
  let body: { error?: { code?: unknown; message?: unknown }; result?: unknown } | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed
  } catch {
    body = null
  }
  if (body && body.error !== undefined && body.error !== null) {
    const message = typeof body.error.message === 'string' ? body.error.message.toLowerCase() : ''
    if (body.error.code === 429 || message.includes('rate')) return { kind: 'fail', capability: { class: 'rate_limited', reason: 'rate_limited' } }
    if (message.includes('version')) return { kind: 'fail', capability: { class: 'version', reason: 'version' } }
    return { kind: 'fail', capability: { class: 'none', reason: 'rpc_error' } }
  }
  if (!res.ok) return { kind: 'fail', capability: { class: 'none', reason: 'http_error' } }
  if (!body) return { kind: 'fail', capability: { class: 'none', reason: 'invalid_response' } }
  // A null result is "this endpoint does not have it", never "it does not exist".
  if (body.result === null || body.result === undefined) {
    return { kind: 'fail', capability: { class: 'none', reason: 'not_available' } }
  }
  return { kind: 'result', result: body.result, ms }
}

async function present(deps: ProbeDeps, method: string, params: unknown[]): Promise<Capability> {
  const out = await call(deps, method, params)
  return out.kind === 'fail' ? out.capability : { class: 'full', ms: out.ms }
}

async function page(deps: ProbeDeps, params: unknown[], limit: number, shortIsLimited: boolean): Promise<Capability> {
  const out = await call(deps, 'getSignaturesForAddress', params)
  if (out.kind === 'fail') return out.capability
  if (!Array.isArray(out.result)) return { class: 'none', reason: 'invalid_response' }
  const size = out.result.length
  if (size === 0) return { class: 'none', reason: 'empty_page' }
  if (shortIsLimited && size < limit) return { class: 'limited', page_size: size, ms: out.ms }
  return { class: 'full', ms: out.ms }
}

/**
 * Three reads of the recent transaction, `gap` apart, with the task's own method and options: a
 * light call such as getSlot does not trigger the limit a real task triggers. True when none of
 * the three was rate limited and the endpoint answered at least once.
 */
async function paceHolds(deps: ProbeDeps, gap: number): Promise<boolean> {
  const params = [deps.targets.recent_signature, { ...deps.targets.read }]
  let answered = false
  for (let i = 0; i < PACE_BURST; i++) {
    if (i > 0) await deps.sleep(gap)
    const out = await call(deps, 'getTransaction', params)
    if (out.kind === 'fail' && out.capability.class === 'rate_limited') return false
    if (!(out.kind === 'fail' && out.noAnswer)) answered = true
  }
  // An endpoint that never answered says nothing about its pace.
  return answered
}

export async function runProbe(deps: ProbeDeps): Promise<ProbeReport> {
  const t = deps.targets
  const read = { ...t.read }
  const C1 = await present(deps, 'getTransaction', [t.recent_signature, read])
  const C2 = await present(deps, 'getTransaction', [t.archival_signature, read])
  const C3 = await page(deps, [t.page_address, { limit: PAGE_LIMIT }], PAGE_LIMIT, true)
  const C4 = await page(deps, [t.page_address, { limit: 10, before: t.page_before_signature }], 10, false)
  const C5 = await present(deps, 'getAccountInfo', [t.account, { encoding: 'base64' }])
  let minInterval: number | null = null
  for (const gap of PACE_GAPS_MS) {
    await deps.sleep(gap)
    if (await paceHolds(deps, gap)) {
      minInterval = gap
      break
    }
  }
  return {
    probe_version: PROBE_VERSION,
    rpc_host: deps.host,
    measured_at: new Date(deps.now()).toISOString(),
    capabilities: { C1, C2, C3, C4, C5, C6: { min_interval_ms: minInterval } },
    client: { kind: 'android', version: deps.clientVersion },
  }
}

/** Read GET /v1/kyw/probe. null when the targets are not ones this client understands. */
export function parseProbeTargets(body: unknown): ProbeTargets | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const read = b.read as Record<string, unknown> | null | undefined
  const base58 = (v: unknown, min: number): v is string => typeof v === 'string' && new RegExp(`^[1-9A-HJ-NP-Za-km-z]{${min},90}$`).test(v)
  if (b.probe_version !== PROBE_VERSION) return null
  if (!base58(b.recent_signature, 64) || !base58(b.archival_signature, 64) || !base58(b.page_before_signature, 64)) return null
  if (!base58(b.page_address, 32) || !base58(b.account, 32)) return null
  if (typeof read !== 'object' || read === null) return null
  // Version 1 is not negotiable: asking for 0 makes a v1 transaction look missing.
  if (read.encoding !== 'jsonParsed' || read.maxSupportedTransactionVersion !== 1 || read.commitment !== 'finalized') return null
  return {
    probe_version: PROBE_VERSION,
    recent_signature: b.recent_signature,
    archival_signature: b.archival_signature,
    page_address: b.page_address,
    page_before_signature: b.page_before_signature,
    account: b.account,
    read: { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' },
  }
}

/** Has the stored report expired, or was it measured for another host? */
export function probeIsStale(report: ProbeReport | null, host: string, now: number): boolean {
  if (!report || report.rpc_host !== host) return true
  const at = Date.parse(report.measured_at)
  return !Number.isFinite(at) || now - at > PROBE_TTL_MS || at > now + 60_000
}
