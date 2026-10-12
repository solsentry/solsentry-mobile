// Keeps the home screen widget in step with the store and the last balance read from SolSentry. Runs in
// whichever JavaScript context is alive: the app, or the headless task of the foreground service.
import * as KywService from '@/modules/kyw-service'

import type { ServerPoints } from './server-points'
import { getState, subscribe } from './store'
import { widgetContent } from './widget'

let server: ServerPoints | null = null
let deviceKind: 'key' | 'random' | null = null
let last = ''
let started = false

function push(): void {
  const s = getState()
  const content = widgetContent({ ...s, server, deviceKind, now: Date.now() })
  if (!content) return
  const key = JSON.stringify(content)
  if (key === last) return
  last = key
  try {
    KywService.setWidget(content)
  } catch {
    // A widget that cannot be drawn must not break validation or the screen.
  }
}

/** A balance read from SolSentry, by the loop or by an open screen. */
export function noteServerPoints(p: ServerPoints): void {
  server = p
  push()
}

/** The device identity, once the loop or a screen has read it. */
export function noteDeviceKind(kind: 'key' | 'random'): void {
  deviceKind = kind
  push()
}

/** Safe to call many times. */
export function startWidgetSync(): void {
  if (started) return
  started = true
  subscribe(push)
  push()
}
