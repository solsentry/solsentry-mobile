import React from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'

import { Button } from '../ui/components'
import { fonts, makeStyles, useTheme } from '../ui/theme'
import { ACCOUNT_TEXT as T } from './copy'
import type { useAccount } from './useAccount'

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

function Badge({ label, on }: { label: string; on: boolean }) {
  const t = useTheme()
  const styles = useStyles()
  return (
    <View style={[styles.badge, on && styles.badgeOn]}>
      <Text style={[styles.badgeText, on && { color: t.ink }]}>{label}</Text>
    </View>
  )
}

/** Top of the home screen: the wallet of this phone and the badges it carries. */
export function WalletCard({ account, onOpen }: { account: ReturnType<typeof useAccount>; onOpen: () => void }) {
  const t = useTheme()
  const styles = useStyles()
  const { wallet, device, busy, note, link } = account
  const deviceVerified = device?.kind === 'key' && device.check === 'verified'
  if (!wallet) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{T.connectTitle}</Text>
        <Text style={styles.muted}>{T.connectNote}</Text>
        {busy ? (
          <View style={styles.row}>
            <ActivityIndicator color={t.action} />
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
    <Pressable accessibilityRole="button" accessibilityLabel={T.title} onPress={onOpen} style={[styles.card, genesis && { borderColor: t.action }]}>
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

const useStyles = makeStyles((t) => StyleSheet.create({
  card: { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  title: { color: t.text, fontFamily: fonts.title, fontSize: 17, fontWeight: '600', letterSpacing: -0.3 },
  address: { color: t.text, fontSize: 20, fontWeight: '800', fontFamily: fonts.mono },
  muted: { color: t.muted, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  warn: { color: t.warn, fontFamily: fonts.body, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  badge: { borderWidth: 1, borderColor: t.border2, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeOn: { backgroundColor: t.action, borderColor: t.action },
  badgeText: { color: t.muted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
}))
