import { bls12_381 as bls } from '@noble/curves/bls12-381.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { base64, compare, equal, integer, record, requireValue, signedPayload, signerGroups } from './codec'

const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_'
const MAX_VALIDATORS = 2000
const U64_MAX = (1n << 64n) - 1n
type Point = ReturnType<typeof bls.G1.Point.fromBytes>

export interface NetworkPolicy {
  cluster: 'mainnet-beta' | 'devnet'
  shredVersion: number
  slotsPerEpoch: number
  firstNormalEpoch: number
  firstNormalSlot: number
}

// Deployment configuration, not a value accepted from a relay response.
export const MAINNET_POLICY: Readonly<NetworkPolicy> = Object.freeze({
  cluster: 'mainnet-beta',
  shredVersion: 50093,
  slotsPerEpoch: 432000,
  firstNormalEpoch: 0,
  firstNormalSlot: 0,
})

export function epochForSlot(slot: number, policy: NetworkPolicy): number {
  integer(slot, 'Slot')
  integer(policy.shredVersion, 'Shred version', 65535)
  integer(policy.slotsPerEpoch, 'Epoch length')
  integer(policy.firstNormalEpoch, 'First normal epoch')
  integer(policy.firstNormalSlot, 'First normal slot')
  requireValue(policy.slotsPerEpoch > 0 && slot >= policy.firstNormalSlot, 'Unsupported warmup slot')
  return policy.firstNormalEpoch + Math.floor((slot - policy.firstNormalSlot) / policy.slotsPerEpoch)
}

export interface TablePin {
  epoch: number
  sha256: string
}

export type TableTrust = 'operator-pinned' | 'untrusted'
export interface TableInfo {
  epoch: number
  sha256: string
  validators: number
  totalStake: string
  trust: TableTrust
}

export type VoteKind = 'notarize' | 'finalize' | 'fast-finalize' | 'notarize-fallback' | 'skip'
export interface AggregateResult {
  kind: VoteKind
  signers: number
  signerStake: string
  totalStake: string
  thresholdPercent: number
}

export interface FinalityResult {
  status: 'verified' | 'untrusted-table' | 'invalid'
  signatureValid: boolean
  table: TableInfo
  slot?: number
  blockId?: string
  path?: 'fast' | 'slow'
  aggregates?: AggregateResult[]
  reason?: string
}

// Private state prevents a caller mutating validated stakes/points after loading.
// The digest covers metadata AND the canonical rank-ordered rows.
export class EpochTable {
  readonly info: Readonly<TableInfo>
  private constructor(
    private readonly policy: Readonly<NetworkPolicy>,
    private readonly points: Point[],
    private readonly stakes: bigint[],
    private readonly total: bigint,
    info: TableInfo,
  ) {
    this.info = Object.freeze(info)
  }

  static load(bytes: Uint8Array, policy: NetworkPolicy, pins: readonly TablePin[] = []): EpochTable {
    const loader = EpochTable.decode(bytes, policy, pins)
    let step = loader.next()
    while (!step.done) step = loader.next()
    return step.value
  }

  /** Yield between small batches of subgroup checks so Hermes can paint/cancel. */
  static async loadAsync(
    bytes: Uint8Array,
    policy: NetworkPolicy,
    pins: readonly TablePin[] = [],
    signal?: AbortSignal,
  ): Promise<EpochTable> {
    const loader = EpochTable.decode(bytes, policy, pins)
    let step = loader.next()
    while (!step.done) {
      requireValue(!signal?.aborted, 'Table preparation cancelled')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      requireValue(!signal?.aborted, 'Table preparation cancelled')
      step = loader.next()
    }
    requireValue(!signal?.aborted, 'Table preparation cancelled')
    return step.value
  }

  private static *decode(
    bytes: Uint8Array,
    policy: NetworkPolicy,
    pins: readonly TablePin[],
  ): Generator<void, EpochTable> {
    policy = Object.freeze({ ...policy })
    requireValue(policy.cluster === 'mainnet-beta' || policy.cluster === 'devnet', 'Unsupported cluster')
    requireValue(new Set(pins.map((p) => p.epoch)).size === pins.length, 'Duplicate table pin')
    requireValue(bytes.length >= 32 && bytes.length <= 32 + MAX_VALIDATORS * 56, 'Table size')
    // Copy before hashing/decoding; external buffers are never retained.
    const raw = Uint8Array.from(bytes),
      view = new DataView(raw.buffer)
    requireValue(equal(raw.subarray(0, 4), new Uint8Array([83, 83, 69, 84])) && raw[4] === 1, 'Table format')
    requireValue(raw[5] === (policy.cluster === 'mainnet-beta' ? 0 : 1), 'Table cluster')
    requireValue(view.getUint16(6, true) === policy.shredVersion, 'Table shred version')
    const epochBig = view.getBigUint64(8, true),
      firstSlotBig = view.getBigUint64(16, true)
    requireValue(
      epochBig <= BigInt(Number.MAX_SAFE_INTEGER) && firstSlotBig <= BigInt(Number.MAX_SAFE_INTEGER),
      'Table integer overflow',
    )
    const epoch = Number(epochBig),
      firstSlot = Number(firstSlotBig)
    requireValue(
      epochForSlot(firstSlot, policy) === epoch &&
        firstSlot === policy.firstNormalSlot + (epoch - policy.firstNormalEpoch) * policy.slotsPerEpoch,
      'Table epoch schedule',
    )
    requireValue(
      view.getUint32(24, true) === policy.slotsPerEpoch && view.getUint16(30, true) === 0,
      'Table schedule or reserved bytes',
    )
    const n = view.getUint16(28, true)
    requireValue(n > 0 && n <= MAX_VALIDATORS && raw.length === 32 + n * 56, 'Table row count')
    const digest = bytesToHex(sha256(raw))
    const pin = pins.find((p) => p.epoch === epoch)
    requireValue(!pin || (/^[a-f0-9]{64}$/.test(pin.sha256) && pin.sha256 === digest), 'Pinned table digest mismatch')
    const points: Point[] = [],
      stakes: bigint[] = [],
      seen = new Set<string>()
    let total = 0n,
      previousKey = new Uint8Array(48),
      previousStake = U64_MAX
    for (let i = 0; i < n; i++) {
      const offset = 32 + i * 56,
        key = raw.subarray(offset, offset + 48)
      const stake = view.getBigUint64(offset + 48, true),
        keyHex = bytesToHex(key)
      requireValue(stake > 0n && !seen.has(keyHex), 'Zero stake or duplicate key')
      requireValue(
        i === 0 || stake < previousStake || (stake === previousStake && compare(previousKey, key) < 0),
        'Table rank order',
      )
      const point = bls.G1.Point.fromBytes(key)
      point.assertValidity()
      requireValue(!point.is0(), 'Identity public key')
      requireValue(equal(point.toBytes(), key), 'Noncanonical public key')
      points.push(point)
      stakes.push(stake)
      seen.add(keyHex)
      total += stake
      previousKey = Uint8Array.from(key)
      previousStake = stake
      if (i % 4 === 3) yield
    }
    requireValue(total > 0n && total <= U64_MAX, 'Total stake overflow')
    return new EpochTable(Object.freeze({ ...policy }), points, stakes, total, {
      epoch,
      sha256: digest,
      validators: n,
      totalStake: total.toString(),
      trust: pin ? 'operator-pinned' : 'untrusted',
    })
  }

  private checkSlot(slot: number): void {
    requireValue(epochForSlot(slot, this.policy) === this.info.epoch, 'Certificate epoch mismatch')
  }

  // Also checks standalone reward/fallback certificates. These do not themselves prove block finality.
  verifyAggregate(kind: VoteKind, value: unknown, slot: number): AggregateResult {
    this.checkSlot(slot)
    const tags: Record<VoteKind, number[]> = {
      notarize: [1],
      finalize: [2],
      'fast-finalize': [1],
      'notarize-fallback': [1, 4],
      skip: [3, 5],
    }
    requireValue(Object.hasOwn(tags, kind), 'Unsupported vote kind')
    const a = record(value)
    requireValue(a.kind === 0, 'Unsupported signature kind')
    const sig = base64(a.sig, 96),
      block = base64(a.block_id, 32),
      bitmap = base64(a.bitmap, 403)
    requireValue(sig.length === 96, 'Signature length')
    const needsBlock = kind !== 'finalize' && kind !== 'skip'
    requireValue(block.length === (needsBlock ? 32 : 0), 'Block ID length')
    const { version, groups } = signerGroups(bitmap, this.points.length)
    requireValue(version === 0 || tags[kind].length === 2, 'Base3 not allowed for this vote')
    const stake = groups.flat().reduce((sum, rank) => sum + this.stakes[rank], 0n)
    const threshold = kind === 'fast-finalize' ? 80 : 60
    requireValue(stake * 100n >= this.total * BigInt(threshold), 'Insufficient signer stake')
    const signature = bls.G2.Point.fromBytes(sig)
    signature.assertValidity()
    requireValue(!signature.is0() && equal(signature.toBytes(), sig), 'Invalid signature point')
    const items = groups.flatMap((ranks, index) =>
      ranks.length
        ? [
            {
              publicKey: bls.longSignatures.aggregatePublicKeys(ranks.map((rank) => this.points[rank])),
              message: bls.longSignatures.hash(
                signedPayload(tags[kind][index], slot, block, this.policy.shredVersion),
                DST,
              ),
            },
          ]
        : [],
    )
    const valid =
      items.length === 1
        ? bls.longSignatures.verify(signature, items[0].message, items[0].publicKey)
        : bls.longSignatures.verifyBatch(signature, items)
    requireValue(valid, 'Signature verification failed')
    return {
      kind,
      signers: groups.flat().length,
      signerStake: stake.toString(),
      totalStake: this.total.toString(),
      thresholdPercent: threshold,
    }
  }

  // `expectedSlot` is the request target, never the outer footer slot. The latter can be slot+1.
  verifyFinality(value: unknown, expectedSlot: number, expectedBlockId?: string): FinalityResult {
    try {
      const cert = record(value),
        slot = integer(cert.slot, 'Certificate slot')
      requireValue(slot === integer(expectedSlot, 'Requested slot'), 'Requested slot mismatch')
      this.checkSlot(slot)
      const final = record(cert.final),
        notar = cert.notar === null ? null : record(cert.notar)
      const path = notar ? 'slow' : 'fast'
      const block = notar ? notar.block_id : final.block_id
      requireValue(base64(block, 32).length === 32, 'Missing block ID')
      if (expectedBlockId !== undefined) requireValue(block === expectedBlockId, 'Requested block ID mismatch')
      const aggregates = notar
        ? [this.verifyAggregate('finalize', final, slot), this.verifyAggregate('notarize', notar, slot)]
        : [this.verifyAggregate('fast-finalize', final, slot)]
      return {
        status: this.info.trust === 'operator-pinned' ? 'verified' : 'untrusted-table',
        signatureValid: true,
        table: this.info,
        slot,
        blockId: block as string,
        path,
        aggregates,
      }
    } catch (error) {
      return {
        status: 'invalid',
        signatureValid: false,
        table: this.info,
        reason: error instanceof Error ? error.message : 'Invalid certificate',
      }
    }
  }
}

export function finalityMessage(result: FinalityResult): string {
  if (result.status === 'invalid') return 'Finality certificate could not be verified.'
  if (result.status === 'untrusted-table')
    return 'Signatures match the supplied validator table. The table source is not trusted.'
  return 'Finality signatures and stake checked using an operator-pinned validator table.'
}
