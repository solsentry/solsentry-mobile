import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = { running: false, starts: 0, stops: 0 }
vi.mock('@/modules/kyw-service', () => ({
  TASK_NAME: 'KywValidation',
  isAvailable: () => true,
  start: () => {
    native.starts++
    native.running = true
  },
  stop: () => {
    native.stops++
    native.running = false
  },
  isRunning: () => native.running,
  setText: () => {},
  powerState: () => null,
}))
vi.mock('../src/kyw/device-runtime', () => ({
  getDevice: async () => ({ id: 'r1:' + '0'.repeat(32), kind: 'random', check: 'unavailable', headline: null }),
  signWithDevice: () => async () => null,
}))
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.0' } } }))
vi.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: async () => {}, deactivateKeepAwake: async () => {} }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}))
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }))

beforeEach(() => {
  native.running = false
  native.starts = 0
  native.stops = 0
  vi.resetModules()
})

describe('validation engine', () => {
  it('switching off before the service task enters JavaScript runs nothing and ends the service', async () => {
    const engine = await import('../src/kyw/engine')
    const store = await import('../src/kyw/store')
    await engine.startValidation()
    expect(native.starts).toBe(1)
    engine.stopValidation()
    // The service's task arrives late, after the user switched off.
    await engine.validationTask()
    expect(store.getState().running).toBe(false)
    expect(native.running).toBe(false)
  })
})
