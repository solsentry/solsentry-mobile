import React from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'

import { Button } from '../ui/components'
import { theme } from '../ui/theme'
import { ACCOUNT_TEXT as T } from './copy'
import type { useAccount } from './useAccount'

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

function Badge({ label, on }: { label: string; on: boolean }) {
  return (
    <View style={[styles.badge, on && styles.badgeOn]}>
      <Text style={[styles.badgeText, on && { color: theme.ink }]}>{label}</Text>
    </View>
  )
}

/** Top of the home screen: the wallet of this phone and the badges it carries. */
export function WalletCard({ account, onOpen }: { account: ReturnType<typeof useAccount>; onOpen: () => void }) {
  const { wallet, device, busy, note, link } = account
  const deviceVerified = device?.kind === 'key' && device.check === 'verified'
  if (!wallet) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{T.connectTitle}</Text>
        <Text style={styles.muted}>{T.connectNote}</Text>
        {busy ? (
          <View style={styles.row}>
            <ActivityIndicator color={theme.action} />
            <Text style={styles.muted}>{T.linking}</Text>
          </View>
        ) : (
          <Button title={T.connect} onPress={() => void link()} />
        )}
        {deviceVerified && (
          <View style={styles.row}>
            <Badge label={T.badgeDevice} on />
          </View>
        )}
        {note && <Text style={styles.warn}>{note}</Text>}
      </View>
    )
  }
  const genesis = wallet.sgt.status === 'verified'
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={T.title} onPress={onOpen} style={[styles.card, genesis && { borderColor: theme.action }]}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.muted}>{T.linked}</Text>
          <Text style={styles.address}>{short(wallet.address)}</Text>
        </View>
        <Text style={styles.muted}>›</Text>
      </View>
      <View style={styles.row}>
        <Badge label={T.badgeGenesis} on={genesis} />
        <Badge label={T.badgeDevice} on={deviceVerified} />
      </View>
      {wallet.sgt.status === 'unknown' && <Text style={styles.muted}>{T.genesisUnknown}</Text>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1.5, borderRadius: 16, padding: 14, gap: 10 },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  address: { color: theme.text, fontSize: 20, fontWeight: '800', fontFamily: 'monospace' },
  muted: { color: theme.muted, fontSize: 13, lineHeight: 18 },
  warn: { color: theme.warn, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  badge: { borderWidth: 1, borderColor: theme.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeOn: { backgroundColor: theme.action, borderColor: theme.action },
  badgeText: { color: theme.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
})
