import { base64, integer, record, requireValue } from './codec'
import { EpochTable, epochForSlot, type FinalityResult, type NetworkPolicy, type TablePin } from './verifier'

/** Transport must enforce the byte limit while reading and honor abort signals.
 * Keeping it injected lets native networking or a server relay supply the bytes.
 * No provider credentials or remote trust policy belong in this interface.
 */
export type ReadArtifact = (path: string, options: { maxBytes: number; signal: AbortSignal }) => Promise<Uint8Array>
export type CheckResult = FinalityResult | { status: 'unavailable'; signatureValid: false; reason: string }

export class CertificateClient {
  private readonly tables = new Map<number, EpochTable>()
  private readonly policy: NetworkPolicy
  private readonly pins: readonly TablePin[]

  constructor(
    private readonly read: ReadArtifact,
    policy: NetworkPolicy,
    pins: readonly TablePin[] = [],
  ) {
    this.policy = Object.freeze({ ...policy })
    requireValue(new Set(pins.map((p) => p.epoch)).size === pins.length, 'Duplicate table pin')
    this.pins = Object.freeze(pins.map((pin) => Object.freeze({ ...pin })))
  }

  async check(slot: number, blockId?: string, timeoutMs = 30000, signal?: AbortSignal): Promise<CheckResult> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel = () => {}
    // Promise.race also bounds a transport that fails to honor cancellation.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Certificate request timed out'))
      }, timeoutMs)
      cancel = () => {
        controller.abort()
        reject(new Error('Certificate request cancelled'))
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
    const operation = async (): Promise<CheckResult> => {
      integer(timeoutMs, 'Timeout', 120000)
      requireValue(timeoutMs > 0, 'Timeout')
      requireValue(!controller.signal.aborted, 'Certificate request cancelled')
      const epoch = epochForSlot(slot, this.policy)
      const certBytes = await this.read(`certificates/${slot}.json`, { maxBytes: 8192, signal: controller.signal })
      requireValue(!controller.signal.aborted, 'Request cancelled')
      requireValue(certBytes.length <= 8192, 'Certificate response size')
      requireValue(
        certBytes.every((byte) => byte < 128),
        'Certificate JSON must be ASCII',
      )
      const cert = record(JSON.parse(String.fromCharCode(...certBytes)))
      requireValue(integer(cert.slot, 'Certificate slot') === slot, 'Requested slot mismatch')
      // Validate all base64 before fetching/preparing an expensive validator table.
      const final = record(cert.final)
      base64(final.sig, 96)
      base64(final.bitmap, 403)
      base64(final.block_id, 32)
      let table = this.tables.get(epoch)
      if (!table) {
        const bytes = await this.read(`epochs/${epoch}/table.bin`, { maxBytes: 112032, signal: controller.signal })
        requireValue(!controller.signal.aborted, 'Request cancelled')
        table = await EpochTable.loadAsync(bytes, this.policy, this.pins, controller.signal)
        requireValue(table.info.epoch === epoch, 'Relay returned wrong epoch')
        requireValue(!controller.signal.aborted, 'Request cancelled')
        this.tables.set(epoch, table)
        // Current and previous epoch only; a boundary never reuses the wrong table.
        while (this.tables.size > 2) this.tables.delete(this.tables.keys().next().value!)
      }
      requireValue(!controller.signal.aborted, 'Request cancelled')
      return table.verifyFinality(cert, slot, blockId)
    }
    try {
      return await Promise.race([operation(), deadline])
    } catch (error) {
      return {
        status: 'unavailable',
        signatureValid: false,
        reason: error instanceof Error ? error.message : 'Certificate unavailable',
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
}
