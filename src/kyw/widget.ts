// What the home screen widget shows, from the same state the home screen reads. Pure; widget-runtime.ts
// sends it to the native widget.
import type { WidgetContent } from '@/modules/kyw-service'

import { ACCOUNT_TEXT, HOME_TEXT } from './copy'
import type { Persisted } from './history'
import type { LoopStatus } from './loop'
import { formatPoints } from './points'
import { formatServerPoints, formatSkr, headlinePoints, heldSkr, skrClosed, skrFigure, type ServerPoints } from './server-points'

export interface WidgetInput {
  loaded: boolean
  running: boolean
  status: LoopStatus
  history: Persisted
  /** Last balance read from SolSentry in this process, or null. */
  server: ServerPoints | null
  /** Null while the device identity is not read yet. */
  deviceKind: 'key' | 'random' | null
  now: number
}

export const WIDGET_OFF = 'Verification is off'

function state(running: boolean, status: LoopStatus): Pick<WidgetContent, 'state' | 'status'> {
  if (!running || status.kind === 'idle') return { state: 'off', status: WIDGET_OFF }
  switch (status.kind) {
    case 'held':
      if (status.why === 'wifi') return { state: 'paused', status: 'Paused · waiting for Wi-Fi' }
      if (status.why === 'charging') return { state: 'paused', status: 'Paused · waiting for the charger' }
      return { state: 'paused', status: 'Paused' }
    case 'stopping':
      return { state: 'off', status: 'Stopping' }
    case 'waiting':
      if (status.why === 'capped') return { state: 'on', status: "Today's cap is reached" }
      return { state: 'on', status: 'Verifying' }
    default:
      return { state: 'on', status: 'Verifying' }
  }
}

/** Null before the store is loaded. Balance lines stay null (kept) for a key device until SolSentry answers. */
export function widgetContent(input: WidgetInput): WidgetContent | null {
  if (!input.loaded) return null
  const head = state(input.running, input.status)
  const { server, history } = input
  if (server) {
    // As on the home screen: a closed SKR window (cap 0) shows points instead.
    const skr = server.skr && !skrClosed(server.skr) ? server.skr : null
    return {
      ...head,
      figure: skr ? skrFigure(skr.balanceRaw + (heldSkr(skr, null) ?? 0n)).main : formatServerPoints(headlinePoints(server)),
      unit: skr ? ACCOUNT_TEXT.skrUnit : HOME_TEXT.pointsUnit,
      today: skr
        ? ACCOUNT_TEXT.skrWindow(formatSkr(skr.window.earnedRaw), formatSkr(skr.window.capRaw))
        : server.today.cap !== null
          ? ACCOUNT_TEXT.today(server.today.counted, server.today.cap)
          : '',
    }
  }
  if (input.deviceKind !== 'random') return { ...head, figure: null, unit: null, today: null }
  // A random id has no server balance: the phone's own estimate, as on the home screen.
  return {
    ...head,
    figure: formatPoints(history.pointHalves),
    unit: HOME_TEXT.pointsUnit,
    today: '',
  }
}

