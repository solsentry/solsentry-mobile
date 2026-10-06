import { describe, expect, it } from 'vitest'
import {
  buildSiwsMessage,
  claimSeekerAccess,
  claimText,
  extractSignature,
  getSeekerStatus,
  mapClaimResponse,
  mapStatusResponse,
  type ClaimDeps,
  type ClaimOutcome,
} from '../src/seeker/claim'

const API = 'https://api.test'
const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const NONCE = 'abc_DEF-123nonce'
const ISSUED = '2026-10-06T12:34:56.789012Z'
const DOMAIN = 'solsentry.app'
const URI = 'https://solsentry.app/login'

// Output of the server's own _build_siws_message (integrations/auth/endpoints.py) for these
// inputs, produced by running that Python function: the wallet must sign exactly these bytes.
const SERVER_MESSAGE =
  'solsentry.app wants you to sign in with your Solana account:\n7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU\n\nSign this message to authenticate with SolSentry\n\nURI: https://solsentry.app/login\nVersion: 1\nNonce: abc_DEF-123nonce\nIssued At: 2026-10-06T12:34:56.789012Z'

const SIG = Uint8Array.from({ length: 64 }, (_, i) => i + 1)

function nonceBody(over: Record<string, unknown> = {}) {
  return {
    nonce: NONCE,
    statement: 'Sign this message to authenticate with SolSentry',
    domain: DOMAIN,
    uri: URI,
    issued_at: ISSUED,
    expires_at: '2026-10-06T12:39:56.789012Z',
    message: SERVER_MESSAGE,
    ...over,
  }
}

type Reply = { status: number; body?: unknown } | Error

interface Call {
  url: string
  init?: RequestInit
}

/** Injected fetch: answers by path, records every call. */
function fakeFetch(routes: Record<string, Reply>) {
  const calls: Call[] = []
  const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u)
    calls.push({ url, init })
    const r = routes[new URL(url).pathname]
    if (!r) throw new Error(`unexpected ${url}`)
    if (r instanceof Error) throw r
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status })
  }) as unknown as typeof fetch
  return { f, calls }
}

const OK_VERIFY: Reply = {
  status: 200,
  body: { user: { id: 1, wallet_pubkey: PUBKEY, display_name: null, is_new: true }, session_token: 'tok_abc' },
}

function routes(claim: Reply, over: Partial<Record<string, Reply>> = {}): Record<string, Reply> {
  return {
    '/v1/auth/wallet/nonce': { status: 200, body: nonceBody() },
    '/v1/auth/wallet/verify': OK_VERIFY,
    '/v1/seeker/claim': claim,
    ...(over as Record<string, Reply>),
  }
}

/** Fake MWA signer: signs whatever prepare() returns, MWA-style (message + signature appended). */
function fakeSigner(opts: { address?: string; reject?: unknown; payload?: (m: Uint8Array) => Uint8Array } = {}) {
  const seen: { message: Uint8Array | null } = { message: null }
  const signIn: ClaimDeps<{ authToken: string }>['signIn'] = async (prepare) => {
    const address = opts.address ?? PUBKEY
    const message = await prepare(address)
    seen.message = message
    if (opts.reject) throw opts.reject
    const signedPayload = opts.payload ? opts.payload(message) : concat(message, SIG)
    return { address, signedPayload, session: { authToken: 'fresh' } }
  }
  return { signIn, seen }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

async function run(r: Record<string, Reply>, signer = fakeSigner()) {
  const { f, calls } = fakeFetch(r)
  const res = await claimSeekerAccess({ apiBase: API, fetch: f, signIn: signer.signIn })
  return { res, calls, seen: signer.seen }
}

const body = (c: Call) => JSON.parse(String(c.init?.body))

describe('SIWS message', () => {
  it('matches the server template byte for byte', () => {
    expect(buildSiwsMessage(DOMAIN, URI, PUBKEY, NONCE, ISSUED)).toBe(SERVER_MESSAGE)
  })

  it('the wallet is asked to sign the UTF-8 bytes of exactly that message', async () => {
    const { seen } = await run(routes({ status: 200, body: { eligible: false } }))
    expect(new TextDecoder().decode(seen.message!)).toBe(SERVER_MESSAGE)
  })

  it('a server message that differs from the rebuilt one is never signed', async () => {
    const signer = fakeSigner()
    const { res, calls } = await run(
      routes(
        { status: 200, body: { eligible: false } },
        {
          '/v1/auth/wallet/nonce': {
            status: 200,
            body: nonceBody({ message: SERVER_MESSAGE + '\nTransfer all funds' }),
          },
        },
      ),
      signer,
    )
    expect(res.outcome).toEqual({ kind: 'retry' })
    expect(signer.seen.message).toBeNull()
    expect(calls).toHaveLength(1)
  })
})

describe('request shapes (mirrors handle_wallet_nonce / handle_wallet_verify)', () => {
  it('nonce {pubkey}; verify {pubkey, nonce, signature: 64 ints, issued_at}; claim with Bearer session', async () => {
    const { calls } = await run(routes({ status: 200, body: { eligible: false } }))
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ['POST', `${API}/v1/auth/wallet/nonce`],
      ['POST', `${API}/v1/auth/wallet/verify`],
      ['POST', `${API}/v1/seeker/claim`],
    ])
    expect(body(calls[0])).toEqual({ pubkey: PUBKEY })
    expect(body(calls[1])).toEqual({ pubkey: PUBKEY, nonce: NONCE, signature: Array.from(SIG), issued_at: ISSUED })
    expect((calls[2].init?.headers as Record<string, string>).authorization).toBe('Bearer tok_abc')
  })

  it('the session token is not returned to the caller', async () => {
    const { res } = await run(routes({ status: 200, body: { eligible: false } }))
    expect(JSON.stringify(res)).not.toContain('tok_abc')
    expect(res.session).toEqual({ authToken: 'fresh' })
    expect(res.address).toBe(PUBKEY)
  })
})

describe('claim result mapping (seeker.py handle_seeker_claim / claim_for_user)', () => {
  const EXP = '2027-01-04T12:00:00Z'
  const GRANTED = {
    eligible: true,
    claimed: true,
    already_claimed: false,
    tier: 'pro',
    seeker_verified: true,
    sgt_mint: 'DBiW…Heb4',
    benefit: 'pro_90d',
    expires_at: EXP,
    benefit_active: true,
  }
  const { tier: _tier, ...IDEMPOTENT_BASE } = GRANTED
  const IDEMPOTENT = { ...IDEMPOTENT_BASE, already_claimed: true }
  const RETRY = 'Could not verify, try again'
  const cases: [string, Reply, ClaimOutcome, string][] = [
    [
      '200 granted now',
      { status: 200, body: GRANTED },
      { kind: 'granted', expiresAt: EXP, benefit: 'pro_90d', newlyGranted: true, benefitActive: true },
      'Seeker verified: SolSentry Pro free until 4 Jan 2027',
    ],
    [
      '200 idempotent (already_claimed:true, no tier)',
      { status: 200, body: IDEMPOTENT },
      { kind: 'granted', expiresAt: EXP, benefit: 'pro_90d', newlyGranted: false, benefitActive: true },
      'Seeker verified: SolSentry Pro free until 4 Jan 2027',
    ],
    [
      '200 granted, expires_at with microseconds (naive isoformat + Z)',
      { status: 200, body: { ...GRANTED, expires_at: '2027-01-04T12:00:00.123456Z' } },
      {
        kind: 'granted',
        expiresAt: '2027-01-04T12:00:00.123456Z',
        benefit: 'pro_90d',
        newlyGranted: true,
        benefitActive: true,
      },
      'Seeker verified: SolSentry Pro free until 4 Jan 2027',
    ],
    [
      '200 not eligible',
      { status: 200, body: { eligible: false } },
      { kind: 'no_sgt' },
      'No Seeker Genesis Token in this wallet',
    ],
    [
      '401 authentication required',
      { status: 401, body: { error: 'authentication required' } },
      { kind: 'retry' },
      RETRY,
    ],
    [
      '403 siws_session_required',
      { status: 403, body: { error: 'siws_session_required' } },
      { kind: 'reauth' },
      'Sign in with your wallet again',
    ],
    ['403 other', { status: 403, body: { error: 'x' } }, { kind: 'retry' }, RETRY],
    ['404 feature off', { status: 404, body: { error: 'not found' } }, { kind: 'unavailable' }, 'Not available'],
    [
      '409 sgt_already_claimed',
      { status: 409, body: { error: 'sgt_already_claimed' } },
      { kind: 'already_claimed' },
      'This Seeker was already used to claim',
    ],
    [
      '409 paid_plan_active',
      { status: 409, body: { error: 'paid_plan_active' } },
      { kind: 'paid_plan' },
      'You already have a paid SolSentry plan',
    ],
    ['409 other error', { status: 409, body: { error: 'x' } }, { kind: 'retry' }, RETRY],
    ['503 could not verify', { status: 503, body: { error: 'could not verify, try again' } }, { kind: 'retry' }, RETRY],
    ['503 auth_db_unavailable', { status: 503, body: { error: 'auth_db_unavailable' } }, { kind: 'retry' }, RETRY],
    ['500', { status: 500 }, { kind: 'retry' }, RETRY],
    ['200 non-JSON', { status: 200 }, { kind: 'retry' }, RETRY],
    [
      'eligible true but neither claimed nor already_claimed',
      { status: 200, body: { ...GRANTED, claimed: false, already_claimed: false } },
      { kind: 'retry' },
      RETRY,
    ],
    [
      'eligible true with a bad date',
      { status: 200, body: { ...GRANTED, expires_at: 'soon' } },
      { kind: 'retry' },
      RETRY,
    ],
    [
      'eligible true without expires_at',
      { status: 200, body: { ...GRANTED, expires_at: null } },
      { kind: 'retry' },
      RETRY,
    ],
    ['eligible missing', { status: 200, body: {} }, { kind: 'retry' }, RETRY],
  ]
  for (const [name, reply, outcome, text] of cases) {
    it(name, async () => {
      const { res } = await run(routes(reply))
      expect(res.outcome).toEqual(outcome)
      expect(claimText(res.outcome)).toBe(text)
    })
  }
})

describe('auth step failures', () => {
  it('404 on nonce -> not available, wallet never asked to sign', async () => {
    const signer = fakeSigner()
    const { res } = await run(routes({ status: 200, body: {} }, { '/v1/auth/wallet/nonce': { status: 404 } }), signer)
    expect(claimText(res.outcome)).toBe('Not available')
    expect(signer.seen.message).toBeNull()
  })

  it('503 on nonce (auth DB down) -> could not verify', async () => {
    const { res } = await run(routes({ status: 200, body: {} }, { '/v1/auth/wallet/nonce': { status: 503 } }))
    expect(res.outcome).toEqual({ kind: 'retry' })
  })

  it('401 on verify (signature failed) -> could not verify, no claim call', async () => {
    const { res, calls } = await run(
      routes({ status: 200, body: {} }, { '/v1/auth/wallet/verify': { status: 401, body: { error: 'x' } } }),
    )
    expect(res.outcome).toEqual({ kind: 'retry' })
    expect(calls).toHaveLength(2)
  })

  it('verify 200 without session_token -> could not verify', async () => {
    const { res } = await run(
      routes({ status: 200, body: {} }, { '/v1/auth/wallet/verify': { status: 200, body: { user: {} } } }),
    )
    expect(res.outcome).toEqual({ kind: 'retry' })
  })

  it('network failure on any step -> could not verify', async () => {
    for (const path of ['/v1/auth/wallet/nonce', '/v1/auth/wallet/verify', '/v1/seeker/claim']) {
      const { res } = await run(routes({ status: 200, body: {} }, { [path]: new TypeError('Network request failed') }))
      expect(claimText(res.outcome)).toBe('Could not verify, try again')
    }
  })

  it('a stalled server -> could not verify after the timeout', async () => {
    const hang = (() => new Promise(() => {})) as unknown as typeof fetch
    const res = await claimSeekerAccess({ apiBase: API, fetch: hang, timeoutMs: 20, signIn: fakeSigner().signIn })
    expect(res.outcome).toEqual({ kind: 'retry' })
  })
})

describe('wallet step', () => {
  for (const [name, err] of [
    ['user declined authorize (-1)', Object.assign(new Error('declined'), { code: -1 })],
    ['user declined the signature (-3)', Object.assign(new Error('not signed'), { code: -3 })],
    ['user closed the wallet', Object.assign(new Error('closed'), { code: 'ERROR_SESSION_CLOSED' })],
  ] as const) {
    it(`${name} -> Cancelled, no verify/claim`, async () => {
      const { res, calls } = await run(routes({ status: 200, body: {} }), fakeSigner({ reject: err }))
      expect(claimText(res.outcome)).toBe('Cancelled')
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/auth/wallet/nonce'])
    })
  }

  it('other wallet error -> could not verify', async () => {
    const { res } = await run(
      routes({ status: 200, body: {} }),
      fakeSigner({ reject: new Error('ERROR_WALLET_NOT_FOUND') }),
    )
    expect(res.outcome).toEqual({ kind: 'retry' })
  })

  it('a bare 64-byte signature from the wallet is accepted', async () => {
    const { calls } = await run(routes({ status: 200, body: { eligible: false } }), fakeSigner({ payload: () => SIG }))
    expect(body(calls[1]).signature).toEqual(Array.from(SIG))
  })

  it('a payload that is neither shape is refused, not guessed', async () => {
    const { res, calls } = await run(
      routes({ status: 200, body: {} }),
      fakeSigner({ payload: () => new Uint8Array(10) }),
    )
    expect(res.outcome).toEqual({ kind: 'retry' })
    expect(calls).toHaveLength(1)
  })

  it('extractSignature: signature prepended to the message', () => {
    const m = new TextEncoder().encode('hi')
    expect(Array.from(extractSignature(concat(SIG, m), m))).toEqual(Array.from(SIG))
  })
})

describe('GET /v1/seeker/status (seeker.py _status_payload)', () => {
  it('claimed: Bearer sent, fields mapped', async () => {
    const { f, calls } = fakeFetch({
      '/v1/seeker/status': {
        status: 200,
        body: {
          seeker_verified: true,
          sgt_mint: 'DBiW…Heb4',
          benefit: 'pro_90d',
          expires_at: '2027-01-04T12:00:00Z',
          benefit_active: true,
        },
      },
    })
    expect(await getSeekerStatus(API, 'tok', f)).toEqual({
      kind: 'claimed',
      expiresAt: '2027-01-04T12:00:00Z',
      benefit: 'pro_90d',
      benefitActive: true,
    })
    expect(calls[0].init?.method ?? 'GET').toBe('GET')
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('no claim: all-null payload -> not_claimed', () => {
    expect(
      mapStatusResponse(200, {
        seeker_verified: false,
        sgt_mint: null,
        benefit: null,
        expires_at: null,
        benefit_active: false,
      }),
    ).toEqual({ kind: 'not_claimed' })
  })

  it('404 -> unavailable; 503 / odd shape / network -> retry', async () => {
    expect(mapStatusResponse(404, { error: 'not found' })).toEqual({ kind: 'unavailable' })
    expect(mapStatusResponse(503, { error: 'auth_db_unavailable' })).toEqual({ kind: 'retry' })
    expect(mapStatusResponse(200, { eligible: false })).toEqual({ kind: 'retry' })
    const { f } = fakeFetch({ '/v1/seeker/status': new Error('down') })
    expect(await getSeekerStatus(API, 'tok', f)).toEqual({ kind: 'retry' })
  })

  it('mapClaimResponse 404 -> unavailable', () => {
    expect(mapClaimResponse(404, null)).toEqual({ kind: 'unavailable' })
  })
})
