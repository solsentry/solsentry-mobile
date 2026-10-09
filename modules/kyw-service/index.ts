import { requireOptionalNativeModule } from 'expo'

export const TASK_NAME = 'KywValidation'

export interface NativePowerState {
  batteryPct: number | null
  charging: boolean
  chargeUah: number
  online: boolean
  wifi: boolean
  ignoringBatteryOptimizations: boolean
  powerSave: boolean
  screenOn: boolean
}

interface NativeKywService {
  start(text: string, force: boolean): void
  stop(): void
  isRunning(): boolean
  setText(text: string): void
  powerState(): NativePowerState
  requestBatteryExemption(): void
}

// Optional: null on iOS, web or a build without the module. Callers must handle null.
const native = requireOptionalNativeModule<NativeKywService>('KywService')

export function isAvailable(): boolean {
  return native != null
}

/** `force`: start a new JavaScript task even if the service believes one is running. */
export function start(text: string, force = false): void {
  native?.start(text, force)
}

export function stop(): void {
  native?.stop()
}

export function isRunning(): boolean {
  return native?.isRunning() ?? false
}

export function setText(text: string): void {
  native?.setText(text)
}

export function powerState(): NativePowerState | null {
  return native ? native.powerState() : null
}

export function requestBatteryExemption(): void {
  native?.requestBatteryExemption()
}
