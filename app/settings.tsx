import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import React, { useEffect, useState } from 'react'
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Constants from 'expo-constants'

import * as KywService from '@/modules/kyw-service'
import { SELFTEST_BUILD } from '@/src/kyw/config'
import { TEXT, deviceLines } from '@/src/kyw/copy'
import type { DeviceIdentity } from '@/src/kyw/device'
import { getDevice } from '@/src/kyw/device-runtime'
import { mode } from '@/src/kyw/engine'
import { IntroSheet } from '@/src/kyw/IntroSheet'
import { providerInfo } from '@/src/kyw/providers'
import { clearHistory, updateSettings } from '@/src/kyw/store'
import { INTERVAL_CHOICES_S } from '@/src/kyw/types'
import { useKyw } from '@/src/kyw/useKyw'
import { Button, ScreenBar } from '@/src/ui/components'
import { FadeUp } from '@/src/ui/motion'
import { fonts, makeStyles, useTheme } from '@/src/ui/theme'

function usePower(): KywService.NativePowerState | null {
  const [power, setPower] = useState(() => KywService.powerState())
  useEffect(() => {
    const read = () => setPower(KywService.powerState())
    const timer = setInterval(read, 5000)
    const sub = AppState.addEventListener('change', read)
    return () => {
      clearInterval(timer)
      sub.remove()
    }
  }, [])
  return power
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const theme = useTheme()
  const styles = useStyles()
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { flex: 1 }]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: theme.track, true: theme.action }}
        thumbColor={theme.text}
      />
    </View>
  )
}

export default function SettingsScreen() {
  const router = useRouter()
  const theme = useTheme()
  const styles = useStyles()
  const { settings } = useKyw()
  const [intro, setIntro] = useState(false)
  const [device, setDevice] = useState<DeviceIdentity | null>(null)
  useEffect(() => {
    let live = true
    void getDevice().then((d) => live && setDevice(d))
    return () => {
      live = false
    }
  }, [])
  const power = usePower()
  const service = mode() === 'service'

  const confirmClear = () =>
    Alert.alert(TEXT.clear, 'The grid and the counters on this phone are reset. Your points, SKR and wallet link stay on SolSentry.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => void clearHistory() },
    ])

  return (
    <SafeAreaView style={styles.safe}>
      <ScreenBar title={TEXT.settings} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.body}>
        <FadeUp order={0} style={styles.card}>
          <Text style={styles.eyebrow}>{TEXT.background}</Text>
          <Text style={styles.muted}>{service ? TEXT.backgroundService : TEXT.backgroundInApp}</Text>
          {service && power && (
            <>
              <Text style={styles.label}>{TEXT.battery}</Text>
              <Text style={styles.muted}>
                {power.ignoringBatteryOptimizations ? TEXT.batteryExempt : TEXT.batteryRestricted}
              </Text>
              {!power.ignoringBatteryOptimizations && (
                <Button title={TEXT.batteryButton} onPress={() => KywService.requestBatteryExemption()} />
              )}
            </>
          )}
        </FadeUp>

        <FadeUp order={1} style={styles.card}>
          <Text style={styles.eyebrow}>{TEXT.whenTitle}</Text>
          {service && (
            <>
              <Toggle label={TEXT.wifiOnly} value={settings.wifiOnly} onChange={(v) => void updateSettings({ wifiOnly: v })} />
              <Toggle
                label={TEXT.chargingOnly}
                value={settings.chargingOnly}
                onChange={(v) => void updateSettings({ chargingOnly: v })}
              />
            </>
          )}
          <Toggle label={TEXT.spread} value={settings.spread} onChange={(v) => void updateSettings({ spread: v })} />
          <Text style={styles.muted}>{TEXT.spreadNote}</Text>
          <Text style={styles.label}>{TEXT.interval}</Text>
          <View style={styles.chips}>
            {INTERVAL_CHOICES_S.map((s) => {
              const active = settings.intervalS === s
              return (
                <Pressable
                  key={s}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => void updateSettings({ intervalS: s })}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && { color: theme.ink }]}>{s} s</Text>
                </Pressable>
              )
            })}
          </View>
          {power && (
            <Text style={styles.muted}>
              Now: {power.wifi ? 'Wi-Fi' : power.online ? 'mobile data' : 'offline'} ·{' '}
              {power.charging ? 'charging' : 'on battery'}
              {power.batteryPct !== null ? ` · ${Math.round(power.batteryPct)}%` : ''}
            </Text>
          )}
        </FadeUp>

        <FadeUp order={2} style={styles.card}>
          <Text style={styles.eyebrow}>{TEXT.themeTitle}</Text>
          <View style={styles.chips}>
            {(['dark', 'light'] as const).map((name) => {
              const active = settings.theme === name
              return (
                <Pressable
                  key={name}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => void updateSettings({ theme: name })}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && { color: theme.ink }]}>{name === 'dark' ? TEXT.themeDark : TEXT.themeLight}</Text>
                </Pressable>
              )
            })}
          </View>
        </FadeUp>

        <FadeUp order={3}>
          <Pressable accessibilityRole="button" onPress={() => setIntro(true)} style={styles.card}>
            <View style={styles.linkRow}>
              <Text style={styles.linkText}>{TEXT.howItWorks}</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.muted} />
            </View>
          </Pressable>
        </FadeUp>

        <FadeUp order={3}>
          <Pressable accessibilityRole="button" onPress={() => router.push('/rpc')} style={styles.card}>
            <Text style={styles.eyebrow}>{TEXT.rpcTitle}</Text>
            <View style={styles.linkRow}>
              <Text style={styles.linkText}>{providerInfo(settings.provider).label}</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.muted} />
            </View>
          </Pressable>
        </FadeUp>

        <FadeUp order={3} style={styles.card}>
          <Text style={styles.eyebrow}>{TEXT.deviceTitle}</Text>
          {deviceLines(device).map((line) => (
            <Text key={line} style={styles.muted}>
              {line}
            </Text>
          ))}
        </FadeUp>

        <FadeUp order={4} style={styles.card}>
          <Button variant="secondary" title={TEXT.clear} onPress={confirmClear} />
        </FadeUp>

        <Text style={styles.muted}>{TEXT.about}</Text>
        <Text style={styles.muted}>
          {TEXT.appName} {Constants.expoConfig?.version ?? ''}
          {SELFTEST_BUILD ? ' (self-test build)' : ''}
        </Text>
      </ScrollView>
      <IntroSheet visible={intro} onDone={() => setIntro(false)} />
    </SafeAreaView>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    linkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    linkText: { color: t.text, fontFamily: fonts.body, fontSize: 14, fontWeight: '600' },
    safe: { flex: 1, backgroundColor: t.bg },
    body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 10 },
    card: { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
    eyebrow: { color: t.muted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    label: { color: t.text, fontFamily: fonts.body, fontSize: 14, fontWeight: '600' },
    muted: { color: t.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
      height: 38,
      minWidth: 64,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 14,
      borderRadius: 19,
      borderWidth: 1,
      borderColor: t.border2,
    },
    chipActive: { backgroundColor: t.action, borderColor: t.action },
    chipText: { color: t.text, fontFamily: fonts.body, fontSize: 13, fontWeight: '600' },
  }),
)
