import { fetchWithTimeout } from '../guard/fetch-timeout'
import { parseProbeTargets, probeIsStale, runProbe, type ProbeReport, type ProbeTargets } from './probe'
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
