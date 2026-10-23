import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import React, { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { Avatar } from '@/src/kyw/Avatar'
import { ClaimSheet } from '@/src/kyw/ClaimSheet'
import { SkrCard } from '@/src/kyw/SkrCard'
import { ACCOUNT_TEXT as T, HOME_TEXT, TEXT } from '@/src/kyw/copy'
import { formatServerPoints, headlinePoints, skrClosed } from '@/src/kyw/server-points'
import { POINT_RULE, bonusText, formatPoints, pointsPerResult, pointsText, withServerClass } from '@/src/kyw/points'
import { ownRpcActive } from '@/src/kyw/probe-client'
import { useAccount } from '@/src/kyw/useAccount'
import { useKyw } from '@/src/kyw/useKyw'
import { useSkrName } from '@/src/kyw/useSkrName'
import { Button, ScreenBar } from '@/src/ui/components'
import { FadeUp, FlashText } from '@/src/ui/motion'
import { figure, fonts, makeStyles, useTheme } from '@/src/ui/theme'

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

export default function AccountScreen() {
  const router = useRouter()
  const theme = useTheme()
  const styles = useStyles()
  const account = useAccount()
  const { wallet, device, busy, note, link, unlink, server } = account
  const kyw = useKyw()
  const skrName = useSkrName(wallet?.address ?? null)
  const provider = kyw.settings.provider
  const userClass = server?.userClass ?? null
  // Live once SolSentry states the class: its multipliers count; before that they read as planned.
  const live = userClass !== null
  const ctx = withServerClass(
    {
      deviceVerified: device?.kind === 'key' && device.check === 'verified',
      genesis: wallet?.genesis === true || wallet?.sgt.status === 'verified',
      independentRpc: ownRpcActive(provider, kyw.probeReports[provider], kyw.secrets[provider] ?? '', Date.now()),
    },
    userClass,
  )
  const now = pointsPerResult(ctx)
  const skrOpen = server?.skr != null && !skrClosed(server.skr)
  const [claimSheet, setClaimSheet] = useState(false)
  const signed = device?.kind === 'key'
  const rates: [string, string, boolean][] = [
    [T.rateAttested, bonusText(POINT_RULE.attested), ctx.deviceVerified],
    [T.rateGenesis, bonusText(POINT_RULE.genesis), ctx.deviceVerified && ctx.genesis],
    [T.rateRpc, bonusText(POINT_RULE.independentRpc), ctx.deviceVerified && ctx.independentRpc],
  ]
  const sgtLine = wallet && (wallet.sgt.status === 'verified' ? T.genesis : wallet.sgt.status === 'none' ? T.noGenesis : T.genesisUnknown)

  return (
    <SafeAreaView style={styles.safe}>
      <ScreenBar
        title={T.title}
        onBack={() => router.back()}
        right={
          <Pressable accessibilityRole="button" accessibilityLabel={TEXT.settings} onPress={() => router.push('/settings')} style={styles.round}>
            <Ionicons name="settings-outline" size={17} color={theme.text} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        <FadeUp order={0} style={styles.card}>
          <Text style={styles.eyebrow}>{T.walletTitle}</Text>
          {wallet ? (
            <>
              <View style={styles.row}>
                <Avatar address={wallet.address} ring={ctx.genesis} />
                <View style={{ flex: 1 }}>
                  {skrName && <Text style={styles.text}>{skrName}</Text>}
                  <Text style={styles.address}>{short(wallet.address)}</Text>
                </View>
              </View>
              {sgtLine && <Text style={wallet.sgt.status === 'verified' ? styles.good : styles.muted}>{sgtLine}</Text>}
              <Text style={styles.muted}>{T.synced}</Text>
              <Button variant="secondary" title={T.unlink} busy={busy} onPress={() => void unlink()} />
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
        </FadeUp>
        <FadeUp order={1}>
          <SkrCard
            account={account}
            server={server}
            onClaim={() => {
              account.resetClaim()
              setClaimSheet(true)
            }}
          />
        </FadeUp>
        {!skrOpen && (
        <FadeUp order={1} style={styles.card}>
          <Text style={styles.eyebrow}>{T.rewardsTitle}</Text>
          <View style={styles.value}>
            <FlashText value={server ? server.points * 2 : kyw.history.pointHalves} armed={kyw.loaded} color={theme.text} flash={theme.actionText} style={styles.points}>
              {server ? formatServerPoints(headlinePoints(server)) : kyw.loaded ? formatPoints(kyw.history.pointHalves) : T.pointsUnknown}
            </FlashText>
            <Text style={styles.unit}>{HOME_TEXT.pointsUnit}</Text>
          </View>
          <Text style={styles.muted}>{server?.skr ? T.skrGenesisOnly : server ? T.pointsServer : T.pointsSoon}</Text>
          {/* The phone's own count (1 per result) would contradict the server's multipliers: once SolSentry answers, only its totals show. */}
          {server && (
            <Text style={styles.muted}>
              {T.pointsSplit(formatServerPoints(server.points), server.wallet?.points != null ? formatServerPoints(server.wallet.points) : null)}
            </Text>
          )}
          {!wallet && <Text style={styles.warn}>{T.pendingNote}</Text>}
        </FadeUp>
        )}
        <FadeUp order={2} style={styles.card}>
          <Text style={styles.eyebrow}>
            {T.rateTitle}{live ? ` · ${pointsText(now)}` : ''}
          </Text>
          {rates.map(([label, value, on]) => (
            <View key={label} style={styles.row}>
              <Text style={[styles.rate, { color: on ? theme.actionText : theme.muted }]}>{value}</Text>
              <Text style={[styles.text, !on && styles.off]}>{label}</Text>
              {live && on && <Text style={styles.tag}>{T.active}</Text>}
            </View>
          ))}
          {!signed ? (
            <Text style={styles.muted}>{T.rateZero}</Text>
          ) : live && server ? (
            <>
              <Text style={styles.muted}>{T.rateLive(pointsText(now), server.today.cap)}</Text>
              {!ctx.deviceVerified && <Text style={styles.muted}>{T.rateUnverified}</Text>}
              <Text style={styles.muted}>{T.skrRate}</Text>
            </>
          ) : (
            <>
              <Text style={styles.muted}>{T.rateNow(POINT_RULE.dailyCap)}</Text>
              <Text style={styles.muted}>{T.ratePlanned}</Text>
            </>
          )}
        </FadeUp>

        <Text style={styles.footnote}>{T.redeemLine}</Text>
      </ScrollView>
      {skrOpen && server?.skr && wallet && (
        <ClaimSheet
          visible={claimSheet}
          onClose={() => setClaimSheet(false)}
          amountRaw={server.skr.balanceRaw}
          wallet={wallet.address}
          walletName={skrName}
          claiming={account.claiming}
          outcome={account.claim}
          onApprove={() => void account.claimSkr()}
        />
      )}
    </SafeAreaView>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: t.bg },
    footnote: { color: t.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
    round: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: t.border2, alignItems: 'center', justifyContent: 'center' },
    body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 10 },
    card: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
    eyebrow: { color: t.muted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
    value: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
    points: { ...figure, color: t.text, fontSize: 46, lineHeight: 52, fontWeight: '500', letterSpacing: -1.8 },
    unit: { color: t.muted, fontFamily: fonts.mono, fontSize: 20 },
    text: { flex: 1, color: t.text, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
    off: { color: t.muted },
    muted: { color: t.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
    warn: { color: t.actionText, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
    good: { color: t.actionText, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    rate: { width: 40, fontFamily: fonts.mono, fontSize: 13 },
    address: { color: t.text, fontFamily: fonts.mono, fontSize: 14 },
    item: {
      height: 48,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.surface2,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      gap: 8,
    },
    tag: { color: t.muted, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: t.border2, textTransform: 'uppercase' },
  }),
)
