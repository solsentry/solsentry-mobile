import Ionicons from '@expo/vector-icons/Ionicons'
import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AppState, KeyboardAvoidingView, Modal, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { KYW_API_BASE } from '@/src/kyw/config'
import { ACCOUNT_TEXT, HOME_TEXT, TEXT, VERDICT_LABEL, formatBytes, readingViaText, switchProviderPrompt, probeProblemText, probeReportLines, probeTestedText, resultSentence } from '@/src/kyw/copy'
import { mode, startValidation, statusText, stopValidation } from '@/src/kyw/engine'
import { Avatar } from '@/src/kyw/Avatar'
import { DayGrid } from '@/src/kyw/DayGrid'
import { Grid, verdictColor } from '@/src/kyw/Grid'
import { countedToday, tasksPerHour } from '@/src/kyw/history'
import { useAccount } from '@/src/kyw/useAccount'
import { WalletCard } from '@/src/kyw/WalletCard'
import { chosenRpcProbeIsStale, probeChosenRpc } from '@/src/kyw/probe-client'
import { formatServerPoints } from '@/src/kyw/server-points'
import { formatPoints, independentRpc, multiplier, multiplierText, POINT_RULE } from '@/src/kyw/points'
import { PROVIDERS, providerInfo, type ProviderId } from '@/src/kyw/providers'
import { RateDial } from '@/src/kyw/RateDial'
import { recordProbeReport, setSecret, updateSettings } from '@/src/kyw/store'
import type { Verdict } from '@/src/kyw/types'
import { useKyw } from '@/src/kyw/useKyw'
import { useSkrName } from '@/src/kyw/useSkrName'
import { Button } from '@/src/ui/components'
import { Fan, FadeUp, FlashText } from '@/src/ui/motion'
import { figure, fonts, makeStyles, useTheme } from '@/src/ui/theme'

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

/** Two letters for the RPC pill and the sheet rows. */
const RPC_CODE: Record<ProviderId, string> = { solsentry: 'SS', helius: 'HE', quicknode: 'QN', solami: 'SO' }

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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rpcMenu, setRpcMenu] = useState(false)
  const provider = providerInfo(settings.provider)
  const [probing, setProbing] = useState<ProviderId | null>(null)
  const probeInFlight = useRef(false)
  const [probeProblem, setProbeProblem] = useState<{ provider: ProviderId; text: string } | null>(null)
  const [probeNow, setProbeNow] = useState(Date.now)
  const report = kyw.probeReports[provider.id]
  const reportStale = chosenRpcProbeIsStale(report ?? null, provider.id, kyw.secrets[provider.id] ?? '', probeNow)

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

  // A tap on another RPC while validation runs asks first: an accidental tap must not move the reads
  // (and the user's key) to another provider without the user seeing it.
  const chooseProvider = (id: ProviderId) => {
    if (id === settings.provider) return
    if (!running) {
      void updateSettings({ provider: id })
      return
    }
    const next = providerInfo(id)
    const prompt = switchProviderPrompt(next.label, next.secretLabel !== null)
    Alert.alert(prompt.title, prompt.body, [
      { text: prompt.cancel, style: 'cancel' },
      { text: prompt.confirm, onPress: () => void updateSettings({ provider: id }) },
    ])
  }

  const testRpc = async () => {
    if (probeInFlight.current) return
    probeInFlight.current = true
    const id = provider.id
    setProbing(id)
    setProbeProblem(null)
    try {
      const result = await probeChosenRpc({
        fetch,
        apiBase: KYW_API_BASE,
        provider: id,
        secret: kyw.secrets[id] ?? '',
        clientVersion: Constants.expoConfig?.version ?? '0',
      })
      if (!result.ok) setProbeProblem({ provider: id, text: probeProblemText(result.problem) })
      else if (result.kind === 'report') await recordProbeReport(id, result.report)
    } finally {
      setProbeNow(Date.now())
      setProbing(null)
      probeInFlight.current = false
    }
  }
  const records = history.records
  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) ?? records[records.length - 1] ?? null,
    [records, selectedId],
  )
  const perHour = tasksPerHour(records, Date.now())
  const wallet = account.wallet
  const skrName = useSkrName(wallet?.address ?? null)
  const ctx = {
    deviceVerified: account.device?.kind === 'key' && account.device.check === 'verified',
    genesis: wallet?.sgt.status === 'verified',
    independentRpc: independentRpc(provider.id, report),
  }
  const rate = multiplier(ctx)
  const rateChips: [string, boolean][] = [
    [HOME_TEXT.rateDevice, ctx.deviceVerified],
    [HOME_TEXT.rateGenesis, ctx.deviceVerified && ctx.genesis],
    [HOME_TEXT.rateRpc, ctx.deviceVerified && ctx.independentRpc],
  ]

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
          <Text numberOfLines={1} style={wallet && !skrName ? styles.identityMono : styles.identityText}>
            {skrName ?? (wallet ? short(wallet.address) : TEXT.appName)}
          </Text>
        </Pressable>
        <View style={styles.barRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ACCOUNT_TEXT.rpcMenuTitle}: ${provider.label}`}
            onPress={() => setRpcMenu(true)}
            style={styles.rpcPill}
          >
            <Text style={styles.rpcCode}>{RPC_CODE[provider.id]}</Text>
            <Text style={styles.tag}>RPC</Text>
            <Ionicons name="chevron-down" size={13} color={theme.text} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={theme.name === 'dark' ? HOME_TEXT.themeLight : HOME_TEXT.themeDark}
            onPress={() => void updateSettings({ theme: theme.name === 'dark' ? 'light' : 'dark' })}
            style={styles.roundBtn}
          >
            <Ionicons name={theme.name === 'dark' ? 'sunny-outline' : 'moon-outline'} size={16} color={theme.text} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={TEXT.settings} onPress={() => router.push('/settings')} style={styles.roundBtn}>
            <Ionicons name="settings-outline" size={17} color={theme.text} />
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {!wallet && (
          <FadeUp order={0}>
            <WalletCard account={account} onOpen={() => router.push('/account')} />
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
              <FlashText value={server ? server.points * 2 : history.pointHalves} armed={kyw.loaded} color={theme.text} flash={theme.actionText} style={styles.valueMain}>
                {server ? formatServerPoints(server.points) : kyw.loaded ? formatPoints(history.pointHalves) : ACCOUNT_TEXT.pointsUnknown}
              </FlashText>
              <Text style={styles.valueTail}>{HOME_TEXT.pointsUnit}</Text>
            </View>
            {server ? (
              server.today.cap !== null && <Text style={styles.rateTag}>{ACCOUNT_TEXT.today(server.today.counted, server.today.cap)}</Text>
            ) : (
              account.device?.kind === 'key' && (
                <Text style={styles.rateTag}>{ACCOUNT_TEXT.today(countedToday(history, probeNow), POINT_RULE.dailyCap)}</Text>
              )
            )}
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.muted}>
            {running ? statusText(status) : statusText({ kind: 'idle' })} · {readingViaText(provider.label)}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => router.push('/account')} style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}>
            <Text style={styles.ctaText}>{HOME_TEXT.pointsCta}</Text>
            <Ionicons name="arrow-forward" size={16} color={theme.ink} />
          </Pressable>
        </FadeUp>

        <FadeUp order={2} style={styles.card}>
          <View style={styles.head}>
            <Text style={styles.eyebrow}>{HOME_TEXT.tasks}</Text>
            <Text style={styles.headValue}>{(history.counters.accepted + history.counters.diverged + history.counters.unknown).toLocaleString('en-US')}</Text>
          </View>
          <Grid records={records} loaded={kyw.loaded} selectedId={selected?.id ?? null} onSelect={(r) => setSelectedId(r.id)} />
          <View style={styles.counters}>
            {(['accepted', 'diverged', 'unknown'] as Verdict[]).map((v) => (
              <View key={v} style={styles.counter}>
                <View style={[styles.dot, { backgroundColor: colors[v] }]} />
                <Text style={styles.counterValue}>{history.counters[v].toLocaleString('en-US')}</Text>
                <Text style={styles.counterLabel}>{VERDICT_LABEL[v]}</Text>
              </View>
            ))}
          </View>
          {!selected && <Text style={styles.muted}>{TEXT.gridEmpty}</Text>}
          {selected && (
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
              {HOME_TEXT.rate}{rate > 0 ? ` · ${multiplierText(rate)}` : ''} · {ACCOUNT_TEXT.planned}
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

      <Modal visible={rpcMenu} transparent animationType="slide" onRequestClose={() => setRpcMenu(false)}>
        <KeyboardAvoidingView behavior="padding" style={styles.sheetWrap}>
          <Pressable accessibilityRole="button" accessibilityLabel={HOME_TEXT.close} style={styles.scrim} onPress={() => setRpcMenu(false)} />
          <View style={styles.sheet}>
            <View style={styles.grabber} />
            <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.sheetTitle}>{ACCOUNT_TEXT.rpcMenuTitle}</Text>
              {PROVIDERS.map((p) => {
                const active = p.id === settings.provider
                return (
                  <Pressable
                    key={p.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    onPress={() => chooseProvider(p.id)}
                    style={[styles.prow, active && { borderColor: theme.action }]}
                  >
                    <View style={styles.pcode}>
                      <Text style={styles.pcodeText}>{RPC_CODE[p.id]}</Text>
                    </View>
                    <View style={styles.pname}>
                      <Text style={styles.pnameText}>{p.label}</Text>
                      {p.beta && <Text style={styles.tag}>{TEXT.beta}</Text>}
                    </View>
                    <View style={[styles.radio, active && { borderColor: theme.action }]}>{active && <View style={styles.radioFill} />}</View>
                  </Pressable>
                )
              })}
              {provider.secretLabel && (
                <View style={styles.keyBox}>
                  <Text style={styles.eyebrow}>{provider.secretLabel}</Text>
                  <TextInput
                    key={provider.id}
                    style={styles.input}
                    defaultValue={kyw.secrets[provider.id] ?? ''}
                    onChangeText={(v) => void setSecret(provider.id, v)}
                    placeholder={provider.secretHint ?? ''}
                    placeholderTextColor={theme.muted}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    importantForAutofill="no"
                  />
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>{TEXT.saveKey}</Text>
                      <Text style={styles.muted}>{settings.saveKey ? TEXT.saveKeyOn : TEXT.saveKeyOff}</Text>
                    </View>
                    <Switch
                      accessibilityLabel={TEXT.saveKey}
                      value={settings.saveKey}
                      onValueChange={(v) => void updateSettings({ saveKey: v })}
                      trackColor={{ false: theme.track, true: theme.action }}
                      thumbColor={theme.text}
                    />
                  </View>
                  <Text style={styles.muted}>{TEXT.rpcNote}</Text>
                  <Button
                    variant="secondary"
                    title={TEXT.probeButton}
                    busy={probing === provider.id}
                    disabled={!kyw.loaded || probing !== null}
                    onPress={() => void testRpc()}
                  />
                  <View accessibilityLiveRegion="polite" style={{ gap: 4 }}>
                    {probeProblem?.provider === provider.id && <Text style={styles.muted}>{probeProblem.text}</Text>}
                    {report && (
                      <>
                        {probeReportLines(report).map((line) => <Text key={line} style={styles.muted}>{line}</Text>)}
                        <Text style={styles.muted}>{probeTestedText(report.measured_at)}</Text>
                        {reportStale && <Text style={styles.label}>{TEXT.probeStale}</Text>}
                      </>
                    )}
                  </View>
                </View>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  barRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rpcPill: {
    height: 40,
    paddingLeft: 12,
    paddingRight: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.border2,
    backgroundColor: theme.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  rpcCode: { ...mono, color: theme.text, fontSize: 11 },
  tag: { ...mono, color: theme.muted, fontSize: 9, letterSpacing: 0.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: theme.border2, textTransform: 'uppercase' },
  roundBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: theme.border2, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 10 },
  muted: { ...sans, color: theme.muted, fontSize: 12, lineHeight: 17 },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  eyebrow: { ...mono, color: theme.muted, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
  headValue: { ...mono, color: theme.text, fontSize: 13 },
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
  valueRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: 6, paddingTop: 4 },
  value: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  valueMain: { ...figure, color: theme.text, fontSize: 46, lineHeight: 52, fontWeight: '500', letterSpacing: -1.8 },
  valueTail: { ...mono, color: theme.muted, fontSize: 20 },
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
  counters: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4 },
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
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.scrim },
  sheet: {
    maxHeight: '90%',
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderColor: theme.border2,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 10,
  },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: theme.border2, alignSelf: 'center' },
  sheetBody: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32, gap: 8 },
  sheetTitle: { ...sans, color: theme.text, fontSize: 19, fontWeight: '600', letterSpacing: -0.4, marginBottom: 4 },
  prow: {
    height: 56,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
  },
  pcode: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: theme.border2, alignItems: 'center', justifyContent: 'center' },
  pcodeText: { ...mono, color: theme.text, fontSize: 10.5 },
  pname: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 },
  pnameText: { ...sans, color: theme.text, fontSize: 14, fontWeight: '600' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: theme.border2, alignItems: 'center', justifyContent: 'center' },
  radioFill: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.action },
  keyBox: { borderWidth: 1, borderColor: theme.border2, borderRadius: 12, padding: 12, gap: 10, marginTop: 4 },
  input: {
    ...mono,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border2,
    backgroundColor: theme.bg,
    color: theme.text,
    paddingHorizontal: 12,
    fontSize: 12,
  },
}))
