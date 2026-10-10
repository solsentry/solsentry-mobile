// Device check section. Rendered only when DEVICE_CHECK_ENABLED is true; shares no state with
// the recipient/sender checks or the send button.
import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Button } from '@/src/ui/components'
import { fonts, theme } from '@/src/ui/theme'
import { runDeviceCheck } from './attest'
import type { DeviceCheckView } from './attest-logic'

export function DeviceCheckSection() {
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<DeviceCheckView | null>(null)

  async function onRun() {
    setBusy(true)
    try {
      setView(await runDeviceCheck())
    } catch (e) {
      // Never a silent failure: an unexpected throw is shown as "could not verify", never as genuine.
      setView({
        claims: [],
        proves: [],
        notes: [`Detail: ${(e as Error)?.message ?? String(e)}`],
        status: 'could_not_verify',
        headline: 'Could not verify this device.',
      })
    } finally {
      setBusy(false)
    }
  }

  const tone = view?.status === 'verified' ? theme.allow : view?.status === 'not_verified' ? theme.warn : theme.muted
  return (
    <View style={styles.box}>
      <Text style={styles.h2}>Device check</Text>
      <Text style={styles.text}>Asks the secure hardware in this phone to prove what it is. Optional.</Text>
      <Button variant="secondary" title="Run device check" onPress={onRun} busy={busy} disabled={busy} />
      {view && (
        <View accessibilityLiveRegion="polite" style={[styles.card, { borderColor: tone }]}>
          <Text style={[styles.headline, { color: view.status === 'verified' ? theme.text : tone }]}>{view.headline}</Text>
          <Text style={styles.label}>What the phone claims</Text>
          {view.claims.map((l) => (
            <Text key={l} style={styles.text}>
              {l}
            </Text>
          ))}
          {view.proves.length > 0 && <Text style={styles.label}>What the hardware proves</Text>}
          {view.proves.map((l) => (
            <Text key={l} style={styles.text}>
              {l}
            </Text>
          ))}
          {view.notes.map((l) => (
            <Text key={l} style={styles.note}>
              {l}
            </Text>
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  h2: { color: theme.text, fontFamily: fonts.title, fontSize: 17, fontWeight: '700' },
  card: { borderWidth: 1.5, borderRadius: 12, padding: 14, gap: 4, backgroundColor: theme.surface },
  headline: { fontFamily: fonts.body, fontSize: 16, fontWeight: '700', marginBottom: 4 },
  label: { color: theme.text, fontFamily: fonts.body, fontSize: 14, fontWeight: '600', marginTop: 6 },
  text: { color: theme.text, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  note: { color: theme.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17, marginTop: 4 },
})
