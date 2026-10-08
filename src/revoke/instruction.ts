import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { TOKEN_PROGRAMS } from './delegations'

/** TokenInstruction::Revoke: one tag byte, no arguments (same in Token and Token-2022). */
const REVOKE_TAG = 5

/**
 * Revoke the delegate of one token account. Accounts, as the token program reads them:
 * [token account (writable), owner (signer)]. `programId` is the program that owns the
 * token account; anything other than Token or Token-2022 is refused.
 */
export function buildRevokeInstruction(tokenAccount: PublicKey, owner: PublicKey, programId: PublicKey): TransactionInstruction {
  if (!TOKEN_PROGRAMS.includes(programId.toBase58())) throw new Error('Not a token program.')
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([REVOKE_TAG]),
  })
}
