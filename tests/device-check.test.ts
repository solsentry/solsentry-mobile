import { describe, expect, it, vi } from 'vitest'
import { deviceCheckFlow, type AttestResultLike } from '../src/device/attest'
import {
  TEXT,
  parseChallengeResponse,
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
      { security_level: 'unknown' },
      { challenge_match: undefined },
      { root_of_trust: { verified_boot_state: 'unverified', device_locked: true } },
      { root_of_trust: { verified_boot_state: 'verified', device_locked: false } },
      { root_of_trust: null },
    ] as Partial<VerifyResponse>[]) {
      const v = toDeviceCheckView({ kind: 'ok', body: ok(over) }, { claimed: CLAIMED, idAttestation: 'included' })
      expect(v.status).toBe('not_verified')
      expect(v.headline).not.toMatch(/genuine/i)
    }
  })

  it('hardware level names compare loosely (StrongBox, TrustedEnvironment)', () => {
    for (const level of ['StrongBox', 'TRUSTED_ENVIRONMENT', 'TrustedEnvironment']) {
      const v = toDeviceCheckView({ kind: 'ok', body: ok({ security_level: level }) }, { claimed: CLAIMED, idAttestation: 'included' })
      expect(v.status).toBe('verified')
    }
  })

  it('revocation status missing is said out loud', () => {
    const v = toDeviceCheckView(
      { kind: 'ok', body: ok({ revocation_checked: undefined, revoked: null }) },
      { claimed: CLAIMED, idAttestation: 'included' },
    )
    expect(v.headline).toContain('revocation list not checked')
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

const CHALLENGE = Buffer.from(new Uint8Array(32).map((_, i) => i * 7)).toString('base64')

describe('server nonce', () => {
  it('parseChallengeResponse accepts exactly 32 bytes of base64', () => {
    expect(parseChallengeResponse({ challenge: CHALLENGE, expires_in: 300 })).toBe(CHALLENGE)
    expect(parseChallengeResponse({ challenge: Buffer.alloc(16).toString('base64') })).toBeNull()
    expect(parseChallengeResponse({ challenge: Buffer.alloc(33).toString('base64') })).toBeNull()
    expect(parseChallengeResponse({ challenge: 'not base64!' })).toBeNull()
    expect(parseChallengeResponse(null)).toBeNull()
  })

  it('challenge_unknown_or_expired -> could not verify (try again), never not genuine', () => {
    const outcomes = [
      { kind: 'ok' as const, body: { valid: false, reason: 'challenge_unknown_or_expired' } },
      { kind: 'http' as const, status: 400, body: { valid: false, reason: 'challenge_unknown_or_expired' } },
      { kind: 'http' as const, status: 410, body: { reason: 'challenge_unknown_or_expired' } },
    ]
    for (const o of outcomes) {
      const v = toDeviceCheckView(o, { claimed: CLAIMED, idAttestation: 'included' })
      expect(v.status).toBe('could_not_verify')
      expect(v.headline).toBe('Could not verify (challenge expired, try again).')
      expect(all(v)).not.toMatch(/genuine|not verified/i)
    }
  })

  it("idAttestation 'error' shows the native detail; 'not_requested' is plain", () => {
    const v = toDeviceCheckView(
      { kind: 'ok', body: ok() },
      { claimed: CLAIMED, idAttestation: 'error', idError: 'tee+ids: ProviderException: boom' },
    )
    expect(v.proves).toContain('Model: not attested (ID attestation failed, see details)')
    expect(v.notes[0]).toBe('ID attestation detail: tee+ids: ProviderException: boom')
    const n = toDeviceCheckView({ kind: 'ok', body: ok() }, { claimed: CLAIMED, idAttestation: 'not_requested' })
    expect(n.proves).toContain('Model: not attested')
  })
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const GOOD_ATTEST: AttestResultLike = {
  chain: ['bGVhZg==', 'aW50'],
  strongBox: false,
  idAttestation: 'refused',
  claimed: CLAIMED,
}

function deps(
  routes: { challenge: () => Response | Promise<Response>; verify?: () => Response },
  attest = GOOD_ATTEST,
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/v1/device-attestation/challenge')) return routes.challenge()
    if (String(url).endsWith('/v1/device-attestation/verify') && routes.verify) return routes.verify()
    return json(404, { error: 'not found' })
  }) as unknown as typeof fetch
  const attestKey = vi.fn(async () => attest)
  return { calls, attestKey, d: { fetch: fetchImpl, isAvailable: () => true, attestKey } }
}

describe('deviceCheckFlow (GET challenge -> attest -> POST verify)', () => {
  it('happy path: attests the server nonce and posts {challenge, chain}', async () => {
    const t = deps({
      challenge: () => json(200, { challenge: CHALLENGE, expires_in: 300 }),
      verify: () => json(200, ok()),
    })
    const v = await deviceCheckFlow(t.d)
    expect(t.attestKey).toHaveBeenCalledWith(CHALLENGE, { strongBox: true, includeDeviceIds: true })
    const post = t.calls[1]
    expect(post.url).toBe('https://api.solsentry.app/v1/device-attestation/verify')
    expect(post.init?.method).toBe('POST')
    expect(JSON.parse(String(post.init?.body))).toEqual({ challenge: CHALLENGE, chain: GOOD_ATTEST.chain })
    expect(v.status).toBe('verified')
    expect(v.proves).toContain('Model: not attested (the device declined ID attestation)')
  })

  for (const [name, challenge] of [
    ['404', () => json(404, { error: 'not found' })],
    ['500', () => json(500, {})],
    ['network error', () => Promise.reject(new Error('offline'))],
    ['malformed body', () => json(200, { challenge: 'short' })],
  ] as const) {
    it(`challenge GET ${name} -> unavailable, module never called`, async () => {
      const t = deps({ challenge })
      const v = await deviceCheckFlow(t.d)
      expect(v.status).toBe('unavailable')
      expect(v.headline).toBe(TEXT.unavailable)
      expect(t.attestKey).not.toHaveBeenCalled()
    })
  }

  it('verify 404 -> unavailable', async () => {
    const t = deps({
      challenge: () => json(200, { challenge: CHALLENGE, expires_in: 300 }),
      verify: () => json(404, {}),
    })
    expect((await deviceCheckFlow(t.d)).status).toBe('unavailable')
  })

  it('verify challenge expired -> try again text', async () => {
    const t = deps({
      challenge: () => json(200, { challenge: CHALLENGE, expires_in: 300 }),
      verify: () => json(400, { valid: false, reason: 'challenge_unknown_or_expired' }),
    })
    expect((await deviceCheckFlow(t.d)).headline).toBe(TEXT.challengeExpired)
  })

  it('module returns no chain -> could not verify with the native error as detail, no POST', async () => {
    const t = deps(
      { challenge: () => json(200, { challenge: CHALLENGE, expires_in: 300 }), verify: () => json(200, ok()) },
      { chain: [], strongBox: false, idAttestation: 'error', error: 'tee: ProviderException: x', claimed: CLAIMED },
    )
    const v = await deviceCheckFlow(t.d)
    expect(v.status).toBe('could_not_verify')
    expect(v.notes[0]).toBe('Detail: tee: ProviderException: x')
    expect(t.calls).toHaveLength(1)
  })

  it('module unavailable -> unavailable, no network', async () => {
    const t = deps({ challenge: () => json(200, { challenge: CHALLENGE, expires_in: 300 }) })
    const v = await deviceCheckFlow({ ...t.d, isAvailable: () => false })
    expect(v.status).toBe('unavailable')
    expect(t.calls).toHaveLength(0)
  })
})
