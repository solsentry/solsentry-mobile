// Runtime wiring for the install identity (device.ts holds the logic and its tests).
import 'react-native-get-random-values'
import AsyncStorage from '@react-native-async-storage/async-storage'

import * as Attestation from '@/modules/device-attestation'
import { fetchWithTimeout } from '../guard/fetch-timeout'
import { KYW_API_BASE } from './config'
import { ensureDevice, signResult, type DeviceIdentity, type DeviceNative } from './device'

const STORAGE_KEY = 'kyw.device.v1'
const native: DeviceNative | null = Attestation.isAvailable() ? Attestation : null

let pending: Promise<DeviceIdentity> | null = null

/** Created once per app process; later calls reuse the same answer. */
export function getDevice(): Promise<DeviceIdentity> {
  if (!pending) {
    pending = ensureDevice({
      fetch: fetchWithTimeout(fetch, 15_000, 'Device check request'),
      apiBase: KYW_API_BASE,
      native,
      load: () => AsyncStorage.getItem(STORAGE_KEY),
      save: (raw) => AsyncStorage.setItem(STORAGE_KEY, raw),
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    })
  }
  return pending
}

export function signWithDevice(identity: DeviceIdentity) {
  return (r: { task_id: string; status: string; fact_digest: string | null; rpc_host: string }) => signResult(native, identity, r)
}
