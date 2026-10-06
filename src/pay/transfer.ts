import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

/** SPL Memo program (v3), executable on mainnet; the address most indexers and merchants match. */
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

export interface PayExtras {
  /** Solana Pay reference keys: read-only, non-signer keys on the transfer instruction. */
  references?: string[]
  /** Solana Pay memo: an SPL Memo instruction immediately before the transfer. */
  memo?: string | null
}

/**
 * The instructions for one SOL payment, in the order the Solana Pay spec requires:
 * [memo?, transfer(+references)]. Without the references a merchant cannot find the payment.
 */
export function buildSolTransferInstructions(
  from: PublicKey,
  to: PublicKey,
  lamports: bigint,
  extras: PayExtras = {},
): TransactionInstruction[] {
  const out: TransactionInstruction[] = []
  if (extras.memo) {
    out.push(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [{ pubkey: from, isSigner: true, isWritable: false }],
        data: Buffer.from(extras.memo, 'utf8'),
      }),
    )
  }
  const transfer = SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })
  for (const r of extras.references ?? []) {
    transfer.keys.push({ pubkey: new PublicKey(r), isSigner: false, isWritable: false })
  }
  out.push(transfer)
  return out
}
