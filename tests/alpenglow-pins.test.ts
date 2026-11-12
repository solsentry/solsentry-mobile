import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { CertificateClient } from '../src/alpenglow/client'
import { verifyEpochPolicy, type EpochPolicyNetwork } from '../src/alpenglow/epoch-pins'
import {
  base64url,
  canonical,
  digest,
  fields,
  keyDirectory,
  list,
  signatureValid,
  strictJson,
  TIME,
  taggedDigest,
} from '../src/alpenglow/policy-wire'
import { MAINNET_POLICY } from '../src/alpenglow/verifier'

type Case = {
  name: string
  root_public_key: string
  key_directory: unknown
  history: unknown
  now: string
  expect: unknown
}
type Cross = { name: string; kind_to: string; input: Case; expect: unknown }
const fixture = resolve(__dirname, 'fixtures/alpenglow')
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(fixture, name)))
const vectors = JSON.parse(Buffer.from(bytes('epoch-pins-v1.json')).toString('utf8')) as {
  keys: Record<string, { public_key: string; seed_hex: string }>
  vectors: Case[]
  crossfeed: Cross[]
}
const network: EpochPolicyNetwork = {
  cluster: 'synthetic',
  genesisHash: 'synthetic',
  shredVersion: 0,
  slotsPerEpoch: 432000,
  firstNormalEpoch: 0,
  firstNormalSlot: 0,
}
const root = (value: string) => base64url(value, 32, 32)
const check = (v: Case) =>
  verifyEpochPolicy(
    { rootPublicKey: root(v.root_public_key), network },
    { keyDirectory: v.key_directory, history: v.history, now: v.now },
  ).verdict
const encode = (raw: Uint8Array) => Buffer.from(raw).toString('base64url')

// K3 is the existing floor reader's contract, only for the cross-feed harness.
// It is not a new floor policy in the app. The positive control below prevents
// a reject-everything harness from appearing to validate cross-feed protection.
function checkFloor(history: unknown, publicKey: Uint8Array): void {
  const h = fields(history, ['v', 'entries'])
  if (h.v !== 'floor_history/1') throw new Error('floor history')
  for (const [i, value] of list(h.entries, 64).entries()) {
    const entry = fields(value, ['file', 'sig'])
    const raw = base64url(entry.file, 1 << 20)
    if (!signatureValid(publicKey, base64url(entry.sig, 64, 64), raw)) throw new Error('floor signature')
    const f = fields(strictJson(raw), ['v', 'rev', 'min_labels_build', 'min_server_release', 'set_at', 'reason'])
    if (
      f.v !== 1 ||
      f.rev !== i + 1 ||
      !(
        f.min_labels_build === null ||
        (typeof f.min_labels_build === 'string' &&
          /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}(?![\s\S])/.test(f.min_labels_build))
      ) ||
      !(
        f.min_server_release === null ||
        (typeof f.min_server_release === 'number' &&
          Number.isSafeInteger(f.min_server_release) &&
          f.min_server_release >= 1)
      ) ||
      typeof f.set_at !== 'string' ||
      !TIME.test(f.set_at) ||
      typeof f.reason !== 'string'
    )
      throw new Error('floor schema')
  }
}
function crosscheck(v: Cross): unknown {
  if (v.kind_to === 'K4' || (v.kind_to === 'K5' && Object.hasOwn(v.input, 'history'))) {
    const result = check(v.input)
    return result.result === 'refused' ? { refused: result.step } : result
  }
  try {
    if (v.kind_to === 'K3') checkFloor(v.input.history, root(v.input.root_public_key))
    else keyDirectory(v.input.key_directory, root(v.input.root_public_key))
    return { result: 'ok' }
  } catch {
    return { refused: v.kind_to === 'K3' ? 'floor_history' : 'directory' }
  }
}

describe('Signed epoch policy reference vectors, public RFC 8032 test keys', () => {
  it('pins the unchanged upstream bytes and complete case counts', () => {
    expect(digest(bytes('epoch-pins-v1.json'))).toBe('c94ea53987a6d9026377e24a0ae6a2d2f453cf07b944aa4d96f0bba19d1a07b1')
    expect(vectors.vectors).toHaveLength(75)
    expect(vectors.crossfeed).toHaveLength(35)
  })
  for (const v of vectors.vectors) it(v.name, () => expect(check(v)).toEqual(v.expect))
  for (const v of vectors.crossfeed) it(`cross-feed ${v.name}`, () => expect(crosscheck(v)).toEqual(v.expect))
  it('the cross-feed harness also accepts legitimate root floors and directories', () => {
    const f = canonical({
      v: 1,
      rev: 1,
      min_labels_build: null,
      min_server_release: null,
      set_at: '2026-11-10T00:00:00Z',
      reason: 'public test only',
    })
    const sig = ed25519.sign(f, hexToBytes(vectors.keys.root.seed_hex))
    expect(() =>
      checkFloor(
        { v: 'floor_history/1', entries: [{ file: encode(f), sig: encode(sig) }] },
        root(vectors.keys.root.public_key),
      ),
    ).not.toThrow()
    expect(() => keyDirectory(vectors.vectors[0].key_directory, root(vectors.keys.root.public_key))).not.toThrow()
  })
})

describe('Caller trust and strict policy wire safeguards', () => {
  for (const mutation of ['digest', 'epoch-key'] as const) {
    it(`rejects a signed policy with a trailing newline in its ${mutation}`, () => {
      const v = structuredClone(vectors.vectors[0])
      const h = v.history as { entries: { file: string; sig: string }[] }
      const f = JSON.parse(Buffer.from(base64url(h.entries[0].file, 32768)).toString())
      if (mutation === 'digest') f.tables['1'].tableSha256 += '\n'
      else {
        f.tables['1\n'] = f.tables['1']
        delete f.tables['1']
      }
      const raw = mutation === 'epoch-key' ? utf8ToBytes(JSON.stringify(f)) : canonical(f)
      h.entries[0] = { file: encode(raw), sig: encode(ed25519.sign(raw, hexToBytes(vectors.keys.table.seed_hex))) }
      expect(check(v)).toEqual({ result: 'refused', step: 'schema' })
    })
  }
  it('rejects a root-signed directory timestamp with an extra newline', () => {
    const v = structuredClone(vectors.vectors[0])
    const directory = v.key_directory as { delegations: { delegation: Record<string, string>; sig: string }[] }
    const entry = directory.delegations[0]
    entry.delegation.not_after += '\n'
    // Canonicalize values normally, but keep the invalid timestamp in signed data.
    entry.sig = encode(
      ed25519.sign(taggedDigest('solsentry/key/v1', entry.delegation), hexToBytes(vectors.keys.root.seed_hex)),
    )
    expect(check(v)).toEqual({ result: 'refused', step: 'directory' })
  })
  it('keeps caller-owned network binding separate from a valid signature', () => {
    const v = vectors.vectors[0]
    const result = verifyEpochPolicy(
      { rootPublicKey: root(v.root_public_key), network: { ...network, genesisHash: 'other-chain' } },
      { keyDirectory: v.key_directory, history: v.history, now: v.now },
    )
    expect(result).toEqual({ verdict: { result: 'refused', step: 'network' } })
    expect(result.accepted).toBeUndefined()
  })
  it('returns immutable accepted metadata and accepts bounded raw directory/history bytes', () => {
    const v = vectors.vectors[0]
    const result = verifyEpochPolicy(
      { rootPublicKey: root(v.root_public_key), network },
      { keyDirectory: canonical(v.key_directory), history: canonical(v.history), now: v.now },
    )
    expect(result.verdict).toEqual(v.expect)
    expect(result.accepted).toMatchObject({ rev: 1, issuedAt: '2026-11-10T00:00:00Z' })
    expect(Object.isFrozen(result.accepted)).toBe(true)
    expect(Object.isFrozen(result.accepted!.tablePins[0])).toBe(true)
    expect(result.accepted!.tablePins).toHaveLength(2) // diagnostic entry excluded
  })
  it('rejects duplicate raw directory/history keys and returns no accepted metadata', () => {
    const v = vectors.vectors[0]
    const directory = Buffer.from(canonical(v.key_directory)).toString().replace('{', '{"v":"key_directory/1",')
    const history = Buffer.from(canonical(v.history)).toString().replace('{', '{"v":"epoch_tables_history/1",')
    for (const [keyDirectory, h, step] of [
      [utf8ToBytes(directory), v.history, 'directory'],
      [v.key_directory, utf8ToBytes(history), 'schema'],
    ] as const) {
      expect(
        verifyEpochPolicy(
          { rootPublicKey: root(v.root_public_key), network },
          { keyDirectory, history: h, now: v.now },
        ),
      ).toEqual({ verdict: { result: 'refused', step } })
    }
  })
  it('rejects non-scalar strings, invalid UTF-8 and preserves harmless prototype-named keys', () => {
    for (const raw of [
      utf8ToBytes('"\\ud800"'),
      new Uint8Array([0xc0, 0x80]),
      new Uint8Array([0xed, 0xa0, 0x80]),
      utf8ToBytes('{"x":1e0}'),
      utf8ToBytes('{"x":1.0}'),
    ])
      expect(() => strictJson(raw)).toThrow()
    const value = strictJson(utf8ToBytes('{"__proto__":{"safe":1}}'))
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect(Object.hasOwn(value as object, '__proto__')).toBe(true)
  })
  it('rejects low-order Ed25519 keys/signatures rather than enabling ZIP-215', () => {
    const identity = new Uint8Array(32)
    identity[0] = 1
    const signature = new Uint8Array(64)
    signature[0] = 1
    expect(signatureValid(identity, signature, utf8ToBytes('public test'))).toBe(false)
  })
  it('passes an authenticated test policy pin into the existing BLS client', async () => {
    const v = structuredClone(vectors.vectors[0])
    const h = v.history as { entries: { file: string; sig: string }[] }
    const f = JSON.parse(Buffer.from(base64url(h.entries[0].file, 32768)).toString())
    const table = bytes('table-1082.bin')
    const actualNetwork = { ...MAINNET_POLICY, genesisHash: 'explicit-test-genesis' }
    f.network = actualNetwork
    f.tables = {
      '1082': {
        tableSha256: digest(table),
        tableBytes: table.length,
        validators: 667,
        bankSlot: 467482256,
        bankSha256: 'b'.repeat(64),
        evidenceSha256: 'c'.repeat(64),
        validation: 'operator-replayed-bank',
      },
    }
    const raw = canonical(f)
    h.entries[0] = { file: encode(raw), sig: encode(ed25519.sign(raw, hexToBytes(vectors.keys.table.seed_hex))) }
    const result = verifyEpochPolicy(
      { rootPublicKey: root(v.root_public_key), network: actualNetwork },
      { keyDirectory: v.key_directory, history: h, now: v.now },
    )
    expect(result.verdict.result).toBe('ok')
    if (!result.accepted) throw new Error('No test policy accepted')
    const cert = JSON.parse(Buffer.from(bytes('certificates-1082.json')).toString()).certificates[0]
    const client = new CertificateClient(
      async (path) => (path.startsWith('epochs/') ? table : utf8ToBytes(JSON.stringify(cert))),
      MAINNET_POLICY,
      result.accepted.tablePins,
    )
    expect(await client.check(cert.slot)).toMatchObject({ status: 'verified', signatureValid: true })
  }, 15000)
})
