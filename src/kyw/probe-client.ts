import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

import { bytesToBase64 } from '../device/attest-logic'
import { fetchWithTimeout } from '../guard/fetch-timeout'
import { parseProbeTargets, probeIsStale, runProbe, type ProbeReport, type ProbeTargets } from './probe'
import { independentRpc } from './points'
import { resolveEndpoint, type ProviderId } from './providers'

export type ProbeTargetsProblem = 'no_targets' | 'network' | `http_${number}`
export type ProbeTargetsResult = { ok: true; targets: ProbeTargets } | { ok: false; problem: ProbeTargetsProblem }

export async function fetchProbeTargets(fetch: typeof globalThis.fetch, apiBase: string): Promise<ProbeTargetsResult> {
  let response: Response
  try {
    response = await fetchWithTimeout(fetch, 10_000)(`${apiBase.replace(/\/$/, '')}/v1/kyw/probe`, {
      method: 'GET', headers: { Accept: 'application/json' },
    })
  } catch {
    return { ok: false, problem: 'network' }
  }
  if (!response.ok) return { ok: false, problem: `http_${response.status}` }
  try {
    const targets = parseProbeTargets(await response.json())
    return targets ? { ok: true, targets } : { ok: false, problem: 'no_targets' }
  } catch {
    return { ok: false, problem: 'no_targets' }
  }
}

export interface ProbeChosenRpcDeps {
  fetch: typeof fetch
  apiBase: string
  provider: ProviderId
  secret: string
  clientVersion: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type ProbeChosenRpcResult =
  | { ok: true; kind: 'report'; report: ProbeReport }
  | { ok: true; kind: 'not_applicable' }
  | { ok: false; problem: string }

export async function probeChosenRpc(deps: ProbeChosenRpcDeps): Promise<ProbeChosenRpcResult> {
  // The proxy has no general RPC endpoint; resolve before making even the targets request.
  const endpoint = resolveEndpoint(deps.provider, deps.secret, '')
  if (!endpoint.ok) return endpoint
  if (endpoint.kind === 'proxy') return { ok: true, kind: 'not_applicable' }
  const targets = await fetchProbeTargets(deps.fetch, deps.apiBase)
  if (!targets.ok) return targets
  const report = await runProbe({
    fetch: fetchWithTimeout(deps.fetch, 10_000),
    url: endpoint.url,
    host: endpoint.host,
    targets: targets.targets,
    clientVersion: deps.clientVersion,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  })
  return { ok: true, kind: 'report', report }
}

export function chosenRpcProbeIsStale(report: ProbeReport | null, provider: ProviderId, secret: string, now: number): boolean {
  const endpoint = resolveEndpoint(provider, secret, '')
  return !endpoint.ok || endpoint.kind !== 'direct' || probeIsStale(report, endpoint.host, now)
}

/** The bytes the device key signs for a probe (integrations/kyw/device.py probe_message): domain, then sha256 hex of the body as sent. */
export function probeSigningMessage(rawBody: string): string {
  return `kyw-probe-v0\n${bytesToHex(sha256(utf8ToBytes(rawBody)))}`
}

export type SubmitProbeResult = { ok: true; signed: boolean } | { ok: false; problem: string }

/**
 * Send the report to SolSentry (POST /v1/kyw/probe) under this phone's key: only a signed, valid probe
 * lets the server count the own-RPC bonus. The report holds the host only, never the URL or a key.
 */
export async function submitProbe(deps: {
  fetch: typeof fetch
  apiBase: string
  report: ProbeReport
  deviceKeyId: string | null
  signWithDevice: (messageB64: string) => Promise<string | null>
}): Promise<SubmitProbeResult> {
  const raw = JSON.stringify(deps.deviceKeyId ? { ...deps.report, device_key_id: deps.deviceKeyId } : deps.report)
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (deps.deviceKeyId) {
    const sig = await deps.signWithDevice(bytesToBase64(utf8ToBytes(probeSigningMessage(raw)))).catch(() => null)
    if (!sig) return { ok: false, problem: 'no_signature' }
    headers['X-KYW-Device-Sig'] = sig
  }
  try {
    const res = await fetchWithTimeout(deps.fetch, 10_000)(`${deps.apiBase.replace(/\/$/, '')}/v1/kyw/probe`, { method: 'POST', headers, body: raw })
    if (!res.ok) return { ok: false, problem: `http_${res.status}` }
    const body = (await res.json().catch(() => null)) as { accepted?: unknown; signed?: unknown } | null
    return body?.accepted === true ? { ok: true, signed: body.signed === true } : { ok: false, problem: 'not_accepted' }
  } catch {
    return { ok: false, problem: 'network' }
  }
}

/** The own-RPC bonus as the app shows it: a full report for the URL in use now, not stale. Without the URL (not saved, app restarted) it is off. */
export function ownRpcActive(provider: ProviderId, report: ProbeReport | null | undefined, secret: string, now: number): boolean {
  return independentRpc(provider, report) && !chosenRpcProbeIsStale(report ?? null, provider, secret, now)
}
