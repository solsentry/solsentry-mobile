import { PublicKey, Transaction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type Delegation } from '../src/revoke/delegations'
import { buildRevokeInstruction } from '../src/revoke/instruction'
import { CONFIRM_ATTEMPTS, WRONG_WALLET, revokeDelegation, type RevokeDeps } from '../src/revoke/revoke'
import type { Transact } from '../src/wallet/mwa-session'

const OWNER = new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T')
const OTHER = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const ACCOUNT = new PublicKey('EPjFWdd5AufqSSeqeaGzuZwTDt1v1BbdkYbFvEA7C1Wv')
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'

describe('buildRevokeInstruction', () => {
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    it(`data [5], accounts [token account (writable), owner (signer)], program ${program.slice(0, 6)}`, () => {
      const ix = buildRevokeInstruction(ACCOUNT, OWNER, new PublicKey(program))
      expect([...ix.data]).toEqual([5])
      expect(ix.programId.toBase58()).toBe(program)
      expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
        [ACCOUNT.toBase58(), false, true],
        [OWNER.toBase58(), true, false],
      ])
    })
  }

  it('refuses any program that is not Token or Token-2022', () => {
    expect(() => buildRevokeInstruction(ACCOUNT, OWNER, new PublicKey('11111111111111111111111111111111'))).toThrow('Not a token program')
    expect(() => buildRevokeInstruction(ACCOUNT, OWNER, OTHER)).toThrow('Not a token program')
  })
})

const row = (programId = TOKEN_PROGRAM): Delegation => ({
  account: ACCOUNT.toBase58(),
  mint: 'So11111111111111111111111111111111111111112',
  programId,
  delegate: OTHER.toBase58(),
  delegatedRaw: 1n,
  delegatedUi: '1',
  kind: 'AMOUNT',
  frozen: false,
})

function b64(k: PublicKey): string {
  return Buffer.from(k.toBytes()).toString('base64')
}

interface Wallet {
  account?: PublicKey
  /** Result of signAndSendTransactions, or an error to throw. */
  sign?: () => Promise<string[]>
  authorize?: () => never
}

function setup(w: Wallet, delegateReads: (boolean | Error)[]) {
  const signed: Transaction[] = []
  const reads: string[] = []
  const transact: Transact = async (cb) =>
    await cb({
      authorize: async () => {
        w.authorize?.()
        return { accounts: [{ address: b64(w.account ?? OWNER), label: 'w' }], auth_token: 'tok' }
      },
      signAndSendTransactions: async ({ transactions }: { transactions: Transaction[] }) => {
        signed.push(...transactions)
        return await (w.sign ?? (async () => ['sig1']))()
      },
    } as never)
  const deps: RevokeDeps = {
    transact,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH }),
    hasActiveDelegate: async (account) => {
      reads.push(account)
      const r = delegateReads.length > 1 ? delegateReads.shift() : delegateReads[0]
      if (r instanceof Error) throw r
      return r as boolean
    },
    sleep: async () => {},
  }
  return { deps, signed, reads }
}

describe('revokeDelegation', () => {
  it('one transaction, one Revoke, owner as fee payer; "revoked" only after the re-read shows no delegate', async () => {
    const { deps, signed, reads } = setup({}, [true, true, false])
    const r = await revokeDelegation(deps, row(TOKEN_2022_PROGRAM), OWNER.toBase58())
    expect(r).toMatchObject({ status: 'revoked', signature: 'sig1' })
    expect(reads).toEqual([ACCOUNT.toBase58(), ACCOUNT.toBase58(), ACCOUNT.toBase58()])
    expect(signed).toHaveLength(1)
    const tx = signed[0]
    expect(tx.feePayer?.toBase58()).toBe(OWNER.toBase58())
    expect(tx.recentBlockhash).toBe(BLOCKHASH)
    expect(tx.instructions).toHaveLength(1)
    expect(tx.instructions[0].programId.toBase58()).toBe(TOKEN_2022_PROGRAM)
    expect([...tx.instructions[0].data]).toEqual([5])
    // The compiled message needs the owner's signature only.
    expect(tx.compileMessage().header.numRequiredSignatures).toBe(1)
  })

  it('a signature with the delegate still there is NOT a success', async () => {
    const { deps, reads } = setup({}, [true])
    const r = await revokeDelegation(deps, row(), OWNER.toBase58())
    expect(r).toMatchObject({ status: 'unconfirmed', signature: 'sig1' })
    expect(reads).toHaveLength(CONFIRM_ATTEMPTS)
  })

  it('a signature with a re-read that keeps failing is NOT a success and carries the reason', async () => {
    const { deps } = setup({}, [new Error('RPC HTTP 429')])
    const r = await revokeDelegation(deps, row(), OWNER.toBase58())
    expect(r).toMatchObject({ status: 'unconfirmed', detail: 'RPC HTTP 429' })
  })

  it('a decline in the wallet is "cancelled" and nothing is read as revoked', async () => {
    const declined = Object.assign(new Error('declined'), { code: 'JSON_RPC_ERROR', userInfo: { jsonRpcErrorCode: -3 } })
    const { deps, reads } = setup({ sign: async () => { throw declined } }, [false])
    const r = await revokeDelegation(deps, row(), OWNER.toBase58())
    expect(r.status).toBe('cancelled')
    expect(reads).toHaveLength(0)
  })

  it('a wallet timeout after the request was sent is settled by the chain, both ways', async () => {
    const timeout = () => { throw new Error('TimeoutException: Timed out waiting for response with id=2') }
    const gone = setup({ sign: async () => timeout() }, [false])
    expect(await revokeDelegation(gone.deps, row(), OWNER.toBase58())).toMatchObject({ status: 'revoked', signature: undefined })
    const still = setup({ sign: async () => timeout() }, [true])
    expect((await revokeDelegation(still.deps, row(), OWNER.toBase58())).status).toBe('unconfirmed')
  })

  it('another authorized account is refused before anything is signed', async () => {
    const { deps, signed, reads } = setup({ account: OTHER }, [false])
    await expect(revokeDelegation(deps, row(), OWNER.toBase58())).rejects.toThrow(WRONG_WALLET)
    expect(signed).toHaveLength(0)
    expect(reads).toHaveLength(0)
  })

  it('an error before the wallet is asked to sign is thrown as it is', async () => {
    const { deps, signed } = setup({}, [false])
    deps.getLatestBlockhash = async () => { throw new Error('failed to get recent blockhash') }
    await expect(revokeDelegation(deps, row(), OWNER.toBase58())).rejects.toThrow('blockhash')
    expect(signed).toHaveLength(0)
  })
})
