// What the app keeps and shows. One module-level store: the validation loop keeps running when
// the screen is gone (foreground service), so the state cannot live inside a React component.
// History, counters and settings go to AsyncStorage; an RPC key goes to the Android Keystore
// (expo-secure-store) and only when "Save my key" is on.
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'

import { EMPTY, addRecord, parsePersisted, parseSettings, type Persisted } from './history'
import type { LoopStatus } from './loop'
import { PROBE_VERSION, type Capability, type ProbeReport } from './probe'
import { PROVIDERS, type ProviderId } from './providers'
import { DEFAULT_SETTINGS, type Settings, type TaskRecord } from './types'

const HISTORY_KEY = 'solsentry-kyw/history/v1'
const SETTINGS_KEY = 'solsentry-kyw/settings/v1'
const PROBE_KEY = 'solsentry-kyw/probe/v1'
const secretKey = (id: ProviderId) => `solsentry-kyw.rpc.${id}`

export type ProbeReports = Partial<Record<ProviderId, ProbeReport>>

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseCapability(value: unknown): Capability | null {
  const c = object(value)
  if (!c || typeof c.class !== 'string' || !['full', 'limited', 'none', 'rate_limited', 'version'].includes(c.class)) return null
  const result: Capability = { class: c.class as Capability['class'] }
  if (c.ms !== undefined) {
    if (!nonnegative(c.ms)) return null
    result.ms = c.ms
  }
  if (c.page_size !== undefined) {
    if (!nonnegative(c.page_size) || !Number.isInteger(c.page_size)) return null
    result.page_size = c.page_size
  }
  if (result.class === 'limited' && result.page_size === undefined) return null
  if (c.reason !== undefined) {
    if (typeof c.reason !== 'string' || !['rpc_error', 'http_error', 'timeout', 'not_available', 'empty_page', 'invalid_response', 'rate_limited', 'version'].includes(c.reason)) return null
    result.reason = c.reason as Capability['reason']
  }
  return result
}

/** Allowlisted fields only: never persist endpoints, credentials or arbitrary response text. */
function parseReport(value: unknown, provider: ProviderId): ProbeReport | null {
  const r = object(value)
  if (!r || r.probe_version !== PROBE_VERSION || typeof r.rpc_host !== 'string') return null
  const hostMatches = provider === 'helius' ? r.rpc_host === 'mainnet.helius-rpc.com'
    : provider === 'solami' ? r.rpc_host === 'rpc.solami.dev'
      : provider === 'quicknode' && /^(?:[a-z0-9-]+\.)*quiknode\.pro$/.test(r.rpc_host)
  if (!hostMatches || typeof r.measured_at !== 'string' || !Number.isFinite(Date.parse(r.measured_at))) return null
  const client = object(r.client)
  if (!client || client.kind !== 'android' || typeof client.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(client.version)) return null
  const c = object(r.capabilities)
  if (!c) return null
  const C1 = parseCapability(c.C1), C2 = parseCapability(c.C2), C3 = parseCapability(c.C3)
  const C4 = parseCapability(c.C4), C5 = parseCapability(c.C5), C6 = object(c.C6)
  if (!C1 || !C2 || !C3 || !C4 || !C5 || !C6) return null
  if (C6.min_interval_ms !== null && !nonnegative(C6.min_interval_ms)) return null
  return {
    probe_version: PROBE_VERSION,
    rpc_host: r.rpc_host,
    measured_at: new Date(r.measured_at).toISOString(),
    capabilities: { C1, C2, C3, C4, C5, C6: { min_interval_ms: C6.min_interval_ms } },
    client: { kind: 'android', version: client.version },
  }
}

export function parseProbeReports(raw: string | null): ProbeReports {
  try {
    const data = object(JSON.parse(raw ?? 'null'))
    const reports: ProbeReports = {}
    for (const { id } of PROVIDERS) {
      const report = parseReport(data?.[id], id)
      if (report) reports[id] = report
    }
    return reports
  } catch {
    return {}
  }
}

export interface KywState {
  loaded: boolean
  history: Persisted
  settings: Settings
  /** Keys and endpoint URLs typed by the user, per provider. Memory only unless saveKey is on. */
  secrets: Partial<Record<ProviderId, string>>
  probeReports: ProbeReports
  running: boolean
  status: LoopStatus
}

let state: KywState = {
  loaded: false,
  history: EMPTY,
  settings: DEFAULT_SETTINGS,
  secrets: {},
  probeReports: {},
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
    let probeReports: ProbeReports = {}
    try {
      history = parsePersisted(await AsyncStorage.getItem(HISTORY_KEY))
      settings = parseSettings(await AsyncStorage.getItem(SETTINGS_KEY))
    } catch {
      // Defaults.
    }
    try {
      probeReports = parseProbeReports(await AsyncStorage.getItem(PROBE_KEY))
    } catch {
      // A failed report read does not affect history or settings.
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
    set({ loaded: true, history, settings, secrets, probeReports })
    // A delete that failed earlier is retried here: with saving off, nothing stays stored.
    if (!settings.saveKey) await syncStoredSecrets()
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

export async function recordProbeReport(provider: ProviderId, report: ProbeReport): Promise<void> {
  await load()
  const safe = parseReport(report, provider)
  if (!safe) return
  const probeReports = { ...state.probeReports, [provider]: safe }
  set({ probeReports })
  await AsyncStorage.setItem(PROBE_KEY, JSON.stringify(probeReports)).catch(() => {})
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

let secretQueue: Promise<void> = Promise.resolve()

/**
 * Bring the Keystore in line with the state as it is when this runs (not when it was queued).
 * Runs one at a time, so a slow "save" can never land after a later "forget".
 */
function syncStoredSecrets(): Promise<void> {
  secretQueue = secretQueue.then(async () => {
    if (!state.settings.saveKey) return forgetStoredSecrets()
    for (const p of PROVIDERS) {
      if (!p.secretLabel) continue
      const value = state.secrets[p.id]
      if (value) await SecureStore.setItemAsync(secretKey(p.id), value).catch(() => {})
      else await SecureStore.deleteItemAsync(secretKey(p.id)).catch(() => {})
    }
  })
  return secretQueue
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const settings = { ...state.settings, ...patch }
  const saveKeyChanged = settings.saveKey !== state.settings.saveKey
  set({ settings })
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {})
  // Off means gone from storage now; the typed value stays in memory until the app closes.
  if (saveKeyChanged) await syncStoredSecrets()
}

export async function setSecret(id: ProviderId, value: string): Promise<void> {
  const trimmed = value.trim()
  const changed = (state.secrets[id] ?? '') !== trimmed
  set({ secrets: { ...state.secrets, [id]: trimmed } })
  if (changed && state.probeReports[id]) {
    // A report describes the endpoint the old key or URL pointed at, not the new one.
    const probeReports = { ...state.probeReports }
    delete probeReports[id]
    set({ probeReports })
    await AsyncStorage.setItem(PROBE_KEY, JSON.stringify(probeReports)).catch(() => {})
  }
  await syncStoredSecrets()
}

export function setRunning(running: boolean): void {
  set({ running })
}

export function setStatus(status: LoopStatus): void {
  set({ status })
}
