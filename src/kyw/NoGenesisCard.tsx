// Right after a wallet without a Seeker Genesis Token is linked: what it earns now, and the way to switch.
// Linking another wallet replaces this one on the server (link_wallet closes the device's previous link).
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Button } from '../ui/components'
import { fonts, makeStyles } from '../ui/theme'
import { HOME_TEXT as T } from './copy'
import { updateSettings } from './store'
import type { useAccount } from './useAccount'

export function NoGenesisCard({ account }: { account: ReturnType<typeof useAccount> }) {
  const styles = useStyles()
  const wallet = account.wallet
  if (!wallet) return null
  return (
    <View style={styles.card} accessibilityRole="alert">
      <Text style={styles.title}>{T.noGenesisTitle}</Text>
      <Text style={styles.body}>{T.noGenesisBody}</Text>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" title={T.noGenesisKeep} onPress={() => void updateSettings({ seenNoGenesis: wallet.address })} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title={T.noGenesisSwitch} disabled={account.busy} onPress={() => void account.link()} />
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
