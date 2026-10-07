// Pure logic for the optional Device check: server response -> UI text.
// No React, no native imports, so it runs under vitest.
//
// Wording rule: this is informational only. It never says "Seeker" (or any model) unless the
// hardware attested that model, and a failure to reach or parse the server is "could not
// verify", never "genuine" and never "not genuine".

/** POST /v1/device-attestation/verify request body. */
export interface VerifyRequest {
  /** base64 of the 32 challenge bytes. */
  challenge: string
  /** base64 DER certificates, leaf first. */
  chain: string[]
}

/** POST /v1/device-attestation/verify response body (contract in README). */
export interface VerifyResponse {
  valid: boolean
  reason?: string
  security_level?: string | null
  keymaster_security_level?: string | null
  attestation_version?: number | null
  challenge_match?: boolean
  root_of_trust?: { verified_boot_state?: string | null; device_locked?: boolean | null } | null
  attested_ids?: {
    brand?: string
    device?: string
    product?: string
    manufacturer?: string
    model?: string
  } | null
  revoked?: boolean | null
  revocation_checked?: boolean
  os_version?: number | null
  os_patch_level?: number | null
}

/**
 * included: brand/model are in the attestation. refused: the device declined ID attestation.
 * unsupported: Android < 12. not_requested: the caller did not ask. error: the attempt with IDs
 * failed for a reason that is not a recognized refusal (details in the module's idError).
 */
export type IdAttestation = 'included' | 'refused' | 'unsupported' | 'not_requested' | 'error'

export interface ClaimedDevice {
  manufacturer: string
  brand: string
  model: string
  sdkInt: number
}

/** GET /v1/device-attestation/challenge response body. */
export interface ChallengeResponse {
  /** base64 of 32 bytes, single use. */
  challenge: string
  /** seconds */
  expires_in: number
}

/** What an HTTP call produced, before mapping. `body` is the parsed JSON when there was one. */
export type ServerOutcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'http'; status: number; body?: unknown }
  | { kind: 'network'; message: string }

/** Server reason for a challenge it did not issue or that has expired: retry, never "not genuine". */
export const REASON_CHALLENGE_EXPIRED = 'challenge_unknown_or_expired'

export type DeviceCheckStatus = 'verified' | 'not_verified' | 'could_not_verify' | 'unavailable'

export interface DeviceCheckView {
  status: DeviceCheckStatus
  headline: string
  /** What the phone says about itself (Build.*). Never evidence. */
  claims: string[]
  /** What the attestation proves, as checked by the server. Empty unless the server answered. */
  proves: string[]
  notes: string[]
}

export const TEXT = {
  unavailable: 'Device check unavailable right now.',
  couldNotVerify: 'Could not verify this device.',
  challengeExpired: 'Could not verify (challenge expired, try again).',
  notVerified: 'Not verified: this phone did not prove a hardware-backed key.',
  genericGenuine: 'Genuine Android device with a hardware-backed key.',
  revocationUnchecked: ' (revocation list not checked)',
  informational: 'Informational only. It does not change any check or send.',
} as const

const LEVEL_TEXT: Record<string, string> = {
  strongbox: 'StrongBox (dedicated secure chip)',
  trusted_environment: 'TEE (trusted execution environment)',
  software: 'Software only (no hardware protection)',
}

const BOOT_TEXT: Record<string, string> = {
  verified: 'Verified boot',
  self_signed: 'Boot image signed with a custom key',
  unverified: 'Unverified boot (custom software)',
  failed: 'Boot verification failed',
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function reasonOf(body: unknown): string | undefined {
  return isObj(body) ? str(body.reason) : undefined
}

/** The challenge to attest, or null when the answer is not a base64 string of exactly 32 bytes. */
export function parseChallengeResponse(body: unknown): string | null {
  if (!isObj(body)) return null
  const c = body.challenge
  if (typeof c !== 'string' || !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(c)) return null
  return c
}

/** Strict shape check: anything that is not this contract is "could not verify". */
export function parseVerifyResponse(body: unknown): VerifyResponse | null {
  if (!isObj(body) || typeof body.valid !== 'boolean') return null
  return body as unknown as VerifyResponse
}

export function claimLines(claimed: ClaimedDevice | undefined): string[] {
  if (!claimed) return ['Not reported']
  const name = [claimed.manufacturer, claimed.model].map(str).filter(Boolean).join(' ')
  return [
    `${name || 'Unknown model'} (Android API ${claimed.sdkInt})`,
    'Self-reported by the phone; any software can set this.',
  ]
}

/** "Brand Model" from attested IDs, or null when the hardware did not attest a model. */
export function attestedName(r: VerifyResponse): string | null {
  const ids = isObj(r.attested_ids) ? r.attested_ids : null
  const model = str(ids?.model)
  if (!model) return null
  const maker = str(ids?.manufacturer) ?? str(ids?.brand)
  return maker && !model.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker} ${model}` : model
}

function idLine(name: string | null, idAttestation: IdAttestation): string {
  if (name) return `Attested model: ${name}`
  if (idAttestation === 'refused') return 'Model: not attested (the device declined ID attestation)'
  if (idAttestation === 'unsupported') return 'Model: not attested (not supported on this device)'
  if (idAttestation === 'error') return 'Model: not attested (ID attestation failed, see details)'
  return 'Model: not attested'
}

function bootLine(r: VerifyResponse): string {
  const rot = isObj(r.root_of_trust) ? r.root_of_trust : null
  const state = str(rot?.verified_boot_state)
  const base = state ? (BOOT_TEXT[state] ?? `Boot state: ${state}`) : 'Boot state: not reported'
  if (rot?.device_locked === true) return `${base}, bootloader locked`
  if (rot?.device_locked === false) return `${base}, bootloader unlocked`
  return base
}

function proveLines(r: VerifyResponse, idAttestation: IdAttestation): string[] {
  const level = str(r.security_level)
  return [
    `Key protection: ${level ? (LEVEL_TEXT[level] ?? level) : 'not reported'}`,
    bootLine(r),
    idLine(attestedName(r), idAttestation),
    r.valid
      ? 'Certificate chain: valid, anchored to Google hardware attestation root (checked by SolSentry server)'
      : 'Certificate chain: not accepted by SolSentry server',
  ]
}

/** Main mapping: everything the Device check section shows. */
const HARDWARE_LEVELS = new Set(['trustedenvironment', 'tee', 'strongbox'])
const CONTRADICTION_NOTE =
  'The server accepted the chain, but the challenge match, the hardware level or a verified, locked boot was not confirmed.'

/** Lower-case letters only, so "TrustedEnvironment", "trusted_environment" and "TRUSTED_ENVIRONMENT" compare equal. */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase().replace(/[^a-z]/g, '') : ''
}

export function toDeviceCheckView(
  outcome: ServerOutcome,
  ctx: { claimed?: ClaimedDevice; idAttestation: IdAttestation; idError?: string },
): DeviceCheckView {
  const claims = claimLines(ctx.claimed)
  const base = { claims, proves: [] as string[], notes: [TEXT.informational] as string[] }
  if (ctx.idAttestation === 'error' && ctx.idError) base.notes.unshift(`ID attestation detail: ${ctx.idError}`)

  if (outcome.kind === 'http' && outcome.status === 404) {
    // Route switched off server-side: unavailable, never "not genuine".
    return { ...base, status: 'unavailable', headline: TEXT.unavailable }
  }
  if (outcome.kind !== 'network' && reasonOf(outcome.body) === REASON_CHALLENGE_EXPIRED) {
    // Whatever the status or `valid`: a stale/unknown nonce says nothing about the device.
    return { ...base, status: 'could_not_verify', headline: TEXT.challengeExpired }
  }
  if (outcome.kind !== 'ok') {
    return { ...base, status: 'could_not_verify', headline: TEXT.couldNotVerify }
  }
  const r = parseVerifyResponse(outcome.body)
  if (!r) return { ...base, status: 'could_not_verify', headline: TEXT.couldNotVerify }

  const proves = proveLines(r, ctx.idAttestation)
  // Defence in depth: a "valid" answer that contradicts itself is not shown as genuine.
  // Only an explicit hardware level, an explicit challenge match and a verified, locked boot count as genuine.
  const contradicts =
    r.challenge_match !== true ||
    r.revoked === true ||
    !HARDWARE_LEVELS.has(norm(r.security_level)) ||
    norm(r.root_of_trust?.verified_boot_state) !== 'verified' ||
    r.root_of_trust?.device_locked !== true
  if (!r.valid || contradicts) {
    const notes = [...base.notes]
    if (r.valid && contradicts) notes.unshift(CONTRADICTION_NOTE)
    const why = str(r.reason)
    if (why) notes.unshift(`Reason: ${why.replace(/_/g, ' ')}`)
    return { claims, proves, notes, status: 'not_verified', headline: TEXT.notVerified }
  }

  const name = attestedName(r)
  const revocationUnchecked = r.reason === 'revocation_unchecked' || r.revocation_checked !== true
  const headline =
    (name ? `Genuine ${name} with a hardware-backed key` : TEXT.genericGenuine.replace(/\.$/, '')) +
    (revocationUnchecked ? TEXT.revocationUnchecked : '') +
    '.'
  const notes = [...base.notes]
  const claimedModel = str(ctx.claimed?.model)
  const attestedModel = str(r.attested_ids?.model)
  if (attestedModel && claimedModel && attestedModel.toLowerCase() !== claimedModel.toLowerCase()) {
    notes.unshift('The model the phone claims differs from the attested model.')
  }
  return { claims, proves, notes, status: 'verified', headline }
}

/** Module-level failure (no chain): never reaches the server. */
export function moduleFailureView(
  claimed: ClaimedDevice | undefined,
  unavailable: boolean,
  detail?: string,
): DeviceCheckView {
  const notes: string[] = [TEXT.informational]
  if (detail) notes.unshift(`Detail: ${detail}`)
  return {
    status: unavailable ? 'unavailable' : 'could_not_verify',
    headline: unavailable ? TEXT.unavailable : TEXT.couldNotVerify,
    claims: claimLines(claimed),
    proves: [],
    notes,
  }
}

/** The challenge GET failed (404 = route off, or any error): the check is unavailable, nothing more. */
export function challengeFailureView(): DeviceCheckView {
  return moduleFailureView(undefined, true)
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63]
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? alphabet[n & 63] : '='
  }
  return out
}
