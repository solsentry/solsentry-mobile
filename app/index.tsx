import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AppState, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { ACCOUNT_TEXT, HOME_TEXT, TEXT, VERDICT_LABEL, formatBytes, readingViaText, resultSentence } from '@/src/kyw/copy'
import { mode, startValidation, statusText, stopValidation } from '@/src/kyw/engine'
import { Avatar } from '@/src/kyw/Avatar'
import { ClaimSheet } from '@/src/kyw/ClaimSheet'
import { DayGrid } from '@/src/kyw/DayGrid'
import { IntroSheet } from '@/src/kyw/IntroSheet'
import { NoGenesisCard } from '@/src/kyw/NoGenesisCard'
import { Grid, verdictColor } from '@/src/kyw/Grid'
import { countedToday, tasksPerHour } from '@/src/kyw/history'
import { ownRpcActive } from '@/src/kyw/probe-client'
import { useAccount } from '@/src/kyw/useAccount'
import { WalletCard } from '@/src/kyw/WalletCard'
import * as Linking from 'expo-linking'

import { SKR_PAYOUT, solscanTx } from '@/src/config'
import { outcomeText } from '@/src/kyw/SkrCard'
import { formatServerPoints, formatSkr as formatSkrShort, skrClosed, skrFigure } from '@/src/kyw/server-points'
import { bonusText, formatPoints, pointsPerResult, pointsText, POINT_RULE, showNoGenesis, withServerClass } from '@/src/kyw/points'
import { providerInfo } from '@/src/kyw/providers'
import { RateDial } from '@/src/kyw/RateDial'
import { updateSettings } from '@/src/kyw/store'
import { INTRO_VERSION, type Verdict } from '@/src/kyw/types'
import { useKyw } from '@/src/kyw/useKyw'
import { useSkrName } from '@/src/kyw/useSkrName'
import { Bump, Fan, FadeUp, FlashText } from '@/src/ui/motion'
import { figure, fonts, makeStyles, useTheme } from '@/src/ui/theme'

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

async function askNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return
  try {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
  } catch {
    // Without it the service still runs; Android just hides the notification.
  }
}

export default function ValidateScreen() {
  const router = useRouter()
  const theme = useTheme()
  const styles = useStyles()
  const colors = verdictColor(theme)
  const kyw = useKyw()
  const account = useAccount()
  const { settings, history, running, status } = kyw
  const server = account.server
  // Cap 0 = no SKR for this device now (Genesis only in the Seeker phase): points take the figure, no Claim.
  const skr = server?.skr && !skrClosed(server.skr) ? server.skr : null
  const skrGenesisOnly = server?.skr != null && skr === null
  // Claim takes the CTA once SolSentry sends the SKR block and the claim is not off (never with a later payout).
  const claimHere = SKR_PAYOUT === 'claim' && skr !== null && skr.pool !== 'empty' && account.claim?.kind !== 'disabled'
  const claimReady = claimHere && account.wallet !== null && (skr.balanceRaw >= skr.minClaimRaw || skr.openClaim !== null)
  const claimOut = account.claim ? outcomeText(account.claim) : null
  const [claimSheet, setClaimSheet] = useState(false)

  // The mockup's credit toast: SKR the server added since the last read, shown for 2.4 s.
  const [credit, setCredit] = useState<bigint | null>(null)
  const lastSkr = useRef<bigint | null>(null)
  const skrBalance = skr?.balanceRaw ?? null
  useEffect(() => {
    const before = lastSkr.current
    lastSkr.current = skrBalance
    if (before === null || skrBalance === null || skrBalance <= before) return
    setCredit(skrBalance - before)
    const t = setTimeout(() => setCredit(null), 2_400)
    return () => clearTimeout(t)
  }, [skrBalance])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState(false)
  const provider = providerInfo(settings.provider)
  // The read's RPC is chosen in Settings; here it only sets the own-RPC multiplier and the status line.
  const report = kyw.probeReports[provider.id]
  const [probeNow, setProbeNow] = useState(Date.now)

  useEffect(() => {
    const refresh = () => setProbeNow(Date.now())
    const timer = setInterval(refresh, 30_000)
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh()
    })
    return () => {
      clearInterval(timer)
      subscription.remove()
    }
  }, [])

  const records = history.records
  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) ?? records[records.length - 1] ?? null,
    [records, selectedId],
  )
  const perHour = tasksPerHour(records, Date.now())
  const wallet = account.wallet
  const skrName = useSkrName(wallet?.address ?? null)
  // The chips follow the class SolSentry holds once it states one, not the phone's cached check.
  const ctx = withServerClass(
    {
      deviceVerified: account.device?.kind === 'key' && account.device.check === 'verified',
      genesis: wallet?.sgt.status === 'verified',
      independentRpc: ownRpcActive(provider.id, report, kyw.secrets[provider.id] ?? '', probeNow),
    },
    server?.userClass ?? null,
  )
  const rate = pointsPerResult(ctx)
  const rateChips: [string, boolean][] = [
    [`${HOME_TEXT.rateDevice} ${bonusText(POINT_RULE.attested)}`, ctx.deviceVerified],
    [`${HOME_TEXT.rateGenesis} ${bonusText(POINT_RULE.genesis)}`, ctx.deviceVerified && ctx.genesis],
    [`${HOME_TEXT.rateRpc} ${bonusText(POINT_RULE.independentRpc)}`, ctx.deviceVerified && ctx.independentRpc],
  ]

  // The mockup's bump: each matched result shows the SKR it adds, while this phone still earns SKR today.
  const [bump, setBump] = useState<{ key: number; text: string } | null>(null)
  const lastAccepted = useRef<number | null>(null)
  const accepted = history.counters.accepted
  const skrPerResult = skr && skr.window.earnedRaw < skr.window.capRaw ? pointsPerResult(ctx) / POINT_RULE.pointsPerSkr : 0
  useEffect(() => {
    const before = lastAccepted.current
    lastAccepted.current = accepted
    if (before === null || accepted <= before || skrPerResult <= 0) return
    setBump((b) => ({ key: (b?.key ?? 0) + 1, text: `+${Number(skrPerResult.toFixed(4))} SKR` }))
    const t = setTimeout(() => setBump(null), 1_600)
    return () => clearTimeout(t)
  }, [accepted, skrPerResult])

  const toggle = async (next: boolean) => {
    if (!next) return stopValidation()
    if (mode() === 'service') await askNotificationPermission()
    await startValidation()
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.appBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={HOME_TEXT.walletOpen}
          hitSlop={8}
          onPress={() => router.push('/account')}
          style={styles.identity}
        >
          <Avatar address={wallet?.address ?? null} ring={ctx.genesis} />
          <View style={styles.identityCol}>
            <Text numberOfLines={1} style={wallet && !skrName ? styles.identityMono : styles.identityText}>
              {skrName ?? (wallet ? short(wallet.address) : TEXT.appName)}
            </Text>
            {/* What SolSentry holds for this phone now, and where its reads go. */}
            <View style={styles.badges}>
              {ctx.deviceVerified && <Text style={[styles.badge, styles.badgeOn]}>{HOME_TEXT.badgeVerified}</Text>}
              {ctx.genesis && <Text style={[styles.badge, styles.badgeOn]}>{HOME_TEXT.rateGenesis}</Text>}
              <Pressable accessibilityRole="button" accessibilityLabel={TEXT.rpcTitle} hitSlop={6} onPress={() => router.push('/rpc')}>
                <Text style={styles.badge}>{provider.id === 'solsentry' ? HOME_TEXT.badgeRpcDefault : HOME_TEXT.rateRpc} ›</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
        <View style={styles.barRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={theme.name === 'dark' ? HOME_TEXT.themeLight : HOME_TEXT.themeDark}
            onPress={() => void updateSettings({ theme: theme.name === 'dark' ? 'light' : 'dark' })}
            style={styles.roundBtn}
          >
            <Ionicons name={theme.name === 'dark' ? 'sunny-outline' : 'moon-outline'} size={16} color={theme.text} />
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {!wallet && (
          <FadeUp order={0}>
            <WalletCard account={account} deviceVerified={ctx.deviceVerified} onOpen={() => router.push('/account')} />
          </FadeUp>
        )}
        {showNoGenesis(wallet, settings.seenNoGenesis) && (
          <FadeUp order={0}>
            <NoGenesisCard account={account} />
          </FadeUp>
        )}

        <FadeUp order={0}>
          <DayGrid days={history.days} now={probeNow} running={running} />
        </FadeUp>

        <FadeUp order={1} style={styles.balance}>
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel={TEXT.toggle}
            accessibilityState={{ checked: running, disabled: !kyw.loaded }}
            disabled={!kyw.loaded}
            onPress={() => void toggle(!running)}
            style={styles.statusBtn}
          >
            <Fan running={running} color={running ? theme.action : theme.muted} />
            <Text style={styles.statusText}>{running ? HOME_TEXT.statusOn : HOME_TEXT.statusOff}</Text>
            <Text style={styles.statusPace}>{running && perHour !== null ? HOME_TEXT.pace(perHour) : ''}</Text>
            <Ionicons name={running ? 'pause' : 'play'} size={13} color={theme.muted} />
          </Pressable>
          <View style={styles.valueRow}>
            <View style={styles.value}>
              {skr ? (
                // SKR as SolSentry's ledger states it; points stay a detail below.
                <>
                  <FlashText value={Number(skr.balanceRaw)} armed={kyw.loaded} color={theme.text} flash={theme.actionText} style={styles.valueMain}>
                    {skrFigure(skr.balanceRaw).main}
                  </FlashText>
                  <Text style={styles.valueSmall}>{skrFigure(skr.balanceRaw).tail}</Text>
                </>
              ) : (
                <FlashText value={server ? server.points * 2 : history.pointHalves} armed={kyw.loaded} color={theme.text} flash={theme.actionText} style={styles.valueMain}>
                  {server ? formatServerPoints(server.points) : kyw.loaded ? formatPoints(history.pointHalves) : ACCOUNT_TEXT.pointsUnknown}
                </FlashText>
              )}
              <Text style={styles.valueTail}>{skr ? ACCOUNT_TEXT.skrUnit : HOME_TEXT.pointsUnit}</Text>
            </View>
            {skr ? (
              <Text style={styles.rateTag}>{ACCOUNT_TEXT.skrWindow(formatSkrShort(skr.window.earnedRaw), formatSkrShort(skr.window.capRaw))}</Text>
            ) : server ? (
              server.today.cap !== null && <Text style={styles.rateTag}>{ACCOUNT_TEXT.today(server.today.counted, server.today.cap)}</Text>
            ) : (
              account.device?.kind === 'key' && (
                <Text style={styles.rateTag}>{ACCOUNT_TEXT.today(countedToday(history, probeNow), POINT_RULE.dailyCap)}</Text>
              )
            )}
          </View>
          {!skr && server && server.today.cap !== null && server.today.counted >= server.today.cap && (
            <Text style={styles.capNote}>{HOME_TEXT.capReached}</Text>
          )}
          {server && (
            <Text style={styles.muted}>
              {ACCOUNT_TEXT.pointsSplit(formatServerPoints(server.points), server.wallet?.points != null ? formatServerPoints(server.wallet.points) : null)}
            </Text>
          )}
          {skrGenesisOnly && <Text style={styles.muted}>{ACCOUNT_TEXT.skrGenesisOnly}</Text>}
          <Text accessibilityLiveRegion="polite" style={styles.muted}>
            {running ? statusText(status) : statusText({ kind: 'idle' })} · {readingViaText(provider.label)}
          </Text>
          {skr?.pool === 'empty' && <Text style={styles.warnLine}>{ACCOUNT_TEXT.poolEmpty}</Text>}
          {claimHere ? (
            // The mockup's Claim: signs and sends from here; without a wallet or enough SKR it opens Points, which says why.
            <Pressable
              accessibilityRole="button"
              disabled={account.claiming}
              onPress={() => {
                if (!claimReady) return router.push('/account')
                account.resetClaim()
                setClaimSheet(true)
              }}
              style={({ pressed }) => [styles.cta, (pressed || account.claiming) && { opacity: 0.85 }]}
            >
              <Text style={styles.ctaText}>{account.claiming ? ACCOUNT_TEXT.claiming : HOME_TEXT.claimCta}</Text>
              <Ionicons name="arrow-forward" size={16} color={theme.ink} />
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => router.push('/account')} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}>
              <Text style={styles.ctaText}>{HOME_TEXT.pointsCta}</Text>
              <Ionicons name="arrow-forward" size={16} color={theme.ink} />
            </Pressable>
          )}
          {claimOut && <Text style={claimOut.good ? styles.goodLine : styles.warnLine}>{claimOut.text}</Text>}
          {claimOut?.signature && (
            <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(solscanTx(claimOut.signature!))}>
              <Text style={styles.link}>{ACCOUNT_TEXT.viewTx}</Text>
            </Pressable>
          )}
        </FadeUp>

        <FadeUp order={2} style={styles.card}>
          <View style={styles.head}>
            <Text style={styles.eyebrow}>{HOME_TEXT.tasks}</Text>
            <View style={styles.headRight}>
              {bump !== null && <Bump key={bump.key} text={bump.text} style={styles.bump} />}
              <Text style={styles.headValue}>{(history.counters.accepted + history.counters.diverged + history.counters.unknown).toLocaleString('en-US')}</Text>
            </View>
          </View>
          <Grid
            records={records}
            loaded={kyw.loaded}
            selectedId={selected?.id ?? null}
            onSelect={(r) => {
              setSelectedId(r.id)
              setDetails(true)
            }}
          />
          {!selected && <Text style={styles.muted}>{TEXT.gridEmpty}</Text>}
          {/* Counters and the selected task fold under one row, so the card stays short. */}
          {selected && (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: details }}
              onPress={() => setDetails(!details)}
              style={styles.counters}
            >
              {(['accepted', 'diverged', 'unknown'] as Verdict[]).map((v) => (
                <View key={v} style={styles.counter}>
                  <View style={[styles.dot, { backgroundColor: colors[v] }]} />
                  <Text style={styles.counterValue}>{history.counters[v].toLocaleString('en-US')}</Text>
                  <Text style={styles.counterLabel}>{VERDICT_LABEL[v]}</Text>
                </View>
              ))}
              <Ionicons name={details ? 'chevron-up' : 'chevron-down'} size={14} color={theme.muted} style={{ marginLeft: 'auto' }} />
            </Pressable>
          )}
          {selected && details && (
            <View accessibilityLiveRegion="polite" style={[styles.result, { borderColor: colors[selected.verdict] }]}>
              <Text style={styles.resultHead}>
                {VERDICT_LABEL[selected.verdict].toUpperCase()}
                {selected.short ? `  ·  ${selected.short}` : ''}
              </Text>
              <Text style={styles.resultText}>{resultSentence(selected)}</Text>
              <Text style={styles.resultMeta}>
                {new Date(selected.at).toLocaleTimeString()} · {selected.ms} ms · {formatBytes(selected.bytes)} · {selected.host}
              </Text>
            </View>
          )}
        </FadeUp>

        <FadeUp order={3}>
          <Pressable accessibilityRole="button" accessibilityLabel={ACCOUNT_TEXT.rateTitle} onPress={() => router.push('/account')} style={styles.level}>
            <Text style={styles.eyebrow}>
              {HOME_TEXT.rate} · {pointsText(rate)}
            </Text>
            <RateDial rate={rate} running={running} />
            <View style={styles.segs}>
              {rateChips.map(([label, on]) => (
                <View key={label} style={[styles.seg, on && styles.segOn]}>
                  <Text style={[styles.segText, on && { color: theme.ink }]}>{label}</Text>
                </View>
              ))}
            </View>
          </Pressable>
        </FadeUp>

        <Text style={styles.footer}>{TEXT.explain}</Text>
        <Text style={styles.footer}>{TEXT.about}</Text>
      </ScrollView>

      <IntroSheet visible={kyw.loaded && settings.introSeen < INTRO_VERSION} />
      {skr && wallet && (
        <ClaimSheet
          visible={claimSheet}
          onClose={() => setClaimSheet(false)}
          amountRaw={skr.balanceRaw}
          wallet={wallet.address}
          walletName={skrName}
          claiming={account.claiming}
          outcome={account.claim}
          onApprove={() => void account.claimSkr()}
        />
      )}
      {credit !== null && (
        <FadeUp order={0} style={styles.toast}>
          <Text style={styles.toastText}>{HOME_TEXT.creditToast}</Text>
          <Text style={styles.toastChip}>+{formatSkrShort(credit)} SKR</Text>
        </FadeUp>
      )}
    </SafeAreaView>
  )
}

const mono = { fontFamily: fonts.mono } as const
const sans = { fontFamily: fonts.body } as const

const useStyles = makeStyles((theme) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  appBar: { height: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1, marginRight: 8 },
  avatar: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: theme.border2, alignItems: 'center', justifyContent: 'center' },
  identityText: { ...sans, color: theme.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.3 },
  identityMono: { ...mono, color: theme.text, fontSize: 14, fontWeight: '500' },
  identityCol: { flexShrink: 1, gap: 4 },
  badges: { flexDirection: 'row', gap: 5 },
  badge: { ...mono, color: theme.muted, fontSize: 8.5, letterSpacing: 0.5, paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 4, borderWidth: 1, borderColor: theme.border2, textTransform: 'uppercase', overflow: 'hidden' },
  badgeOn: { color: theme.actionText, borderColor: theme.action },
  barRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tag: { ...mono, color: theme.muted, fontSize: 9, letterSpacing: 0.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: theme.border2, textTransform: 'uppercase' },
  roundBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: theme.border2, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 10 },
  muted: { ...sans, color: theme.muted, fontSize: 12, lineHeight: 17 },
  capNote: { ...sans, color: theme.actionText, fontSize: 12, lineHeight: 17 },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  eyebrow: { ...mono, color: theme.muted, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  headValue: { ...mono, color: theme.text, fontSize: 13 },
  headRight: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  bump: { ...mono, color: theme.actionText, fontSize: 10.5 },
  balance: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 16, padding: 10, gap: 10 },
  statusBtn: {
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
  },
  statusText: { ...mono, color: theme.text, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', flex: 1 },
  statusPace: { ...mono, color: theme.muted, fontSize: 11 },
  // Wraps: a long figure (115.2 pts) pushes the cap line below instead of over the unit and past the edge.
  valueRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', columnGap: 12, paddingHorizontal: 6, paddingTop: 4 },
  value: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  valueMain: { ...figure, color: theme.text, fontSize: 46, lineHeight: 52, fontWeight: '500', letterSpacing: -1.8 },
  valueTail: { ...mono, color: theme.muted, fontSize: 20 },
  valueSmall: { ...figure, color: theme.muted, fontSize: 20, marginLeft: -4 },
  toast: {
    position: 'absolute',
    top: 70,
    left: 16,
    right: 16,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.action,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 18,
    paddingRight: 8,
    shadowColor: theme.action,
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 8,
  },
  toastText: { ...mono, color: theme.ink, fontSize: 12, letterSpacing: 0.5 },
  toastChip: { ...mono, color: theme.ink, fontSize: 13, fontWeight: '500', height: 32, lineHeight: 32, paddingHorizontal: 12, borderRadius: 16, overflow: 'hidden', backgroundColor: 'rgba(23,16,10,0.14)' },
  warnLine: { ...sans, color: theme.actionText, fontSize: 12, lineHeight: 17, paddingHorizontal: 6 },
  goodLine: { ...sans, color: theme.actionText, fontSize: 13, lineHeight: 18, paddingHorizontal: 6 },
  link: { ...mono, color: theme.actionText, fontSize: 12, textDecorationLine: 'underline', paddingHorizontal: 6 },
  rateTag: { ...mono, color: theme.actionText, fontSize: 11, marginBottom: 8 },
  cta: {
    height: 48,
    borderRadius: 10,
    backgroundColor: theme.action,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  ctaText: { ...sans, color: theme.ink, fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  counters: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 4, minHeight: 28 },
  counter: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  counterValue: { ...mono, color: theme.text, fontSize: 12 },
  counterLabel: { ...sans, color: theme.muted, fontSize: 12 },
  result: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 4, backgroundColor: theme.surface2 },
  resultHead: { ...mono, color: theme.text, fontSize: 11, letterSpacing: 1 },
  resultText: { ...sans, color: theme.text, fontSize: 14, lineHeight: 20 },
  resultMeta: { ...mono, color: theme.muted, fontSize: 10.5, lineHeight: 15 },
  level: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14, gap: 10 },
  segs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  seg: { height: 30, paddingHorizontal: 12, borderRadius: 15, borderWidth: 1, borderColor: theme.border2, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: theme.action, borderColor: theme.action },
  segText: { ...sans, color: theme.muted, fontSize: 12, fontWeight: '600' },
  label: { ...sans, color: theme.text, fontSize: 14, fontWeight: '600' },
  footer: { ...sans, color: theme.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
}))
