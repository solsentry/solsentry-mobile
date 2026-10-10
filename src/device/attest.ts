// Optional Device check: hardware key attestation, verified by the SolSentry server.
// Only reachable when DEVICE_CHECK_ENABLED is true. Informational: nothing here feeds the
// recipient/sender verdicts or the send button.
//
// Flow: GET challenge (server-issued, single use) -> attestKey(challenge) -> POST verify.
import { API_BASE, DEVICE_CHECK_ENABLED } from '../config'
import { fetchWithTimeout } from '../guard/fetch-timeout'
import {
  challengeFailureView,
  moduleFailureView,
  parseChallengeResponse,
  toDeviceCheckView,
  type ClaimedDevice,
  type DeviceCheckView,
  type IdAttestation,
  type ServerOutcome,
  type VerifyRequest,
} from './attest-logic'

export const CHALLENGE_PATH = '/v1/device-attestation/challenge'
export const VERIFY_PATH = '/v1/device-attestation/verify'
const TIMEOUT_MS = 15000

/** Same shape as modules/device-attestation AttestResult; kept here so this file has no native import. */
export interface AttestResultLike {
  chain: string[]
  strongBox: boolean
  idAttestation: IdAttestation
  error?: string
  idError?: string
  claimed?: ClaimedDevice
}

export interface DeviceCheckDeps {
  /** Raw fetch; wrapped in fetchWithTimeout (deadline covers the body). */
  fetch: typeof fetch
  isAvailable: () => boolean
  attestKey: (
    challengeB64: string,
    opts: { strongBox: boolean; includeDeviceIds: boolean },
  ) => Promise<AttestResultLike>
}

async function call(f: typeof fetch, path: string, init?: RequestInit): Promise<ServerOutcome> {
  let res: Response
  try {
    res = await f(`${API_BASE}${path}`, { ...init, headers: { Accept: 'application/json', ...init?.headers } })
  } catch (e) {
    return { kind: 'network', message: e instanceof Error ? e.message : String(e) }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  if (!res.ok) return { kind: 'http', status: res.status, body }
  if (body === undefined) return { kind: 'network', message: 'invalid JSON' }
  return { kind: 'ok', body }
}

/** The whole check with injected dependencies (tested in tests/device-check.test.ts). */
export async function deviceCheckFlow(deps: DeviceCheckDeps): Promise<DeviceCheckView> {
  if (!deps.isAvailable()) return moduleFailureView(undefined, true)
  const f = fetchWithTimeout(deps.fetch, TIMEOUT_MS, 'Device check request')

  // 1. Server-issued nonce. Any failure here (404 = route off) is "unavailable", nothing more.
  const ch = await call(f, CHALLENGE_PATH, { method: 'GET' })
  const challenge = ch.kind === 'ok' ? parseChallengeResponse(ch.body) : null
  if (!challenge) return challengeFailureView()

  // 2. Hardware attestation over that nonce.
  let result: AttestResultLike
  try {
    result = await deps.attestKey(challenge, { strongBox: true, includeDeviceIds: true })
  } catch (e) {
    return moduleFailureView(undefined, false, e instanceof Error ? e.message : String(e))
  }
  if (result.chain.length === 0) return moduleFailureView(result.claimed, false, result.error)

  // 3. Server verdict on the chain.
  const body: VerifyRequest = { challenge, chain: result.chain }
  const outcome = await call(f, VERIFY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return toDeviceCheckView(outcome, {
    claimed: result.claimed,
    idAttestation: result.idAttestation,
    idError: result.idError,
  })
}

/** Runs the whole check. Returns null when the feature flag is off (the module is never loaded). */
export async function runDeviceCheck(): Promise<DeviceCheckView | null> {
  if (!DEVICE_CHECK_ENABLED) return null
  // Lazy import: with the flag off the native module is never even required.
  const mod = await import('../../modules/device-attestation')
  return deviceCheckFlow({
    fetch: (u, i) => globalThis.fetch(u, i),
    isAvailable: mod.isAvailable,
    attestKey: mod.attestKey,
  })
}
