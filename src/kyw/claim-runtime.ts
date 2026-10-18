// Runtime wiring for a claim (claim-flow.ts holds the flow and its tests).
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { Connection, PublicKey } from '@solana/web3.js'

import { RPC_URL } from '../config'
import { fetchWithTimeout } from '../net/fetch-timeout'
import { withAuthorizedWallet } from '../wallet/mwa-session'
import type { LinkedWallet } from './account'
import { runClaim, WrongWalletError, type ClaimOutcome } from './claim-flow'
import { KYW_API_BASE } from './config'
import { getDevice, signMessageWithDevice } from './device-runtime'

export async function claimNow(wallet: LinkedWallet): Promise<ClaimOutcome> {
  const device = await getDevice()
  const http = fetchWithTimeout(fetch, 20_000, 'Request')
  // A hung balance or account read must end, or the claim sheet stays on "claiming".
  const connection = new Connection(RPC_URL, { commitment: 'confirmed', fetch: fetchWithTimeout(fetch) })
  return runClaim({
    deviceKeyId: device.id,
    wallet: wallet.address,
    signWithDevice: signMessageWithDevice(device),
    post: async (path, body) => {
      const res = await http(`${KYW_API_BASE}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    },
    getBalance: (a) => connection.getBalance(new PublicKey(a)).then(BigInt, () => null),
    accountExists: (a) => connection.getAccountInfo(new PublicKey(a)).then((x) => x !== null, () => null),
    signAndSend: (tx) =>
      withAuthorizedWallet(transact, undefined, async (w, session) => {
        if (session.address !== wallet.address) throw new WrongWalletError()
        const [signature] = await w.signAndSendTransactions({ transactions: [tx] })
        if (!signature) throw new Error('The wallet returned no signature.')
        return signature
      }),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })
}
