import { PublicKey, Transaction, Connection } from '@solana/web3.js'
import { transact, type Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { APP_IDENTITY, MWA_CHAIN, RPC_URL, VERDICT_MAX_AGE_MS } from '../config'
import { buildSolTransferInstructions, type PayExtras } from '../pay/transfer'
import { assertVerdictFresh } from './mwa-math'

export { parseSolToLamports } from './mwa-math'

export interface WalletSession {
  address: string
  authToken: string
  label?: string
}

function decodeAddress(b64: string): PublicKey {
  const bin = globalThis.atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new PublicKey(bytes)
}

async function authorizeIn(wallet: Web3MobileWallet, authToken?: string): Promise<WalletSession> {
  const auth = await wallet.authorize({
    chain: MWA_CHAIN,
    identity: APP_IDENTITY,
    auth_token: authToken,
  })
  const account = auth.accounts[0]
  if (!account) throw new Error('The wallet returned no account.')
  return {
    address: decodeAddress(account.address).toBase58(),
    authToken: auth.auth_token,
    label: account.label,
  }
}

/** Open the wallet app and authorize this app. No signing happens here. */
export async function connectWallet(): Promise<WalletSession> {
  return await transact((wallet) => authorizeIn(wallet))
}

export interface SendResult {
  signature: string
  from: string
}

/**
 * Authorize, build one SystemProgram.transfer from the authorized account, and ask the
 * wallet to sign and send it. The app never sees a private key. `extras` carries the
 * Solana Pay reference keys and memo when the payment came from a scanned request.
 */
export async function sendSol(
  recipient: string,
  lamports: bigint,
  checkedAt: number,
  authToken?: string,
  extras?: PayExtras,
): Promise<SendResult & { session: WalletSession }> {
  const to = new PublicKey(recipient)
  const connection = new Connection(RPC_URL, 'confirmed')
  return transact(async (wallet) => {
    const session = await authorizeIn(wallet, authToken)
    // The user may sit on the wallet prompt for minutes: re-check the verdict age right before building.
    assertVerdictFresh(checkedAt, VERDICT_MAX_AGE_MS)
    const from = new PublicKey(session.address)
    const { blockhash } = await connection.getLatestBlockhash()
    const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
      ...buildSolTransferInstructions(from, to, lamports, extras),
    )
    const [signature] = await wallet.signAndSendTransactions({ transactions: [tx] })
    if (!signature) throw new Error('The wallet returned no signature.')
    return { signature, from: session.address, session }
  })
}
