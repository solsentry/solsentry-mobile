// Offers the home screen widget through the launcher's own dialog (requestPinAppWidget).
// On the home screen it shows once (with Not now); in Settings it stays, and says when the widget is placed.
import React, { useEffect, useState } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'

import * as KywService from '@/modules/kyw-service'
import { Button } from '../ui/components'
import { fonts, makeStyles } from '../ui/theme'
import { WIDGET_TEXT as T } from './copy'
import type { WidgetInfo } from './widget-offer'

/** Re-read when the app comes back: the user confirms the launcher's dialog outside it. */
export function useWidgetInfo(): WidgetInfo | null {
  const [info, setInfo] = useState(() => KywService.widgetInfo())
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && setInfo(KywService.widgetInfo()))
    return () => sub.remove()
  }, [])
  return info
}

export function WidgetCard({ info, offer, onNotNow, onAdd }: { info: WidgetInfo; offer?: boolean; onNotNow?: () => void; onAdd?: () => void }) {
  const styles = useStyles()
  const placed = info.count > 0
  return (
    <View style={offer ? styles.offer : styles.plain}>
      <Text style={offer ? styles.title : styles.eyebrow}>{offer ? T.offerTitle : T.title}</Text>
      <Text style={styles.body}>{T.body}</Text>
      {placed ? (
        <Text style={styles.body}>{T.added}</Text>
      ) : !info.pinSupported ? (
        <Text style={styles.body}>{T.manual}</Text>
      ) : (
        <View style={styles.row}>
          {onNotNow && (
            <View style={{ flex: 1 }}>
              <Button variant="secondary" title={T.notNow} onPress={onNotNow} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Button
              title={T.add}
              onPress={() => {
                KywService.requestPinWidget()
                onAdd?.()
              }}
            />
          </View>
        </View>
      )}
    </View>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    offer: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.action, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
    plain: { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
    eyebrow: { color: t.muted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
    title: { color: t.text, fontFamily: fonts.body, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
    body: { color: t.muted, fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18 },
    row: { flexDirection: 'row', gap: 10 },
  }),
)
