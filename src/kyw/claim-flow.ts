// One claim, end to end, with every outside call injected (claim-runtime.ts wires the real ones).
import { VersionedTransaction } from '@solana/web3.js'

import { base64ToBytes, bytesToBase64 } from '../device/attest-logic'
import { utf8 } from '../kyw-core'
import {
  associatedTokenAddress,
  checkClaimTx,
  claimDeviceMessage,
  isExpiredBlockhash,
  newClaimId,
  parseClaimAnswer,
  parseConfirm,
  solNeeded,
  type ClaimAnswer,
} from './claim'

export interface ClaimDeps {
  deviceKeyId: string
  /** The linked wallet, full address. */
  wallet: string
  signWithDevice: (messageB64: string) => Promise<string | null>
  post: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>
  /** Lamports, or null when the read failed (unknown, not zero). */
  getBalance: (address: string) => Promise<bigint | null>
  /** Null when the read failed. */
  accountExists: (address: string) => Promise<boolean | null>
  /** Opens the wallet, checks it is `wallet`, signs as fee payer and sends; returns the signature. */
  signAndSend: (tx: VersionedTransaction) => Promise<string>
  randomBytes: (n: number) => Uint8Array
  sleep: (ms: number) => Promise<void>
}

export type ClaimOutcome =
  | { kind: 'paid'; signature: string; amountRaw: bigint }
  /** Sent; SolSentry had not confirmed it yet when the phone stopped asking. */
  | { kind: 'sent'; signature: string; amountRaw: bigint }
  | { kind: 'needs_sol'; needLamports: bigint }
  | { kind: 'pool_empty' }
  | { kind: 'disabled' }
  | { kind: 'below_minimum' }
  | { kind: 'not_linked' }
  | { kind: 'expired' }
  /** `amountRaw` stays held for the claim until it is finished or expires. */
  | { kind: 'cancelled'; claimId: string; amountRaw: bigint }
  | { kind: 'wrong_wallet' }
  | { kind: 'refused'; why: string }
  | { kind: 'error'; detail: string }

export class WrongWalletError extends Error {
  constructor() {
    super('The wallet that opened is not the linked one.')
  }
}

const CONFIRM_EVERY_MS = 2_000
const CONFIRM_TRIES = 30

const isCancel = (e: unknown) => /cancel|declin|reject|denied/i.test(e instanceof Error ? e.message : String(e))

async function ask(deps: ClaimDeps, claimId: string): Promise<ClaimAnswer | { kind: 'no_key' } | { kind: 'open'; claimId: string }> {
  const sig = await deps.signWithDevice(bytesToBase64(utf8(claimDeviceMessage(claimId)))).catch(() => null)
  if (!sig) return { kind: 'no_key' }
  const r = await deps.post('/v1/kyw/claim', { device_key_id: deps.deviceKeyId, claim_id: claimId, device_sig: sig })
  const answer = parseClaimAnswer(r.status, r.body)
  if (answer.kind === 'error' && answer.openClaimId && answer.openClaimId !== claimId) return { kind: 'open', claimId: answer.openClaimId }
  return answer
}

export async function runClaim(deps: ClaimDeps): Promise<ClaimOutcome> {
  const ata = associatedTokenAddress(deps.wallet)
  const [have, ataExists] = await Promise.all([
    deps.getBalance(deps.wallet).catch(() => null),
    deps.accountExists(ata).catch(() => null),
  ])
  // Unknown reads do not block: the wallet itself refuses a payment it cannot cover.
  if (have !== null && ataExists !== null && have < solNeeded({ ataExists })) {
    return { kind: 'needs_sol', needLamports: solNeeded({ ataExists }) }
  }

  let answer: Awaited<ReturnType<typeof ask>>
  try {
    answer = await ask(deps, newClaimId(deps.randomBytes))
    // One claim stays open per phone and wallet: carry on with that one (same id = same answer).
    if (answer.kind === 'open') answer = await ask(deps, answer.claimId)
  } catch (e) {
    return { kind: 'error', detail: String(e).slice(0, 200) }
  }
  if (answer.kind === 'no_key') return { kind: 'error', detail: 'This phone has no hardware key to sign the claim.' }
  if (answer.kind === 'open') return { kind: 'error', detail: 'claim_open' }
  if (answer.kind === 'closed') {
    return answer.status === 'confirmed' && answer.signature
      ? { kind: 'paid', signature: answer.signature, amountRaw: answer.amountRaw }
      : { kind: 'expired' }
  }
  if (answer.kind === 'error') {
    const map = { pool_empty: 'pool_empty', claim_disabled: 'disabled', below_minimum: 'below_minimum', no_wallet: 'not_linked' } as const
    const kind = map[answer.code as keyof typeof map]
    return kind ? { kind } : { kind: 'error', detail: answer.detail }
  }

  if (answer.wallet !== deps.wallet) return { kind: 'refused', why: 'the claim pays another wallet' }
  let tx: VersionedTransaction
  try {
    tx = VersionedTransaction.deserialize(base64ToBytes(answer.transaction))
  } catch {
    return { kind: 'refused', why: 'unreadable transaction' }
  }
  const check = checkClaimTx(tx, { wallet: deps.wallet, amountRaw: answer.amountRaw, claimId: answer.claimId })
  if (!check.ok) return { kind: 'refused', why: check.why }
  const need = solNeeded({ feeLamports: check.feeLamports, ataExists: ataExists ?? !check.createsAta })
  if (have !== null && have < need) return { kind: 'needs_sol', needLamports: need }

  let signature: string
  try {
    signature = await deps.signAndSend(tx)
  } catch (e) {
    if (e instanceof WrongWalletError) return { kind: 'wrong_wallet' }
    if (isExpiredBlockhash(e)) return { kind: 'expired' }
    if (isCancel(e)) return { kind: 'cancelled', claimId: answer.claimId, amountRaw: answer.amountRaw }
    return { kind: 'error', detail: String(e).slice(0, 200) }
  }

  for (let i = 0; i < CONFIRM_TRIES; i++) {
    let status = null
    try {
      const r = await deps.post(`/v1/kyw/claim/${encodeURIComponent(answer.claimId)}/confirm`, {
        device_key_id: deps.deviceKeyId,
        signature,
      })
      status = parseConfirm(r.status, r.body)
    } catch {
      status = null
    }
    if (status === 'confirmed') return { kind: 'paid', signature, amountRaw: answer.amountRaw }
    // Released = the transaction did not land before its blockhash ran out; the SKR is back in the balance.
    if (status === 'released') return { kind: 'expired' }
    if (status === 'rejected') return { kind: 'error', detail: 'SolSentry did not accept this transaction.' }
    await deps.sleep(CONFIRM_EVERY_MS)
  }
  return { kind: 'sent', signature, amountRaw: answer.amountRaw }
}
