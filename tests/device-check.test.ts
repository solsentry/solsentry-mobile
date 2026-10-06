import { describe, expect, it } from 'vitest'
import {
  TEXT,
  attestedName,
  bytesToBase64,
  moduleFailureView,
  parseVerifyResponse,
  toDeviceCheckView,
  type ClaimedDevice,
  type VerifyResponse,
} from '../src/device/attest-logic'
import { DEVICE_CHECK_ENABLED } from '../src/config'

const CLAIMED: ClaimedDevice = { manufacturer: 'Solana Mobile', brand: 'solanamobile', model: 'Seeker', sdkInt: 35 }

function ok(over: Partial<VerifyResponse> = {}): VerifyResponse {
  return {
    valid: true,
    security_level: 'trusted_environment',
    keymaster_security_level: 'trusted_environment',
    attestation_version: 300,
    challenge_match: true,
    root_of_trust: { verified_boot_state: 'verified', device_locked: true },
    attested_ids: {},
    revoked: false,
    revocation_checked: true,
    os_version: 150000,
    os_patch_level: 202609,
    ...over,
  }
}

const all = (v: { headline: string; claims: string[]; proves: string[]; notes: string[] }) =>
  [v.headline, ...v.claims, ...v.proves, ...v.notes].join('\n')

describe('device check flag', () => {
  it('is off by default', () => {
    expect(DEVICE_CHECK_ENABLED).toBe(false)
  })
})

describe('server response -> UI text', () => {
  it('valid chain without attested model: generic wording, never the claimed model in the proof', () => {
    const v = toDeviceCheckView({ kind: 'ok', body: ok() }, { claimed: CLAIMED, idAttestation: 'included' })
    expect(v.status).toBe('verified')
    expect(v.headline).toBe(TEXT.genericGenuine)
    expect(v.headline).not.toMatch(/seeker/i)
    expect(v.proves.join('\n')).not.toMatch(/seeker/i)
    expect(v.proves).toContain('Key protection: TEE (trusted execution environment)')
    expect(v.proves).toContain('Verified boot, bootloader locked')
    // The claim side still shows what the phone says, labelled as self-reported.
    expect(v.claims[0]).toContain('Seeker')
    expect(v.claims[1]).toMatch(/self-reported/i)
  })

  it('valid chain with attested model names the attested model', () => {
    const body = ok({ security_level: 'strongbox', attested_ids: { manufacturer: 'Solana Mobile', model: 'Seeker' } })
    const v = toDeviceCheckView({ kind: 'ok', body }, { claimed: CLAIMED, idAttestation: 'included' })
    expect(v.status).toBe('verified')
    expect(v.headline).toBe('Genuine Solana Mobile Seeker with a hardware-backed key.')
    expect(v.proves).toContain('Key protection: StrongBox (dedicated secure chip)')
    expect(v.proves).toContain('Attested model: Solana Mobile Seeker')
  })

  it('attested model that differs from the claim is flagged', () => {
    const body = ok({ attested_ids: { brand: 'google', model: 'Pixel 8' } })
    const v = toDeviceCheckView({ kind: 'ok', body }, { claimed: CLAIMED, idAttestation: 'included' })
    expect(v.notes[0]).toMatch(/differs/)
  })

  it('refused ID attestation: generic wording and says why the model is missing', () => {
    const v = toDeviceCheckView(
      { kind: 'ok', body: ok({ attested_ids: null }) },
      { claimed: CLAIMED, idAttestation: 'refused' },
    )
    expect(v.status).toBe('verified')
    expect(v.headline).toBe(TEXT.genericGenuine)
    expect(v.proves).toContain('Model: not attested (the device declined ID attestation)')
    expect(all(v)).not.toMatch(/genuine seeker/i)
  })

  it('unsupported ID attestation', () => {
    const v = toDeviceCheckView({ kind: 'ok', body: ok() }, { claimed: CLAIMED, idAttestation: 'unsupported' })
    expect(v.proves).toContain('Model: not attested (not supported on this device)')
  })

  it('revocation_unchecked with valid true -> genuine (revocation list not checked)', () => {
    const body = ok({ reason: 'revocation_unchecked', revoked: null, revocation_checked: false })
    const v = toDeviceCheckView({ kind: 'ok', body }, { claimed: CLAIMED, idAttestation: 'included' })
    expect(v.status).toBe('verified')
    expect(v.headline).toBe('Genuine Android device with a hardware-backed key (revocation list not checked).')
  })

  it('valid false -> not verified with the reason, never genuine', () => {
    const body = ok({ valid: false, reason: 'untrusted_root', security_level: 'software', root_of_trust: null })
    const v = toDeviceCheckView({ kind: 'ok', body }, { claimed: CLAIMED, idAttestation: 'included' })
    expect(v.status).toBe('not_verified')
    expect(v.headline).toBe(TEXT.notVerified)
    expect(v.notes[0]).toBe('Reason: untrusted root')
    expect(v.proves).toContain('Certificate chain: not accepted by SolSentry server')
    expect(all(v)).not.toMatch(/genuine/i)
  })

  it('valid true that contradicts itself is not shown as genuine', () => {
    for (const over of [
      { challenge_match: false },
      { revoked: true },
      { security_level: 'software' },
      { security_level: null },
    ]) {
      const v = toDeviceCheckView({ kind: 'ok', body: ok(over) }, { claimed: CLAIMED, idAttestation: 'included' })
      expect(v.status).toBe('not_verified')
      expect(v.headline).not.toMatch(/genuine/i)
    }
  })

  it('unlocked bootloader is described, not hidden', () => {
    const body = ok({
      valid: false,
      reason: 'device_unlocked',
      root_of_trust: { verified_boot_state: 'unverified', device_locked: false },
    })
    const v = toDeviceCheckView({ kind: 'ok', body }, { claimed: CLAIMED, idAttestation: 'included' })
    expect(v.proves).toContain('Unverified boot (custom software), bootloader unlocked')
  })
})

describe('server errors -> could not verify, never genuine', () => {
  const cases = [
    { kind: 'http' as const, status: 500 },
    { kind: 'http' as const, status: 400 },
    { kind: 'http' as const, status: 429 },
    { kind: 'network' as const, message: 'timeout' },
    { kind: 'ok' as const, body: null },
    { kind: 'ok' as const, body: 'genuine' },
    { kind: 'ok' as const, body: { valid: 'true' } },
    { kind: 'ok' as const, body: [] },
  ]
  for (const outcome of cases) {
    it(JSON.stringify(outcome), () => {
      const v = toDeviceCheckView(outcome, { claimed: CLAIMED, idAttestation: 'included' })
      expect(v.status).toBe('could_not_verify')
      expect(v.headline).toBe(TEXT.couldNotVerify)
      expect(v.proves).toEqual([])
      expect(all(v)).not.toMatch(/genuine/i)
    })
  }

  it('404 (route off) -> unavailable, never "not genuine"', () => {
    const v = toDeviceCheckView({ kind: 'http', status: 404 }, { claimed: CLAIMED, idAttestation: 'included' })
    expect(v.status).toBe('unavailable')
    expect(v.headline).toBe(TEXT.unavailable)
    expect(all(v)).not.toMatch(/genuine|not verified/i)
  })

  it('module failure / missing module', () => {
    expect(moduleFailureView(CLAIMED, false).headline).toBe(TEXT.couldNotVerify)
    expect(moduleFailureView(undefined, true).status).toBe('unavailable')
    expect(moduleFailureView(undefined, true).claims).toEqual(['Not reported'])
  })
})

describe('helpers', () => {
  it('parseVerifyResponse requires boolean valid', () => {
    expect(parseVerifyResponse({ valid: true })).not.toBeNull()
    expect(parseVerifyResponse({ valid: 1 })).toBeNull()
  })

  it('attestedName avoids doubling the maker', () => {
    expect(attestedName(ok({ attested_ids: { manufacturer: 'Google', model: 'Google Pixel 8' } }))).toBe(
      'Google Pixel 8',
    )
    expect(attestedName(ok({ attested_ids: { brand: 'solanamobile' } }))).toBeNull()
  })

  it('bytesToBase64 matches Buffer', () => {
    for (const n of [0, 1, 2, 3, 31, 32]) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255)
      expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'))
    }
  })
})
