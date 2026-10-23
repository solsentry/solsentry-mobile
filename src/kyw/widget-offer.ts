// When to offer the home screen widget, and what a tap on the widget's Start/Pause button asks for.
import type { ServerPoints } from './server-points'

export interface WidgetInfo {
  pinSupported: boolean
  count: number
}

/** Once, after the first claim that went out or the first time today's cap is reached, if no widget is placed. */
export function shouldOfferWidget(input: {
  info: WidgetInfo | null
  offered: boolean
  claimSent: boolean
  server: ServerPoints | null
}): boolean {
  const { info, offered, claimSent, server } = input
  if (!info || !info.pinSupported || info.count > 0 || offered) return false
  const capped = server !== null && server.today.cap !== null && server.today.counted >= server.today.cap
  return claimSent || capped
}

/** solsentry:///?widget=start|stop&t=<ms>: the action and the tap's id, or null for any other link. */
export function widgetAsk(params: { widget?: string | string[]; t?: string | string[] }): { action: 'start' | 'stop'; id: string } | null {
  const action = Array.isArray(params.widget) ? params.widget[0] : params.widget
  const id = Array.isArray(params.t) ? params.t[0] : params.t
  if ((action !== 'start' && action !== 'stop') || !id || !/^\d{1,16}$/.test(id)) return null
  return { action, id }
}
