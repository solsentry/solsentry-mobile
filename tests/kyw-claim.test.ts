import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

import {
  ATA_RENT,
  CLAIM_MEMO_PREFIX,
  SKR_MINT,
  WALLET_RENT_MIN,
  associatedTokenAddress,
  checkClaimTx,
  claimDeviceMessage,
  formatSolUp,
  isExpiredBlockhash,
  parseClaimAnswer,
  solNeeded,
} from '../src/kyw/claim'
import { runClaim, WrongWalletError, type ClaimDeps } from '../src/kyw/claim-flow'
import { formatSkr, parseServerPoints, parseSkr, skrClosed, skrFigure } from '../src/kyw/server-points'

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const MINT = new PublicKey(SKR_MINT)
const user = Keypair.generate()
const delegate = Keypair.generate()
const poolAta = Keypair.generate().publicKey
const WALLET = user.publicKey.toBase58()
const USER_ATA = new PublicKey(associatedTokenAddress(WALLET))

function createAta(owner = user.publicKey, payer = user.publicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(associatedTokenAddress(owner.toBase58())), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  })
}

function transferChecked(amount: bigint, dest = USER_ATA, source = poolAta, authority = delegate.publicKey, decimals = 6) {
  const data = Buffer.alloc(10)
  data[0] = 12
  data.writeBigUInt64LE(amount, 1)
  data[9] = decimals
  return new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  })
}

function tx(instructions: TransactionInstruction[], payer = user.publicKey, legacy = false) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions })
  const t = new VersionedTransaction(legacy ? message.compileToLegacyMessage() : message.compileToV0Message())
  const signers = t.message.staticAccountKeys.slice(0, t.message.header.numRequiredSignatures)
  if (signers.some((k) => k.equals(delegate.publicKey))) t.sign([delegate])
  return t
}

const AMOUNT = 3_550_000n
const CID = 'ab'.repeat(16)
const memo = (id = CID) => new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from(CLAIM_MEMO_PREFIX + id) })
const E = { wallet: WALLET, amountRaw: AMOUNT, claimId: CID }

describe('checkClaimTx', () => {
  it('accepts what the server builds (create-if-missing, transfer, memo), legacy or v0, and prices two signatures', () => {
    for (const legacy of [false, true]) {
      const r = checkClaimTx(tx([createAta(), transferChecked(AMOUNT), memo()], undefined, legacy), E)
      expect(r).toEqual({ ok: true, feeLamports: 10_000n, createsAta: true })
    }
    expect(checkClaimTx(tx([transferChecked(AMOUNT)]), E)).toEqual({ ok: true, feeLamports: 10_000n, createsAta: false })
  })
  it('adds the priority fee the compute budget asks for', () => {
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), transferChecked(AMOUNT)]
    expect(checkClaimTx(tx(ixs), E)).toEqual({ ok: true, feeLamports: 15_000n, createsAta: false })
  })
  it('refuses a priority fee above the cap, with or without a unit limit', () => {
    const at = (units: number | null, microLamports: number) =>
      checkClaimTx(tx([...(units === null ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units })]), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), transferChecked(AMOUNT)]), E)
    // 200k units * 5,000,000 µlamports = exactly the 1,000,000-lamport cap.
    expect(at(200_000, 5_000_000).ok).toBe(true)
    expect(at(200_000, 5_000_001).ok).toBe(false)
    // About 1 SOL of fee through the price alone.
    expect(at(1_400_000, 714_285_715)).toEqual({ ok: false, why: 'priority fee is too high' })
    // No limit instruction: the runtime's 200k units per instruction count.
    expect(at(null, 5_000_001).ok).toBe(false)
  })
  it('refuses another amount, another destination, another payer, the wallet own tokens and anything extra', () => {
    const bad = (t: VersionedTransaction) => checkClaimTx(t, E).ok
    expect(bad(tx([transferChecked(AMOUNT + 1n)]))).toBe(false)
    expect(bad(tx([transferChecked(AMOUNT, poolAta)]))).toBe(false)
    expect(bad(tx([transferChecked(AMOUNT, USER_ATA, poolAta, delegate.publicKey, 9)]))).toBe(false)
    expect(bad(tx([transferChecked(AMOUNT)], delegate.publicKey))).toBe(false)
    expect(bad(tx([transferChecked(AMOUNT, USER_ATA, USER_ATA, user.publicKey)]))).toBe(false)
    expect(bad(tx([createAta(delegate.publicKey), transferChecked(AMOUNT)]))).toBe(false)
    expect(bad(tx([transferChecked(AMOUNT), transferChecked(AMOUNT)]))).toBe(false)
    expect(bad(tx([createAta()]))).toBe(false)
    expect(bad(tx([transferChecked(AMOUNT), memo('other-claim-id-000')]))).toBe(false)
    expect(bad(tx([transferChecked(AMOUNT), memo(), memo()]))).toBe(false)
    expect(bad(tx([transferChecked(AMOUNT), SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: delegate.publicKey, lamports: 1 })]))).toBe(false)
  })
})

describe('claim answers and amounts', () => {
  it('reads an open claim, a closed one and the named refusals (kyw_routes.py _claim_view)', () => {
    const body = { claim_id: 'c1', status: 'open', amount: 3550000, decimals: 6, mint: SKR_MINT, wallet: WALLET, tx: 'AA==', last_valid_block_height: 10 }
    expect(parseClaimAnswer(200, body)).toMatchObject({ kind: 'tx', claimId: 'c1', amountRaw: AMOUNT, transaction: 'AA==', lastValidBlockHeight: 10 })
    expect(parseClaimAnswer(200, { claim_id: 'c1', status: 'confirmed', amount: 5, decimals: 6, signature: 'S' })).toEqual({ kind: 'closed', claimId: 'c1', amountRaw: 5n, status: 'confirmed', signature: 'S' })
    expect(parseClaimAnswer(503, { error: 'pool_empty' })).toMatchObject({ kind: 'error', code: 'pool_empty' })
    expect(parseClaimAnswer(409, { error: 'claim_open', claim_id: 'old' })).toMatchObject({ code: 'claim_open', openClaimId: 'old' })
    expect(parseClaimAnswer(500, null)).toMatchObject({ kind: 'error', code: 'other', detail: 'HTTP 500' })
    expect(parseClaimAnswer(200, { ...body, decimals: 9 })).toMatchObject({ kind: 'error', code: 'other' })
  })
  it('SOL needed: fee, the SKR account rent when missing, and the wallet rent floor; shown rounded up', () => {
    expect(solNeeded({ ataExists: false })).toBe(10_000n + ATA_RENT + WALLET_RENT_MIN)
    expect(solNeeded({ feeLamports: 15_000n, ataExists: true })).toBe(15_000n + WALLET_RENT_MIN)
    expect(formatSolUp(2_049_280n)).toBe('0.0021')
    expect(formatSolUp(solNeeded({ ataExists: false }))).toBe('0.0030')
  })
  it('SKR in base units reads with its decimals', () => {
    expect(formatSkr(AMOUNT)).toBe('3.55')
    expect(formatSkr(1_234_000_000n)).toBe('1,234')
    expect(formatSkr(50_000n)).toBe('0.05')
    expect(skrFigure(100_025_600n)).toEqual({ main: '100.02', tail: '56' })
    expect(skrFigure(1_234_000_000n)).toEqual({ main: '1,234.00', tail: '00' })
    expect(skrFigure(0n)).toEqual({ main: '0.00', tail: '00' })
  })
  it('the points answer carries the SKR block and the link when the server sends them (store.py _skr_view)', () => {
    const base = { points: 71, matched: 71, since: null, today: { counted: 3, cap: 200 } }
    expect(parseServerPoints(base)).toMatchObject({ skr: null, wallet: null })
    const skr = { decimals: 6, balance: 3550000, window: { earned: 6000000, cap: 5000000 }, claim_min: 1000000, pool: 'ok', open_claim: null }
    expect(parseServerPoints({ ...base, skr, wallet: { address: 'Abcd…wxyz', points: 71, link_id: 7 } })).toMatchObject({
      skr: { balanceRaw: AMOUNT, window: { earnedRaw: 6_000_000n, capRaw: 5_000_000n }, minClaimRaw: 1_000_000n, pool: 'ok', openClaim: null },
      wallet: { address: 'Abcd…wxyz', linkId: 7 },
    })
    expect(parseSkr({ ...skr, pool: 'unknown', open_claim: 'c1' })).toMatchObject({ pool: 'unknown', openClaim: 'c1' })
    expect(parseSkr({ ...skr, balance: '3550000' })).toBeNull()
    expect(parseSkr({ ...skr, decimals: 9 })).toBeNull()
    expect(parseSkr({ ...skr, pool: 'full' })).toBeNull()
  })
  it('a window cap of 0 closes SKR for the device (Genesis only in the Seeker phase); the shape still parses', () => {
    const skr = { decimals: 6, balance: 0, window: { earned: 0, cap: 0 }, claim_min: 1000000, pool: 'ok', open_claim: null }
    expect(skrClosed(parseSkr(skr)!)).toBe(true)
    expect(skrClosed(parseSkr({ ...skr, window: { earned: 0, cap: 5000000 } })!)).toBe(false)
  })
  it('expired blockhash is recognised in the wallet and RPC wording', () => {
    expect(isExpiredBlockhash(new Error('Transaction simulation failed: Blockhash not found'))).toBe(true)
    expect(isExpiredBlockhash(new Error('block height exceeded'))).toBe(true)
    expect(isExpiredBlockhash(new Error('User declined'))).toBe(false)
  })
})

describe('runClaim', () => {
  type Over = Partial<ClaimDeps> & { answer?: { status: number; body: unknown }; confirms?: string[] }
  function deps(over: Over = {}) {
    const posted: { path: string; body: Record<string, unknown> }[] = []
    const t = tx([createAta(), transferChecked(AMOUNT), memo('c1')])
    const answer = over.answer ?? {
      status: 200,
      body: { claim_id: 'c1', status: 'open', amount: 3550000, decimals: 6, mint: SKR_MINT, wallet: WALLET, tx: Buffer.from(t.serialize()).toString('base64'), last_valid_block_height: 10 },
    }
    const confirms = [...(over.confirms ?? ['confirmed'])]
    const sent: VersionedTransaction[] = []
    const d: ClaimDeps = {
      deviceKeyId: 'k1:dev',
      wallet: WALLET,
      signWithDevice: async (b64) => `dev(${Buffer.from(b64, 'base64').toString()})`,
      post: async (path, body) => {
        posted.push({ path, body: body as Record<string, unknown> })
        if (path === '/v1/kyw/claim') return answer
        const next = confirms.shift() ?? 'open'
        return next === 'open' ? { status: 202, body: { status: 'open' } } : { status: 200, body: { status: next } }
      },
      getBalance: async () => 10_000_000n,
      accountExists: async () => false,
      signAndSend: async (x) => (sent.push(x), 'SIG1'),
      randomBytes: (n) => new Uint8Array(n).fill(0xab),
      sleep: async () => {},
      ...over,
    }
    return { d, posted, sent }
  }

  it('asks with the device signature, signs the checked transaction once and confirms', async () => {
    const { d, posted, sent } = deps({ confirms: ['open', 'confirmed'] })
    expect(await runClaim(d)).toEqual({ kind: 'paid', signature: 'SIG1', amountRaw: AMOUNT })
    expect(posted[0]).toEqual({ path: '/v1/kyw/claim', body: { device_key_id: 'k1:dev', claim_id: CID, device_sig: `dev(kyw-claim-v0\n${CID})` } })
    expect(claimDeviceMessage(CID)).toBe(`kyw-claim-v0\n${CID}`)
    expect(posted.slice(1).map((p) => p.path)).toEqual(['/v1/kyw/claim/c1/confirm', '/v1/kyw/claim/c1/confirm'])
    expect(posted[1].body).toEqual({ device_key_id: 'k1:dev', signature: 'SIG1' })
    expect(sent).toHaveLength(1)
  })
  it('a wallet short of SOL is told before anything is reserved', async () => {
    const { d, posted } = deps({ getBalance: async () => 2_000_000n })
    expect(await runClaim(d)).toEqual({ kind: 'needs_sol', needLamports: solNeeded({ ataExists: false }) })
    expect(posted).toEqual([])
    // Unknown balance does not block.
    expect((await runClaim(deps({ getBalance: async () => null }).d)).kind).toBe('paid')
  })
  it('pool empty, claim off, no wallet, an already paid id and a transaction for another wallet', async () => {
    expect(await runClaim(deps({ answer: { status: 503, body: { error: 'pool_empty' } } }).d)).toEqual({ kind: 'pool_empty' })
    expect(await runClaim(deps({ answer: { status: 503, body: { error: 'claim_disabled' } } }).d)).toEqual({ kind: 'disabled' })
    expect(await runClaim(deps({ answer: { status: 409, body: { error: 'no_wallet' } } }).d)).toEqual({ kind: 'not_linked' })
    expect(await runClaim(deps({ answer: { status: 200, body: { claim_id: 'c1', status: 'confirmed', amount: 5, decimals: 6, signature: 'S0' } } }).d)).toEqual({ kind: 'paid', signature: 'S0', amountRaw: 5n })
    const { d, sent } = deps({ answer: { status: 200, body: { claim_id: 'c1', status: 'open', amount: 1, decimals: 6, mint: SKR_MINT, wallet: delegate.publicKey.toBase58(), tx: 'AA==', last_valid_block_height: 1 } } })
    expect(await runClaim(d)).toEqual({ kind: 'refused', why: 'the claim pays another wallet' })
    expect(sent).toEqual([])
  })
  it('a transaction with another amount never reaches the wallet', async () => {
    const t = tx([transferChecked(AMOUNT * 10n), memo('c1')])
    const body = { claim_id: 'c1', status: 'open', amount: 3550000, decimals: 6, mint: SKR_MINT, wallet: WALLET, tx: Buffer.from(t.serialize()).toString('base64'), last_valid_block_height: 10 }
    const { d, sent } = deps({ answer: { status: 200, body } })
    expect(await runClaim(d)).toEqual({ kind: 'refused', why: 'amount differs from the claim' })
    expect(sent).toEqual([])
  })
  it('expired blockhash, cancel and the wrong wallet', async () => {
    expect(await runClaim(deps({ signAndSend: async () => Promise.reject(new Error('Blockhash not found')) }).d)).toEqual({ kind: 'expired' })
    expect(await runClaim(deps({ signAndSend: async () => Promise.reject(new Error('User declined')) }).d)).toEqual({ kind: 'cancelled' })
    expect(await runClaim(deps({ signAndSend: async () => Promise.reject(new WrongWalletError()) }).d)).toEqual({ kind: 'wrong_wallet' })
    expect(await runClaim(deps({ confirms: ['released'] }).d)).toEqual({ kind: 'expired' })
  })
  it('an open claim is carried on under its own id; a confirm that never comes leaves it "sent"', async () => {
    let n = 0
    const first = { status: 409, body: { error: 'claim_open', claim_id: 'old' } }
    const base = deps()
    const posted: string[] = []
    const d: ClaimDeps = {
      ...base.d,
      post: async (path, body) => {
        if (path === '/v1/kyw/claim') posted.push((body as { claim_id: string }).claim_id)
        return path === '/v1/kyw/claim' && n++ === 0 ? first : base.d.post(path, body)
      },
    }
    expect((await runClaim(d)).kind).toBe('paid')
    expect(posted).toEqual([CID, 'old'])
    expect(await runClaim(deps({ confirms: [] }).d)).toEqual({ kind: 'sent', signature: 'SIG1', amountRaw: AMOUNT })
  })
})
