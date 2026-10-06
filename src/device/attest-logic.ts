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

export type IdAttestation = 'included' | 'refused' | 'unsupported'

export interface ClaimedDevice {
  manufacturer: string
  brand: string
  model: string
  sdkInt: number
}

/** What the HTTP call produced, before mapping. */
export type ServerOutcome =
  { kind: 'ok'; body: unknown } | { kind: 'http'; status: number } | { kind: 'network'; message: string }

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
export function toDeviceCheckView(
  outcome: ServerOutcome,
  ctx: { claimed?: ClaimedDevice; idAttestation: IdAttestation },
): DeviceCheckView {
  const claims = claimLines(ctx.claimed)
  const base = { claims, proves: [] as string[], notes: [TEXT.informational] as string[] }

  if (outcome.kind === 'http' && outcome.status === 404) {
    // Route switched off server-side: unavailable, never "not genuine".
    return { ...base, status: 'unavailable', headline: TEXT.unavailable }
  }
  if (outcome.kind !== 'ok') {
    return { ...base, status: 'could_not_verify', headline: TEXT.couldNotVerify }
  }
  const r = parseVerifyResponse(outcome.body)
  if (!r) return { ...base, status: 'could_not_verify', headline: TEXT.couldNotVerify }

  const proves = proveLines(r, ctx.idAttestation)
  // Defence in depth: a "valid" answer that contradicts itself is not shown as genuine.
  const contradicts =
    r.challenge_match === false ||
    r.revoked === true ||
    str(r.security_level) === 'software' ||
    str(r.security_level) == null
  if (!r.valid || contradicts) {
    const notes = [...base.notes]
    const why = str(r.reason)
    if (why) notes.unshift(`Reason: ${why.replace(/_/g, ' ')}`)
    return { claims, proves, notes, status: 'not_verified', headline: TEXT.notVerified }
  }

  const name = attestedName(r)
  const revocationUnchecked = r.reason === 'revocation_unchecked' || r.revocation_checked === false
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
export function moduleFailureView(claimed: ClaimedDevice | undefined, unavailable: boolean): DeviceCheckView {
  return {
    status: unavailable ? 'unavailable' : 'could_not_verify',
    headline: unavailable ? TEXT.unavailable : TEXT.couldNotVerify,
    claims: claimLines(claimed),
    proves: [],
    notes: [TEXT.informational] as string[],
  }
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
