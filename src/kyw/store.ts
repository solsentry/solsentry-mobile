// What the app keeps and shows. One module-level store: the validation loop keeps running when
// the screen is gone (foreground service), so the state cannot live inside a React component.
// History, counters and settings go to AsyncStorage; an RPC key goes to the Android Keystore
// (expo-secure-store) and only when "Save my key" is on.
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'

import { EMPTY, addRecord, parsePersisted, parseSettings, type Persisted } from './history'
import type { LoopStatus } from './loop'
import { PROVIDERS, type ProviderId } from './providers'
import { DEFAULT_SETTINGS, type Settings, type TaskRecord } from './types'

const HISTORY_KEY = 'solsentry-kyw/history/v1'
const SETTINGS_KEY = 'solsentry-kyw/settings/v1'
const secretKey = (id: ProviderId) => `solsentry-kyw.rpc.${id}`

export interface KywState {
  loaded: boolean
  history: Persisted
  settings: Settings
  /** Keys and endpoint URLs typed by the user, per provider. Memory only unless saveKey is on. */
  secrets: Partial<Record<ProviderId, string>>
  running: boolean
  status: LoopStatus
}

let state: KywState = {
  loaded: false,
  history: EMPTY,
  settings: DEFAULT_SETTINGS,
  secrets: {},
  running: false,
  status: { kind: 'idle' },
}

const listeners = new Set<() => void>()

function set(patch: Partial<KywState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function getState(): KywState {
  return state
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let loading: Promise<void> | null = null

/** Load what was stored. Safe to call many times; a failed read leaves the defaults. */
export function load(): Promise<void> {
  loading ??= (async () => {
    let history = EMPTY
    let settings = DEFAULT_SETTINGS
    try {
      history = parsePersisted(await AsyncStorage.getItem(HISTORY_KEY))
      settings = parseSettings(await AsyncStorage.getItem(SETTINGS_KEY))
    } catch {
      // Defaults.
    }
    const secrets: KywState['secrets'] = {}
    if (settings.saveKey) {
      for (const p of PROVIDERS) {
        if (!p.secretLabel) continue
        try {
          const v = await SecureStore.getItemAsync(secretKey(p.id))
          if (v) secrets[p.id] = v
        } catch {
          // A key that cannot be read is treated as not saved; the user pastes it again.
        }
      }
    }
    set({ loaded: true, history, settings, secrets })
  })()
  return loading
}

export async function recordResult(record: TaskRecord): Promise<void> {
  const history = addRecord(state.history, record)
  set({ history })
  try {
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  } catch {
    // Kept in memory; the next result writes again.
  }
}

export async function clearHistory(): Promise<void> {
  set({ history: EMPTY })
  await AsyncStorage.removeItem(HISTORY_KEY).catch(() => {})
}

async function forgetStoredSecrets(): Promise<void> {
  for (const p of PROVIDERS) {
    if (p.secretLabel) await SecureStore.deleteItemAsync(secretKey(p.id)).catch(() => {})
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const settings = { ...state.settings, ...patch }
  const saveKeyChanged = settings.saveKey !== state.settings.saveKey
  set({ settings })
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {})
  if (!saveKeyChanged) return
  if (settings.saveKey) {
    for (const [id, value] of Object.entries(state.secrets)) {
      if (value) await SecureStore.setItemAsync(secretKey(id as ProviderId), value).catch(() => {})
    }
  } else {
    // Off means gone from storage now; the typed value stays in memory until the app closes.
    await forgetStoredSecrets()
  }
}

export async function setSecret(id: ProviderId, value: string): Promise<void> {
  const trimmed = value.trim()
  set({ secrets: { ...state.secrets, [id]: trimmed } })
  if (!state.settings.saveKey) return
  if (trimmed) await SecureStore.setItemAsync(secretKey(id), trimmed).catch(() => {})
  else await SecureStore.deleteItemAsync(secretKey(id)).catch(() => {})
}

export function setRunning(running: boolean): void {
  set({ running })
}

export function setStatus(status: LoopStatus): void {
  set({ status })
}
