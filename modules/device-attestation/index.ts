import { requireOptionalNativeModule } from 'expo'

export interface AttestOptions {
  strongBox: boolean
  includeDeviceIds: boolean
}

/** What Build.* says about the phone. Self-reported: anything can write these. */
export interface ClaimedDevice {
  manufacturer: string
  brand: string
  model: string
  sdkInt: number
}

export interface AttestResult {
  /** base64 DER certificates, leaf first. Empty on failure. */
  chain: string[]
  strongBox: boolean
  idAttestation: 'included' | 'refused' | 'unsupported'
  error?: string
  claimed?: ClaimedDevice
}

interface NativeDeviceAttestation {
  attestKey(challengeB64: string, opts: AttestOptions): Promise<AttestResult>
}

// Optional: null on iOS, web, Expo Go or a build without the module. Callers must handle null.
const native = requireOptionalNativeModule<NativeDeviceAttestation>('DeviceAttestation')

export function isAvailable(): boolean {
  return native != null
}

export async function attestKey(challengeB64: string, opts: AttestOptions): Promise<AttestResult> {
  if (!native) return { chain: [], strongBox: false, idAttestation: 'unsupported', error: 'module unavailable' }
  return native.attestKey(challengeB64, opts)
}
