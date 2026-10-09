// Runtime wiring for the wallet link (account.ts holds the logic and its tests).
import AsyncStorage from '@react-native-async-storage/async-storage'
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { PublicKey } from '@solana/web3.js'

import { SGT_RPC_URL } from '../config'
import { bytesToBase64 } from '../device/attest-logic'
import { utf8 } from '../kyw-core'
import { fetchSgt } from '../seeker/sgt'
import { withAuthorizedWallet } from '../wallet/mwa-session'
import { linkWallet, newLinkMessage, type LinkResult, type LinkedWallet } from './account'
import { getDevice, signMessageWithDevice } from './device-runtime'

const STORAGE_KEY = 'solsentry/account/v1'

export async function loadLinkedWallet(): Promise<LinkedWallet | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const w = JSON.parse(raw) as LinkedWallet
    return typeof w?.address === 'string' && typeof w.walletSig === 'string' ? w : null
  } catch {
    return null
  }
}

export async function forgetLinkedWallet(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {})
}

/** Opens the wallet, signs the link message with it and with the install key, reads the SGT, stores. */
export async function linkWalletNow(): Promise<LinkResult> {
  const device = await getDevice()
  const deps = {
    deviceKeyId: device.id,
    signWithDevice: signMessageWithDevice(device),
    fetchSgt: (a: string) => fetchSgt(a, SGT_RPC_URL),
    randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
    now: Date.now,
  }
  let address = ''
  let message = ''
  const result = await linkWallet(
    deps,
    '',
    async () => {
      const out = await withAuthorizedWallet(transact, undefined, async (wallet, session) => {
        address = session.address
        message = newLinkMessage(deps, address)
        const [signed] = await wallet.signMessages({
          addresses: [bytesToBase64(new PublicKey(address).toBytes())],
          payloads: [utf8(message)],
        })
        return signed
      })
      return out
    },
    '',
    () => ({ address, message }),
  )
  if (result.ok) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(result.wallet)).catch(() => {})
  return result
}
