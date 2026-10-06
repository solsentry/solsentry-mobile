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
  /** base64 DER certificates, leaf first. Empty on failure (then `error` says why). */
  chain: string[]
  strongBox: boolean
  /** See IdAttestation in src/device/attest-logic.ts. */
  idAttestation: 'included' | 'refused' | 'unsupported' | 'not_requested' | 'error'
  /** Set when no chain was produced: every attempt and its exception chain. */
  error?: string
  /** Set when idAttestation is 'error': the unrecognized exception on the attempt with IDs. */
  idError?: string
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
