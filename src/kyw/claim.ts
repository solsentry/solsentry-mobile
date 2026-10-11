// SKR claim, phone side (contract: solsentry internal/docs/runners/CONTRATO_APP_para_DEV_EXEC_skr_claim_2026-10-10.md).
// The server owns the balance and builds the transaction, signed only by the pool's delegate key; the
// wallet pays the fee and sends. Before the wallet opens, the phone reads the transaction and refuses
// anything but "create my SKR account if missing + move this amount of SKR to it".
import { PublicKey, VersionedTransaction } from '@solana/web3.js'

import { rawAmount } from './server-points'

export const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
export const SKR_DECIMALS = 6
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
/** The server's memo names the claim, so a payment the phone never reported is still found on chain. */
export const CLAIM_MEMO_PREFIX = 'solsentry-kyw-claim:'

/** Rent of a token account (165 bytes) and of a plain wallet (0 bytes), in lamports. */
export const ATA_RENT = 2_039_280n
export const WALLET_RENT_MIN = 890_880n
export const SIGNATURE_FEE = 5_000n

/** What the install key signs to open a claim (integrations/kyw/device.py claim_message). */
export function claimDeviceMessage(claimId: string): string {
  return ['kyw-claim-v0', claimId].join('\n')
}

export function newClaimId(randomBytes: (n: number) => Uint8Array): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function associatedTokenAddress(owner: string, mint: string = SKR_MINT): string {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBytes(), new PublicKey(TOKEN_PROGRAM).toBytes(), new PublicKey(mint).toBytes()],
    new PublicKey(ATA_PROGRAM),
  )
  return ata.toBase58()
}

export type ClaimErrorCode =
  | 'pool_empty'
  | 'claim_disabled'
  | 'below_minimum'
  | 'no_wallet'
  | 'claim_open'
  | 'claim_id_taken'
  | 'bad_device_signature'
  | 'rpc_unavailable'

export type ClaimAnswer =
  | { kind: 'tx'; claimId: string; amountRaw: bigint; wallet: string; mint: string; transaction: string; lastValidBlockHeight: number }
  /** The same id asked again after it closed: paid (with its signature) or released. */
  | { kind: 'closed'; claimId: string; amountRaw: bigint; status: 'confirmed' | 'released'; signature: string | null }
  | { kind: 'error'; code: ClaimErrorCode | 'other'; detail: string; openClaimId?: string }

const KNOWN: ClaimErrorCode[] = ['pool_empty', 'claim_disabled', 'below_minimum', 'no_wallet', 'claim_open', 'claim_id_taken', 'bad_device_signature', 'rpc_unavailable']

/** POST /v1/kyw/claim answer (integrations/mcp/kyw_routes.py _claim_view). */
export function parseClaimAnswer(status: number, body: unknown): ClaimAnswer {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (status !== 200) {
    const code = KNOWN.find((c) => c === b.error)
    return {
      kind: 'error',
      code: code ?? 'other',
      detail: typeof b.error === 'string' ? `${status} ${b.error}` : `HTTP ${status}`,
      ...(code === 'claim_open' && typeof b.claim_id === 'string' ? { openClaimId: b.claim_id } : {}),
    }
  }
  const amountRaw = rawAmount(b.amount)
  if (typeof b.claim_id !== 'string' || amountRaw === null || b.decimals !== SKR_DECIMALS) return { kind: 'error', code: 'other', detail: 'bad claim answer' }
  if (b.status === 'confirmed' || b.status === 'released') {
    return { kind: 'closed', claimId: b.claim_id, amountRaw, status: b.status, signature: typeof b.signature === 'string' ? b.signature : null }
  }
  if (
    b.status !== 'open' ||
    typeof b.tx !== 'string' ||
    typeof b.wallet !== 'string' ||
    typeof b.mint !== 'string' ||
    typeof b.last_valid_block_height !== 'number'
  ) {
    return { kind: 'error', code: 'other', detail: 'bad claim answer' }
  }
  return {
    kind: 'tx',
    claimId: b.claim_id,
    amountRaw,
    wallet: b.wallet,
    mint: b.mint,
    transaction: b.tx,
    lastValidBlockHeight: b.last_valid_block_height,
  }
}

export type TxCheck = { ok: true; feeLamports: bigint; createsAta: boolean } | { ok: false; why: string }

const u64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true)
const u32 = (d: Uint8Array, at: number) => BigInt(new DataView(d.buffer, d.byteOffset + at, 4).getUint32(0, true))

/**
 * Reads the claim transaction the server sent. Accepted, in any order: compute budget settings, at
 * most one "create the SKR account of this wallet if missing", exactly one SKR transferChecked of
 * `amountRaw` into that account, at most one memo naming this claim (no accounts). Fee payer = the
 * linked wallet, no lookup tables, nothing else.
 */
export function checkClaimTx(tx: VersionedTransaction, expect: { wallet: string; amountRaw: bigint; claimId: string; mint?: string }): TxCheck {
  const mint = expect.mint ?? SKR_MINT
  const msg = tx.message
  if (msg.addressTableLookups.length > 0) return { ok: false, why: 'lookup tables' }
  const keys = msg.staticAccountKeys.map((k) => k.toBase58())
  if (keys[0] !== expect.wallet) return { ok: false, why: 'fee payer is not the linked wallet' }
  const ata = associatedTokenAddress(expect.wallet, mint)
  let limit: bigint | null = null
  let price = 0n
  let creates = 0
  let transfers = 0
  let others = 0
  let memos = 0
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex]
    const acc = ix.accountKeyIndexes.map((i) => keys[i])
    const d = ix.data
    if (program === COMPUTE_BUDGET) {
      if (d[0] === 2 && d.length === 5) limit = u32(d, 1)
      else if (d[0] === 3 && d.length === 9) price = u64(d, 1)
      else return { ok: false, why: 'unknown compute budget instruction' }
      continue
    }
    others++
    if (program === ATA_PROGRAM) {
      const expected = [expect.wallet, ata, expect.wallet, mint, SYSTEM_PROGRAM, TOKEN_PROGRAM]
      if (d.length !== 1 || d[0] !== 1 || acc.length !== 6 || acc.some((a, i) => a !== expected[i])) {
        return { ok: false, why: 'account creation is not for this wallet' }
      }
      creates++
      continue
    }
    if (program === TOKEN_PROGRAM) {
      if (d.length !== 10 || d[0] !== 12 || acc.length < 4) return { ok: false, why: 'token instruction is not a transfer' }
      const [source, m, dest, authority] = acc
      if (m !== mint || dest !== ata) return { ok: false, why: 'transfer is not SKR to this wallet' }
      if (source === ata || authority === expect.wallet) return { ok: false, why: 'transfer moves this wallet’s own tokens' }
      if (d[9] !== SKR_DECIMALS || u64(d, 1) !== expect.amountRaw) return { ok: false, why: 'amount differs from the claim' }
      transfers++
      continue
    }
    if (program === MEMO_PROGRAM) {
      if (acc.length !== 0 || new TextDecoder().decode(d) !== CLAIM_MEMO_PREFIX + expect.claimId) return { ok: false, why: 'memo does not name this claim' }
      memos++
      continue
    }
    return { ok: false, why: `unexpected program ${program.slice(0, 8)}` }
  }
  if (transfers !== 1 || creates > 1 || memos > 1) return { ok: false, why: 'not one transfer' }
  // Without a limit instruction the runtime gives each instruction 200k units.
  const units = limit ?? BigInt(Math.min(1_400_000, 200_000 * others))
  const priority = (units * price + 999_999n) / 1_000_000n
  return { ok: true, feeLamports: SIGNATURE_FEE * BigInt(msg.header.numRequiredSignatures) + priority, createsAta: creates === 1 }
}

/**
 * Lamports the wallet must hold: what the claim spends (fee, plus the SKR account rent when it does
 * not exist yet) and the wallet's own rent minimum, which a payment may not cross unless it empties
 * the wallet. Before the transaction is known, the fee is two signatures.
 */
export function solNeeded(p: { feeLamports?: bigint; ataExists: boolean }): bigint {
  return (p.feeLamports ?? 2n * SIGNATURE_FEE) + (p.ataExists ? 0n : ATA_RENT) + WALLET_RENT_MIN
}

/** "0.0030" style, rounded up so the hint is never short. */
export function formatSolUp(lamports: bigint): string {
  const tenThousandths = (lamports + 99_999n) / 100_000n
  return `${tenThousandths / 10_000n}.${(tenThousandths % 10_000n).toString().padStart(4, '0')}`
}

export type ConfirmStatus = 'confirmed' | 'pending' | 'released' | 'rejected'

/** POST /v1/kyw/claim/{id}/confirm: 202 = still open, 200 = closed, 400 tx_mismatch = not this claim's transaction. */
export function parseConfirm(status: number, body: unknown): ConfirmStatus | null {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (status === 202) return 'pending'
  if (status === 400 && b.error === 'tx_mismatch') return 'rejected'
  if (status !== 200) return null
  return b.status === 'confirmed' || b.status === 'released' ? b.status : null
}

/** The wallet or RPC said the transaction's blockhash is no longer valid: a new claim is needed. */
export function isExpiredBlockhash(e: unknown): boolean {
  return /blockhash not found|block ?height exceeded|blockhash.*expired|expired.*blockhash/i.test(e instanceof Error ? e.message : String(e))
}
