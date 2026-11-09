import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CertificateClient, type ReadArtifact } from '../src/alpenglow/client'
import { signerGroups } from '../src/alpenglow/codec'
import {
  EpochTable,
  MAINNET_POLICY,
  finalityMessage,
  type NetworkPolicy,
  type VoteKind,
} from '../src/alpenglow/verifier'

const directory = resolve(__dirname, 'fixtures/alpenglow')
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(directory, name)))
const json = (name: string) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
const devnet: NetworkPolicy = { ...MAINNET_POLICY, cluster: 'devnet', shredVersion: 7016 }
const synthetic = json('synthetic.json') as {
  name: string
  slot: number
  aggregate: { kind: number; sig: string; block_id: string; bitmap: string }
}[]
const syntheticTable = () => EpochTable.load(bytes('table-synthetic.bin'), MAINNET_POLICY)

describe('Alpenglow public captures, independent py_ecc reference', () => {
  it('loads the retained epoch 1083 table without claiming a live 1083 certificate', () => {
    const metadata = json('table-1083.json')
    const table = EpochTable.load(bytes('table-1083.bin'), MAINNET_POLICY)
    expect(table.info).toMatchObject({
      epoch: 1083,
      validators: 668,
      sha256: metadata.tableSha256,
      trust: 'untrusted',
    })
    expect(metadata.certificateObservations).toBe(0)
    const old = json('certificates-1082.json').certificates[0]
    expect(table.verifyFinality(old, old.slot)).toMatchObject({ status: 'invalid', signatureValid: false })
    // Relabelling an old signature with the next epoch's first slot cannot authenticate it.
    const firstSlot = 1083 * MAINNET_POLICY.slotsPerEpoch
    expect(table.verifyFinality({ ...old, slot: firstSlot }, firstSlot).status).toBe('invalid')
    expect(
      EpochTable.load(bytes('table-1082.bin'), MAINNET_POLICY).verifyFinality({ ...old, slot: firstSlot }, firstSlot)
        .status,
    ).toBe('invalid')
  }, 30000)

  for (const epoch of [1080, 1081, 1082, 1204]) {
    it(`verifies every captured certificate in epoch ${epoch}`, () => {
      const fixture = json(`certificates-${epoch}.json`)
      const table = EpochTable.load(bytes(`table-${epoch}.bin`), epoch === 1204 ? devnet : MAINNET_POLICY, [
        { epoch, sha256: fixture.tableSha256 },
      ])
      expect(fixture.certificates).toHaveLength(epoch === 1080 ? 12 : 40)
      for (const cert of fixture.certificates) {
        const result = table.verifyFinality(cert, cert.slot)
        expect(result, `slot ${cert.slot}`).toMatchObject({ status: 'verified', signatureValid: true })
      }
      // All observed certificates must fail with a changed request target.
      const cert = fixture.certificates[0]
      expect(table.verifyFinality(cert, cert.slot + 1).status).toBe('invalid')
      const altered = structuredClone(cert)
      const aggregate = altered.notar ?? altered.final
      const block = Buffer.from(aggregate.block_id, 'base64')
      block[0] ^= 1
      aggregate.block_id = block.toString('base64')
      expect(table.verifyFinality(altered, cert.slot).status).toBe('invalid')
    }, 30000)
  }

  it('requires both slow-path signatures and binds the requested Merkle root', () => {
    const fixture = json('certificates-1204.json')
    const table = EpochTable.load(bytes('table-1204.bin'), devnet)
    const cert = fixture.certificates.find((c: { notar: unknown }) => c.notar !== null)
    expect(table.verifyFinality(cert, cert.slot)).toMatchObject({ status: 'untrusted-table', path: 'slow' })
    expect(table.verifyFinality(cert, cert.slot, cert.notar.block_id).signatureValid).toBe(true)
    expect(table.verifyFinality(cert, cert.slot, Buffer.alloc(32).toString('base64')).status).toBe('invalid')
    for (const name of ['notar', 'final']) {
      const bad = structuredClone(cert)
      const signature = Buffer.from(bad[name].sig, 'base64')
      signature[20] ^= 1
      bad[name].sig = signature.toString('base64')
      expect(table.verifyFinality(bad, cert.slot).status).toBe('invalid')
    }
    expect(table.verifyFinality({ ...cert, notar: null }, cert.slot).status).toBe('invalid')
  })

  it('binds BLS verification to the configured shred version, independently of the table header', () => {
    const fixture = json('certificates-1082.json'),
      raw = bytes('table-1082.bin')
    new DataView(raw.buffer).setUint16(6, 50094, true)
    const table = EpochTable.load(raw, { ...MAINNET_POLICY, shredVersion: 50094 })
    expect(table.verifyFinality(fixture.certificates[0], fixture.certificates[0].slot)).toMatchObject({
      status: 'invalid',
      reason: 'Signature verification failed',
    })
  })
})

describe('Stake thresholds, bitmap formats and malformed inputs', () => {
  const names: Record<string, VoteKind> = {
    'fast-exact-80': 'fast-finalize',
    'notar-exact-60': 'notarize',
    'final-exact-60': 'finalize',
    'skip-base2': 'skip',
    'notar-fallback-mixed': 'notarize-fallback',
    'skip-mixed': 'skip',
    'skip-fallback-only': 'skip',
  }
  it('matches independent Base2/Base3 signatures, including exact 60/80 percent thresholds', () => {
    const table = syntheticTable()
    for (const [name, kind] of Object.entries(names)) {
      const c = synthetic.find((c) => c.name === name)!
      expect(table.verifyAggregate(kind, c.aggregate, c.slot).signers).toBeGreaterThan(0)
    }
    const low = synthetic.find((c) => c.name === 'fast-insufficient')!
    expect(() => table.verifyAggregate('fast-finalize', low.aggregate, low.slot)).toThrow('Insufficient signer stake')
  })

  it('uses integer arithmetic even when float rounding would accept insufficient stake', () => {
    const raw = bytes('table-synthetic.bin')
    const view = new DataView(raw.buffer)
    // Total = 100000000000000001; rank 0 is less than 60%, but Number() rounds it to 60%.
    for (const [i, stake] of [
      60000000000000000n,
      20000000000000000n,
      10000000000000000n,
      6000000000000000n,
      4000000000000001n,
    ].entries()) {
      view.setBigUint64(32 + i * 56 + 48, stake, true)
    }
    const c = synthetic.find((c) => c.name === 'notar-exact-60')!
    const a = { ...c.aggregate, bitmap: Buffer.from([0, 1, 0, 1]).toString('base64') }
    expect(() => EpochTable.load(raw, MAINNET_POLICY).verifyAggregate('notarize', a, c.slot)).toThrow(
      'Insufficient signer stake',
    )
  })

  it('rejects wrong signature kinds, epochs, missing slow parts, infinity and oversized encodings', () => {
    const table = syntheticTable(),
      c = synthetic[0]
    for (const aggregate of [
      { ...c.aggregate, kind: 1 },
      { ...c.aggregate, sig: '' },
      { ...c.aggregate, sig: Buffer.concat([Buffer.from([192]), Buffer.alloc(95)]).toString('base64') },
      { ...c.aggregate, bitmap: 'AAAA' },
      { ...c.aggregate, bitmap: 'A'.repeat(600) },
      { ...c.aggregate, block_id: 'bad' },
    ])
      expect(table.verifyFinality({ slot: c.slot, final: aggregate, notar: null }, c.slot).status).toBe('invalid')
    expect(table.verifyFinality({ slot: c.slot, final: c.aggregate }, c.slot).status).toBe('invalid')
    expect(
      table.verifyFinality({ slot: c.slot - 432000, final: c.aggregate, notar: null }, c.slot - 432000).status,
    ).toBe('invalid')
    const mixed = synthetic.find((c) => c.name === 'notar-fallback-mixed')!
    expect(() => table.verifyAggregate('notarize', mixed.aggregate, mixed.slot)).toThrow('Base3')
  })

  it('binds the Base3 group to the payload actually signed by each validator', () => {
    const table = syntheticTable(),
      c = synthetic.find((c) => c.name === 'skip-mixed')!
    const bm = Buffer.from(c.aggregate.bitmap, 'base64')
    bm[3] = 2 + 3 // swap ranks 0 and 1
    expect(() => table.verifyAggregate('skip', { ...c.aggregate, bitmap: bm.toString('base64') }, c.slot)).toThrow(
      'Signature verification failed',
    )
    for (const bm of [
      new Uint8Array(),
      new Uint8Array([9, 1, 0, 1]),
      new Uint8Array([0, 6, 0, 63]),
      new Uint8Array([1, 5, 0]),
    ]) {
      expect(() => signerGroups(bm, 5)).toThrow()
    }
  })

  it('rejects changed metadata, bad rank order, duplicate/identity keys and pin mismatches', () => {
    const fixture = json('certificates-1082.json')
    expect(() =>
      EpochTable.load(bytes('table-1082.bin'), MAINNET_POLICY, [{ epoch: 1082, sha256: '0'.repeat(64) }]),
    ).toThrow('digest')
    for (const change of [
      (r: Uint8Array) => {
        r[5] = 1
      },
      (r: Uint8Array) => {
        r[6] ^= 1
      },
      (r: Uint8Array) => {
        r[8] ^= 1
      },
      (r: Uint8Array) => {
        r[30] = 1
      },
      (r: Uint8Array) => {
        r.set(r.slice(32, 80), 88)
      },
      (r: Uint8Array) => {
        r.fill(0, 32, 80)
        r[32] = 192
      },
      (r: Uint8Array) => {
        r.fill(0, 80, 88)
      },
      (r: Uint8Array) => {
        const first = r.slice(32, 88)
        r.set(r.slice(88, 144), 32)
        r.set(first, 88)
      },
    ]) {
      const r = bytes('table-1082.bin')
      change(r)
      expect(() => EpochTable.load(r, MAINNET_POLICY)).toThrow()
    }
    const raw = bytes('table-1082.bin'),
      table = EpochTable.load(raw, MAINNET_POLICY)
    raw.fill(0)
    expect(table.verifyFinality(fixture.certificates[0], fixture.certificates[0].slot).signatureValid).toBe(true)
    expect(finalityMessage(table.verifyFinality(fixture.certificates[0], fixture.certificates[0].slot))).toContain(
      'not trusted',
    )
  })
})

describe('Phone integration with a bounded artifact transport', () => {
  it('cancels an uncooperative transport and never starts a pre-cancelled request', async () => {
    const controller = new AbortController()
    let transportSignal: AbortSignal | undefined
    let reads = 0
    const client = new CertificateClient(async (_path, { signal }) => {
      reads++
      transportSignal = signal
      return new Promise<Uint8Array>(() => {})
    }, MAINNET_POLICY)
    const pending = client.check(467424001, undefined, 30000, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'Certificate request cancelled' })
    expect(transportSignal?.aborted).toBe(true)
    expect(await client.check(467424001, undefined, 30000, controller.signal)).toMatchObject({
      status: 'unavailable',
      reason: 'Certificate request cancelled',
    })
    expect(reads).toBe(1)
  })

  it('fetches the certificate target epoch, caches its table and checks the next epoch separately', async () => {
    const calls: string[] = []
    const fixtures = [1081, 1082].map((e) => json(`certificates-${e}.json`))
    const read: ReadArtifact = async (path) => {
      calls.push(path)
      if (path.endsWith('table.bin')) return bytes(`table-${path.split('/')[1]}.bin`)
      const slot = Number(path.split('/')[1].replace('.json', ''))
      const cert = fixtures.flatMap((f) => f.certificates).find((c) => c.slot === slot)
      return new TextEncoder().encode(JSON.stringify(cert))
    }
    const client = new CertificateClient(
      read,
      MAINNET_POLICY,
      fixtures.map((f) => ({ epoch: f.epoch, sha256: f.tableSha256 })),
    )
    for (const f of fixtures) {
      for (let i = 0; i < 2; i++) expect((await client.check(f.certificates[0].slot)).status).toBe('verified')
    }
    expect(calls.filter((p) => p.endsWith('table.bin'))).toEqual(['epochs/1081/table.bin', 'epochs/1082/table.bin'])
  }, 15000)

  it('fails closed on outages, malformed bodies, wrong tables and a transport that ignores cancellation', async () => {
    const cert = json('certificates-1082.json').certificates[0]
    const policy = { ...MAINNET_POLICY },
      pins = [{ epoch: 1082, sha256: '0'.repeat(64) }]
    const read: ReadArtifact = async (path) =>
      path.startsWith('certificates/') ? new TextEncoder().encode(JSON.stringify(cert)) : bytes('table-1082.bin')
    const client = new CertificateClient(read, policy, pins)
    pins[0].sha256 = json('certificates-1082.json').tableSha256
    expect(await client.check(cert.slot)).toMatchObject({
      status: 'unavailable',
      signatureValid: false,
      reason: 'Pinned table digest mismatch',
    })
    for (const read of [
      async () => {
        throw new Error('Offline')
      },
      async () => new Uint8Array(9000),
      async () => new Uint8Array([123]),
      async () => new Promise<Uint8Array>(() => {}),
    ])
      expect(await new CertificateClient(read, MAINNET_POLICY).check(cert.slot, undefined, 20)).toMatchObject({
        status: 'unavailable',
        signatureValid: false,
      })
  })
})
