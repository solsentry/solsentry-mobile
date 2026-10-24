// One validation: get a task, read the transaction, compute the fact, send the result.
// Every failure ends as a record with verdict `unknown` and a reason; nothing here throws.
import { READ_PARAMS, buildEnvelope, parseTask, readOutcome, shortId, utf8, type ReadOutcome, type Task } from '../kyw-core'
import type { SignedResultFields } from './device'
import { rpcUrlDigest, type Endpoint, type ProviderId } from './providers'
import { RPC_URL_DIGEST } from '../config'
import type { TaskRecord, Verdict } from './types'

export const HTTP_TIMEOUT_MS = 10_000

export interface RunDeps {
  /** fetch that rejects on a deadline covering the body (see fetchWithTimeout). */
  fetch: typeof fetch
  apiBase: string
  provider: ProviderId
  endpoint: Extract<Endpoint, { ok: true }>
  clientVersion: string
  now: () => number
  /** Called once the task is known, with the short form of its signature. */
  onReading?: (short: string) => void
  /** Install id sent with the task request and the result (null: none). */
  deviceKeyId?: string | null
  /** Signs the result (device_sig); null when the install has no key. */
  signResult?: (r: SignedResultFields) => Promise<string | null>
}

export interface RunResult {
  record: TaskRecord
  /** Seconds the server or the RPC asked us to wait (Retry-After), when it did. */
  retryAfterS: number | null
  /** The network, the server or the RPC pushed back: the caller should slow down. */
  backoff: boolean
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && /timed out/i.test(e.message)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function retryAfter(res: Response): number | null {
  const s = Number(res.headers.get('Retry-After'))
  return Number.isFinite(s) && s > 0 ? Math.min(s, 300) : null
}

function unknownOutcome(reason: 'rpc_error' | 'rate_limited' | 'timeout'): ReadOutcome {
  return { status: 'unknown', unknownReason: reason, fact: null, factDigest: null, failed: null }
}

async function readTransaction(
  deps: RunDeps,
  task: Task,
): Promise<{ outcome: ReadOutcome; bytes: number; retryAfterS: number | null; keyRejected?: boolean }> {
  const params = [task.signature, { ...READ_PARAMS }]
  const { endpoint } = deps
  const url = endpoint.kind === 'proxy' ? `${deps.apiBase}/v1/kyw/rpc` : endpoint.url
  const body =
    endpoint.kind === 'proxy'
      ? { task_id: task.task_id, method: 'getTransaction', params }
      : { jsonrpc: '2.0', id: 1, method: 'getTransaction', params }
  let res: Response
  let text: string
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    text = await res.text()
  } catch (e) {
    return { outcome: unknownOutcome(isTimeout(e) ? 'timeout' : 'rpc_error'), bytes: 0, retryAfterS: null }
  }
  let bytes = text.length
  try {
    bytes = utf8(text).length
  } catch {
    // A body that is not valid UTF-16 is reported by its length in code units.
  }
  if (res.status === 429) return { outcome: unknownOutcome('rate_limited'), bytes, retryAfterS: retryAfter(res) }
  // The provider refused the user's key. The server only learns rpc_error (the contract); the
  // phone tells the user it is the key, since retrying will not fix it.
  if (endpoint.kind === 'direct' && (res.status === 401 || res.status === 403)) {
    return { outcome: unknownOutcome('rpc_error'), bytes, retryAfterS: null, keyRejected: true }
  }
  let outcome = readOutcome(text)
  // An HTTP error page is an RPC failure, not a malformed transaction.
  if (!res.ok && outcome.status === 'unknown' && outcome.unknownReason === 'invalid_response') {
    outcome = unknownOutcome('rpc_error')
  }
  return { outcome, bytes, retryAfterS: null }
}

export async function runOneTask(deps: RunDeps): Promise<RunResult> {
  const { endpoint } = deps
  const base = { provider: deps.provider, host: endpoint.host }
  const local = (reason: string, short = '', ms = 0, bytes = 0): TaskRecord => ({
    id: `local-${deps.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: deps.now(),
    short,
    verdict: 'unknown',
    reason,
    ...base,
    ms,
    bytes,
  })

  // 1. Task. A failure here is SolSentry's server, not the user's RPC: say so and show our host.
  const server = (reason: string): TaskRecord => ({ ...local(reason), host: hostOf(deps.apiBase) })
  let task: Task | null
  try {
    const query = deps.deviceKeyId ? `?device_key_id=${encodeURIComponent(deps.deviceKeyId)}` : ''
    const res = await deps.fetch(`${deps.apiBase}/v1/kyw/task${query}`, { headers: { Accept: 'application/json' } })
    if (res.status === 429) return { record: server('server_busy'), retryAfterS: retryAfter(res), backoff: true }
    if (res.status === 503) return { record: server('no_task'), retryAfterS: 30, backoff: true }
    if (!res.ok) return { record: server('server_unreachable'), retryAfterS: null, backoff: true }
    task = parseTask(await res.json())
  } catch {
    return { record: server('server_unreachable'), retryAfterS: null, backoff: true }
  }
  if (!task) return { record: local('unsupported_task'), retryAfterS: 60, backoff: true }
  const short = shortId(task.signature)
  deps.onReading?.(short)

  // 2. Read and compute.
  const startedAt = new Date(deps.now())
  const read = await readTransaction(deps, task)
  const endedAt = new Date(deps.now())
  const unsigned = buildEnvelope({
    task,
    outcome: read.outcome,
    rpcHost: endpoint.host,
    rpcUrlDigest: RPC_URL_DIGEST && endpoint.kind === 'direct' ? rpcUrlDigest(endpoint.url) : null,
    startedAt,
    endedAt,
    bytes: read.bytes,
    client: { kind: 'android', version: deps.clientVersion },
    deviceKeyId: deps.deviceKeyId ?? null,
  })
  const deviceSig = deps.deviceKeyId && deps.signResult ? await deps.signResult(unsigned).catch(() => null) : null
  const envelope = { ...unsigned, device_sig: deviceSig }
  const { ms, bytes } = envelope.metrics
  const pushedBack =
    read.outcome.status === 'unknown' && ['rate_limited', 'rpc_error', 'timeout'].includes(read.outcome.unknownReason)

  // 3. Result.
  let verdict: Verdict
  let reason: string | null
  try {
    const res = await deps.fetch(`${deps.apiBase}/v1/kyw/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(envelope),
    })
    if (!res.ok) {
      const record = { ...local('submit_failed', short, ms, bytes), id: task.task_id }
      return { record, retryAfterS: res.status === 429 ? retryAfter(res) : null, backoff: true }
    }
    const answer = (await res.json()) as { verdict?: unknown; reason?: unknown }
    if (answer.verdict !== 'accepted' && answer.verdict !== 'diverged' && answer.verdict !== 'unknown') {
      return { record: { ...local('submit_failed', short, ms, bytes), id: task.task_id }, retryAfterS: null, backoff: true }
    }
    verdict = answer.verdict
    reason =
      verdict === 'unknown'
        ? typeof answer.reason === 'string'
          ? answer.reason
          : (read.outcome.unknownReason ?? 'unknown')
        : null
  } catch {
    return { record: { ...local('submit_failed', short, ms, bytes), id: task.task_id }, retryAfterS: null, backoff: true }
  }
  return {
    record: { id: task.task_id, at: deps.now(), short, verdict, reason: read.keyRejected ? 'key_rejected' : reason, ...base, ms, bytes, signed: deviceSig !== null },
    retryAfterS: read.retryAfterS,
    backoff: pushedBack,
  }
}
