// DEBUG BUILDS ONLY. Creates the approval that the Approvals tab is tested against.
// The only caller is behind __DEV__, so the release bundle has no way to reach it.
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { TOKEN_PROGRAMS } from './delegations'

/** TokenInstruction::Approve: tag 4 + amount (u64 LE). Accounts: [token account (writable), delegate, owner (signer)]. */
export function buildTestApproveInstruction(
  tokenAccount: PublicKey,
  delegate: PublicKey,
  owner: PublicKey,
  programId: PublicKey,
  rawAmount: bigint,
): TransactionInstruction {
  if (!TOKEN_PROGRAMS.includes(programId.toBase58())) throw new Error('Not a token program.')
  const data = Buffer.alloc(9)
  data[0] = 4
  data.writeBigUInt64LE(rawAmount, 1)
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  })
}
