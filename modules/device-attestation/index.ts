import { requireOptionalNativeModule } from 'expo'

export interface AttestOptions {
  strongBox: boolean
  includeDeviceIds: boolean
  /** Keep the key under this alias after a successful attestation (KYW install key). */
  keepAlias?: string
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
  hasKey(alias: string): boolean
  publicKey(alias: string): string | null
  sign(alias: string, dataB64: string): Promise<string>
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

export function hasKey(alias: string): boolean {
  return native ? native.hasKey(alias) : false
}

/** SubjectPublicKeyInfo (DER) in base64, or null. */
export function publicKey(alias: string): string | null {
  return native ? native.publicKey(alias) : null
}

/** SHA256withECDSA DER signature (base64) over dataB64's bytes. Throws without the module or the key. */
export async function sign(alias: string, dataB64: string): Promise<string> {
  if (!native) throw new Error('module unavailable')
  return native.sign(alias, dataB64)
}
