// The result a validator sends back. Everything here except `fact_digest` is outside the digest.
import { FACT_TYPE, SPEC_VERSION, type ReadOutcome } from './fact'

export interface Task {
  task_id: string
  signature: string
  deadline: string
}

export interface ResultEnvelope {
  task_id: string
  fact_type: string
  spec_version: string
  status: 'ok' | 'unknown'
  unknown_reason: string | null
  fact_digest: string | null
  signatures: string[]
  reads: { method: string; target: string; ok: boolean; truncated: boolean }[]
  rpc_host: string
  read_at: { start: string; end: string }
  metrics: { ms: number; bytes: number }
  client: { kind: string; version: string }
  device_key_id: string | null
  device_sig: string | null
}

export interface EnvelopeInput {
  task: Task
  outcome: ReadOutcome
  /** Host only: never a URL, a path or a query string. */
  rpcHost: string
  startedAt: Date
  endedAt: Date
  bytes: number
  client: { kind: string; version: string }
  deviceKeyId?: string | null
  deviceSig?: string | null
}

export function buildEnvelope(input: EnvelopeInput): ResultEnvelope {
  const { task, outcome } = input
  return {
    task_id: task.task_id,
    fact_type: FACT_TYPE,
    spec_version: SPEC_VERSION,
    status: outcome.status,
    unknown_reason: outcome.unknownReason,
    fact_digest: outcome.factDigest,
    signatures: [task.signature],
    reads: [{ method: 'getTransaction', target: task.signature, ok: outcome.status === 'ok', truncated: false }],
    rpc_host: input.rpcHost,
    read_at: { start: input.startedAt.toISOString(), end: input.endedAt.toISOString() },
    metrics: {
      ms: Math.max(0, Math.round(input.endedAt.getTime() - input.startedAt.getTime())),
      bytes: Math.max(0, Math.round(input.bytes)),
    },
    client: input.client,
    device_key_id: input.deviceKeyId ?? null,
    device_sig: input.deviceSig ?? null,
  }
}

/**
 * Read a GET /v1/kyw/task body. Returns null when the task is not one this client can do
 * (other fact type, other spec version, a rule, or read options that differ from the contract).
 */
export function parseTask(body: unknown): Task | null {
  if (typeof body !== 'object' || body === null) return null
  const t = body as Record<string, unknown>
  const params = t.params as Record<string, unknown> | null | undefined
  const read = t.read as Record<string, unknown> | null | undefined
  if (typeof t.task_id !== 'string' || !t.task_id || typeof t.deadline !== 'string') return null
  if (t.fact_type !== FACT_TYPE || t.spec_version !== SPEC_VERSION) return null
  if (t.rule !== null && t.rule !== undefined) return null
  if (typeof params !== 'object' || params === null) return null
  const signature = params.signature
  if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return null
  if (typeof read !== 'object' || read === null) return null
  const keys = Object.keys(read).sort().join(',')
  if (keys !== 'commitment,encoding,maxSupportedTransactionVersion,method') return null
  if (
    read.method !== 'getTransaction' ||
    read.encoding !== 'jsonParsed' ||
    read.maxSupportedTransactionVersion !== 1 ||
    read.commitment !== 'finalized'
  ) {
    return null
  }
  return { task_id: t.task_id, signature, deadline: t.deadline }
}

/** `4kx…pH1`: the only part of a signature or address the app shows or stores. */
export function shortId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 3)}…${value.slice(-3)}`
}
