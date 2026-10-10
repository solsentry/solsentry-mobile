import { useRouter } from 'expo-router'
import React from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { ACCOUNT_TEXT as T } from '@/src/kyw/copy'
import { POINT_RULE, formatPoints, independentRpc, multiplier, multiplierText } from '@/src/kyw/points'
import { useAccount } from '@/src/kyw/useAccount'
import { useKyw } from '@/src/kyw/useKyw'
import { Button } from '@/src/ui/components'
import { fonts, theme } from '@/src/ui/theme'

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

export default function AccountScreen() {
  const router = useRouter()
  const { wallet, device, busy, note, link, unlink, status } = useAccount()
  const kyw = useKyw()
  const provider = kyw.settings.provider
  const ctx = {
    deviceVerified: device?.kind === 'key' && device.check === 'verified',
    genesis: wallet?.sgt.status === 'verified',
    independentRpc: independentRpc(provider, kyw.probeReports[provider]),
  }
  const now = multiplier(ctx)
  const rates: [string, string, boolean][] = [
    [T.rateBase, multiplierText(POINT_RULE.base), ctx.deviceVerified],
    [T.rateGenesis, multiplierText(POINT_RULE.genesis), ctx.deviceVerified && ctx.genesis],
    [T.rateRpc, multiplierText(POINT_RULE.independentRpc), ctx.deviceVerified && ctx.independentRpc],
  ]
  const sgtLine = wallet && (wallet.sgt.status === 'verified' ? T.genesis : wallet.sgt.status === 'none' ? T.noGenesis : T.genesisUnknown)

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.muted}>‹ Back</Text>
        </Pressable>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{T.title}</Text>
          <Text style={styles.points}>
            {kyw.loaded ? formatPoints(kyw.history.pointHalves) : T.pointsUnknown} <Text style={styles.muted}>{T.pointsLabel}</Text>
          </Text>
          <Text style={styles.muted}>{T.pointsSoon}</Text>
          {status && !status.earns && status.why === 'device_not_verified' && <Text style={styles.muted}>{T.deviceNotVerified}</Text>}
          {!wallet && <Text style={styles.warn}>{T.pendingNote}</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{T.rateTitle}</Text>
          {rates.map(([label, value, on]) => (
            <View key={label} style={styles.row}>
              <Text style={[on ? styles.good : styles.disabled, styles.rate]}>{value}</Text>
              <Text style={[on ? styles.text : styles.disabled, { flex: 1 }]}>{label}</Text>
            </View>
          ))}
          <Text style={styles.muted}>{now > 0 ? T.rateNow(multiplierText(now)) : T.rateZero}</Text>
        </View>

        <View style={styles.card}>
          {wallet ? (
            <>
              <Text style={styles.cardTitle}>{T.linked}</Text>
              <Text style={styles.text}>{short(wallet.address)}</Text>
              {sgtLine && <Text style={wallet.sgt.status === 'verified' ? styles.good : styles.muted}>{sgtLine}</Text>}
              {!wallet.synced && <Text style={styles.muted}>{T.notSynced}</Text>}
              <Button
                variant="secondary"
                title={T.unlink}
                onPress={() => void unlink()}
              />
            </>
          ) : busy ? (
            <View style={styles.row}>
              <ActivityIndicator color={theme.action} />
              <Text style={styles.muted}>{T.linking}</Text>
            </View>
          ) : (
            <Button title={T.link} onPress={() => void link()} />
          )}
          {note && <Text style={styles.warn}>{note}</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{T.redeemTitle}</Text>
          <Text style={styles.muted}>{T.redeemNote}</Text>
          {T.redeemItems.map((i) => (
            <Text key={i} style={styles.disabled}>
              {i} · Planned
            </Text>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, gap: 16 },
  card: { borderWidth: 1, borderColor: theme.border, borderRadius: 16, padding: 16, gap: 10 },
  cardTitle: { color: theme.text, fontFamily: fonts.title, fontSize: 17, fontWeight: '700' },
  points: { color: theme.text, fontFamily: fonts.body, fontSize: 34, fontWeight: '800' },
  text: { color: theme.text, fontFamily: fonts.body, fontSize: 15 },
  muted: { color: theme.muted, fontFamily: fonts.body, fontSize: 14 },
  warn: { color: theme.warn, fontFamily: fonts.body, fontSize: 14 },
  good: { color: theme.action, fontFamily: fonts.body, fontSize: 14 },
  disabled: { color: theme.muted, fontFamily: fonts.body, fontSize: 15, opacity: 0.6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rate: { width: 44, fontWeight: '800', fontFamily: fonts.body, fontSize: 15 },
})
