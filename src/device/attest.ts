// Optional Device check: hardware key attestation, verified by the SolSentry server.
// Only reachable when DEVICE_CHECK_ENABLED is true. Informational: nothing here feeds the
// recipient/sender verdicts or the send button.
import { API_BASE, DEVICE_CHECK_ENABLED } from '@/src/config'
import {
  bytesToBase64,
  moduleFailureView,
  toDeviceCheckView,
  type DeviceCheckView,
  type ServerOutcome,
  type VerifyRequest,
} from './attest-logic'

export const VERIFY_PATH = '/v1/device-attestation/verify'
const TIMEOUT_MS = 15000

// TODO(device-check): the challenge is generated on the phone for now, so the server can only
// check that the attested challenge equals the one sent with it; that proves the chain was made
// for this request body, not that it is fresh. The right design is a server-issued, single-use
// nonce (GET /v1/device-attestation/challenge -> {challenge, expires_at}) that the verify route
// consumes, so a captured chain cannot be replayed.
export function newChallenge(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToBase64(bytes)
}

async function postVerify(body: VerifyRequest, fetchImpl: typeof fetch): Promise<ServerOutcome> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${API_BASE}${VERIFY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return { kind: 'http', status: res.status }
    try {
      return { kind: 'ok', body: await res.json() }
    } catch {
      return { kind: 'network', message: 'invalid JSON' }
    }
  } catch (e) {
    return { kind: 'network', message: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/** Runs the whole check. Returns null when the feature flag is off (the module is never loaded). */
export async function runDeviceCheck(
  fetchImpl: typeof fetch = (u, i) => globalThis.fetch(u, i),
): Promise<DeviceCheckView | null> {
  if (!DEVICE_CHECK_ENABLED) return null
  // Lazy import: with the flag off the native module is never even required.
  const mod = await import('@/modules/device-attestation')
  if (!mod.isAvailable()) return moduleFailureView(undefined, true)

  const challenge = newChallenge()
  let result
  try {
    result = await mod.attestKey(challenge, { strongBox: true, includeDeviceIds: true })
  } catch {
    return moduleFailureView(undefined, false)
  }
  if (result.error || result.chain.length === 0) return moduleFailureView(result.claimed, false)

  const outcome = await postVerify({ challenge, chain: result.chain }, fetchImpl)
  return toDeviceCheckView(outcome, { claimed: result.claimed, idAttestation: result.idAttestation })
}
