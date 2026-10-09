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
import { clearHistory, updateSettings } from '@/src/kyw/store'
import { INTERVAL_CHOICES_S } from '@/src/kyw/types'
import { useKyw } from '@/src/kyw/useKyw'
import { Button } from '@/src/ui/components'
import { theme } from '@/src/ui/theme'

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
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { flex: 1 }]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: theme.border, true: theme.action }}
        thumbColor={theme.text}
      />
    </View>
  )
}

export default function SettingsScreen() {
  const router = useRouter()
  const { settings } = useKyw()
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
    Alert.alert(TEXT.clear, 'The grid and the counters on this phone are reset.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => void clearHistory() },
    ])

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.row}>
          <Text style={[styles.title, { flex: 1 }]}>{TEXT.settings}</Text>
          <Button variant="secondary" title="Done" onPress={() => router.back()} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{TEXT.background}</Text>
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
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>When to validate</Text>
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
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{TEXT.deviceTitle}</Text>
          {deviceLines(device).map((line) => (
            <Text key={line} style={styles.muted}>
              {line}
            </Text>
          ))}
        </View>

        <View style={styles.card}>
          <Button variant="secondary" title={TEXT.clear} onPress={confirmClear} />
        </View>

        <Text style={styles.muted}>{TEXT.about}</Text>
        <Text style={styles.muted}>
          {TEXT.appName} {Constants.expoConfig?.version ?? ''}
          {SELFTEST_BUILD ? ' (self-test build)' : ''}
        </Text>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, gap: 14 },
  title: { color: theme.text, fontSize: 24, fontWeight: '800' },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1.5, borderRadius: 12, padding: 14, gap: 10 },
  cardTitle: { color: theme.text, fontSize: 17, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { color: theme.text, fontSize: 15, fontWeight: '600' },
  muted: { color: theme.muted, fontSize: 13, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 40,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: theme.border,
    backgroundColor: theme.bg,
  },
  chipActive: { backgroundColor: theme.action, borderColor: theme.action },
  chipText: { color: theme.text, fontSize: 14, fontWeight: '600' },
})
