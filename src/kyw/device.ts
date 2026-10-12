// Install identity for KYW. With the native module: one EC P-256 key per install in the Android
// Keystore, created over a server challenge so its attestation chain can be checked once by
// POST /v1/device-attestation/verify (the server's attestation check). device_key_id is the public key
// itself, so the server can check device_sig without a registry. Without the module: a random id,
// stable per install, unsigned. Neither carries a wallet, a serial or any hardware identifier.
import {
  bytesToBase64,
  parseChallengeResponse,
  toDeviceCheckView,
  type DeviceCheckStatus,
  type ServerOutcome,
} from '../device/attest-logic'
import type { AttestResultLike as AttestResult } from '../device/attest'
import { utf8 } from '../kyw-core'

export const DEVICE_ALIAS = 'solsentry_kyw_device_v1'
export const CHALLENGE_PATH = '/v1/device-attestation/challenge'
export const VERIFY_PATH = '/v1/device-attestation/verify'

export type DeviceCheck = DeviceCheckStatus | 'not_checked'

export interface DeviceIdentity {
  /** `k1:<base64url SPKI>` (hardware key) or `r1:<32 hex>` (random, unsigned). */
  id: string
  kind: 'key' | 'random'
  check: DeviceCheck
  /** The Device check headline, e.g. "Genuine Solana Mobile Seeker with a hardware-backed key." */
  headline: string | null
}

export interface DeviceNative {
  isAvailable: () => boolean
  hasKey: (alias: string) => boolean
  publicKey: (alias: string) => string | null
  attestKey: (challengeB64: string, opts: { strongBox: boolean; includeDeviceIds: boolean; keepAlias?: string }) => Promise<AttestResult>
  sign: (alias: string, dataB64: string) => Promise<string>
}

export interface DeviceDeps {
  fetch: typeof fetch
  apiBase: string
  native: DeviceNative | null
  load: () => Promise<string | null>
  save: (raw: string) => Promise<void>
  randomBytes: (n: number) => Uint8Array
}

const toB64Url = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

export function parseIdentity(raw: string | null): DeviceIdentity | null {
  if (!raw) return null
  try {
    const x = JSON.parse(raw) as Partial<DeviceIdentity>
    if (typeof x.id !== 'string' || !/^(k1:[A-Za-z0-9_-]{40,400}|r1:[0-9a-f]{32})$/.test(x.id)) return null
    if (x.kind !== 'key' && x.kind !== 'random') return null
    const checks = ['verified', 'not_verified', 'could_not_verify', 'unavailable', 'not_checked']
    return {
      id: x.id,
      kind: x.kind,
      check: checks.includes(x.check as string) ? (x.check as DeviceCheck) : 'not_checked',
      headline: typeof x.headline === 'string' ? x.headline.slice(0, 200) : null,
    }
  } catch {
    return null
  }
}

async function call(deps: DeviceDeps, path: string, init?: RequestInit): Promise<ServerOutcome> {
  let res: Response
  try {
    res = await deps.fetch(`${deps.apiBase}${path}`, { ...init, headers: { Accept: 'application/json', ...init?.headers } })
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

async function randomIdentity(deps: DeviceDeps, stored: DeviceIdentity | null): Promise<DeviceIdentity> {
  if (stored?.kind === 'random') return stored
  const identity: DeviceIdentity = { id: `r1:${hex(deps.randomBytes(16))}`, kind: 'random', check: 'unavailable', headline: null }
  await deps.save(JSON.stringify(identity))
  return identity
}

/**
 * The install identity, created on first use. Never throws: any failure on the key path falls back
 * to a random id, and a failed server check leaves the key in place (the id stays stable).
 */
export async function ensureDevice(deps: DeviceDeps): Promise<DeviceIdentity> {
  let stored: DeviceIdentity | null = null
  try {
    stored = parseIdentity(await deps.load())
  } catch {
    stored = null
  }
  const native = deps.native
  try {
    if (!native || !native.isAvailable()) return await randomIdentity(deps, stored)

    if (native.hasKey(DEVICE_ALIAS)) {
      const spki = native.publicKey(DEVICE_ALIAS)
      if (spki) {
        const id = `k1:${toB64Url(spki)}`
        if (stored?.id === id) return stored
        const identity: DeviceIdentity = { id, kind: 'key', check: 'not_checked', headline: null }
        await deps.save(JSON.stringify(identity))
        return identity
      }
    }

    // First run: a server challenge when we can get one, so the chain is checkable. Without it the
    // key is still created (stable id) but its chain cannot prove anything to the server.
    const ch = await call(deps, CHALLENGE_PATH, { method: 'GET' })
    const serverChallenge = ch.kind === 'ok' ? parseChallengeResponse(ch.body) : null
    const challenge = serverChallenge ?? bytesToBase64(deps.randomBytes(32))
    // TEE, not StrongBox: this key signs every result, and StrongBox signing is slow.
    const result = await native.attestKey(challenge, { strongBox: false, includeDeviceIds: true, keepAlias: DEVICE_ALIAS })
    const spki = result.chain.length > 0 ? native.publicKey(DEVICE_ALIAS) : null
    if (!spki) return await randomIdentity(deps, stored)

    let check: DeviceCheck = 'could_not_verify'
    let headline: string | null = null
    if (serverChallenge) {
      const outcome = await call(deps, VERIFY_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: serverChallenge, chain: result.chain }),
      })
      const view = toDeviceCheckView(outcome, { claimed: result.claimed, idAttestation: result.idAttestation, idError: result.idError })
      check = view.status
      headline = view.headline
    }
    const identity: DeviceIdentity = { id: `k1:${toB64Url(spki)}`, kind: 'key', check, headline }
    await deps.save(JSON.stringify(identity))
    return identity
  } catch {
    return randomIdentity(deps, stored).catch(() => ({ id: `r1:${hex(deps.randomBytes(16))}`, kind: 'random' as const, check: 'unavailable' as const, headline: null }))
  }
}

/** The exact bytes device_sig covers (contract v0; the server does not check it yet). */
export function resultSigningPayload(r: { task_id: string; status: string; fact_digest: string | null; rpc_host: string }): string {
  return ['kyw-result-v0', r.task_id, r.status, r.fact_digest ?? '', r.rpc_host].join('\n')
}

/** device_sig for a result, or null (random identity, no module, or the Keystore refused). */
export async function signResult(
  native: DeviceNative | null,
  identity: DeviceIdentity | null,
  r: { task_id: string; status: string; fact_digest: string | null; rpc_host: string },
): Promise<string | null> {
  if (!native || identity?.kind !== 'key') return null
  try {
    return await native.sign(DEVICE_ALIAS, bytesToBase64(utf8(resultSigningPayload(r))))
  } catch {
    return null
  }
}
