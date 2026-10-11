// Runtime wiring for the wallet link (account.ts holds the logic and its tests).
import AsyncStorage from '@react-native-async-storage/async-storage'
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { PublicKey } from '@solana/web3.js'

import { SGT_RPC_URL } from '../config'
import { bytesToBase64 } from '../device/attest-logic'
import { fetchWithTimeout } from '../guard/fetch-timeout'
import { utf8 } from '../kyw-core'
import { fetchSgt } from '../seeker/sgt'
import { withAuthorizedWallet } from '../wallet/mwa-session'
import { linkWallet, parseStoredWallet, unlinkWallet, type LinkResult, type LinkedWallet } from './account'
import { KYW_API_BASE } from './config'
import { getDevice, signMessageWithDevice } from './device-runtime'

const STORAGE_KEY = 'solsentry/account/v1'

export async function loadLinkedWallet(): Promise<LinkedWallet | null> {
  try {
    const w = parseStoredWallet(await AsyncStorage.getItem(STORAGE_KEY))
    // A link from before the server route cannot be used: it goes, and the screen asks to link again.
    if (!w) await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {})
    return w
  } catch {
    return null
  }
}

export async function forgetLinkedWallet(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {})
}

/** Opens the wallet, signs SolSentry's link message with it and with the install key, stores what the server accepted. */
export async function linkWalletNow(): Promise<LinkResult> {
  const device = await getDevice()
  const deps = {
    deviceKeyId: device.id,
    signWithDevice: signMessageWithDevice(device),
    fetchSgt: (a: string) => fetchSgt(a, SGT_RPC_URL),
    fetch: fetchWithTimeout(fetch, 15_000, 'Request'),
    apiBase: KYW_API_BASE,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now: Date.now,
  }
  const result = await linkWallet(deps, (messageFor) =>
    withAuthorizedWallet(transact, undefined, async (wallet, session) => {
      const message = await messageFor(session.address)
      const [signed] = await wallet.signMessages({
        addresses: [bytesToBase64(new PublicKey(session.address).toBytes())],
        payloads: [utf8(message)],
      })
      return { address: session.address, message, signed }
    }),
  )
  if (result.ok) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(result.wallet)).catch(() => {})
  return result
}

/** Closes the link on SolSentry, then here. False (and kept) when the server could not be told. */
export async function unlinkWalletNow(wallet: LinkedWallet): Promise<boolean> {
  const device = await getDevice()
  const ok = await unlinkWallet(
    { fetch: fetchWithTimeout(fetch, 15_000, 'Request'), apiBase: KYW_API_BASE, signWithDevice: signMessageWithDevice(device) },
    wallet,
  )
  if (ok) await forgetLinkedWallet()
  return ok
}
