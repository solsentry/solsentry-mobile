// A newer build is published (useUpdate): its name, what changed, and a link that opens in the browser.
// "Later" hides this build's notice; a newer one shows again.
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Button } from '../ui/components'
import { fonts, makeStyles } from '../ui/theme'
import { UPDATE_TEXT as T } from './copy'
import type { LatestBuild } from './update'

export function UpdateBanner({ offer, onDownload, onLater }: { offer: LatestBuild; onDownload: () => void; onLater: () => void }) {
  const styles = useStyles()
  return (
    <View style={styles.card} accessibilityRole="alert">
      <Text style={styles.title}>{T.title(offer.name)}</Text>
      <Text style={styles.body}>{offer.notes ?? T.body}</Text>
      <Text style={styles.body}>{T.how}</Text>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" title={T.later} onPress={onLater} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title={T.download} onPress={onDownload} />
        </View>
      </View>
    </View>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    card: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.action, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
    title: { color: t.text, fontFamily: fonts.body, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
    body: { color: t.muted, fontFamily: fonts.body, fontSize: 12.5, lineHeight: 18 },
    row: { flexDirection: 'row', gap: 10 },
  }),
)
