import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import React, { useMemo, useState } from 'react'
import { PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { TEXT, VERDICT_LABEL, formatBytes, resultSentence } from '@/src/kyw/copy'
import { mode, startValidation, statusText, stopValidation } from '@/src/kyw/engine'
import { Grid, VERDICT_COLOR } from '@/src/kyw/Grid'
import { tasksPerHour } from '@/src/kyw/history'
import { PROVIDERS, providerInfo } from '@/src/kyw/providers'
import { setSecret, updateSettings } from '@/src/kyw/store'
import type { Verdict } from '@/src/kyw/types'
import { useKyw } from '@/src/kyw/useKyw'
import { theme } from '@/src/ui/theme'

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
  const kyw = useKyw()
  const { settings, history, running, status } = kyw
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const provider = providerInfo(settings.provider)
  const records = history.records
  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) ?? records[records.length - 1] ?? null,
    [records, selectedId],
  )
  const perHour = tasksPerHour(records, Date.now())

  const toggle = async (next: boolean) => {
    if (!next) return stopValidation()
    if (mode() === 'service') await askNotificationPermission()
    await startValidation()
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{TEXT.appName}</Text>
            <Text style={styles.muted}>{TEXT.tagline}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={TEXT.settings} hitSlop={12} onPress={() => router.push('/settings')}>
            <Ionicons name="settings-outline" size={24} color={theme.text} />
          </Pressable>
        </View>

        <View style={[styles.card, running && { borderColor: theme.action }]}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>
                {TEXT.toggle}: {running ? TEXT.on : TEXT.off}
              </Text>
              <Text accessibilityLiveRegion="polite" style={styles.status}>
                {running ? statusText(status) : statusText({ kind: 'idle' })}
              </Text>
            </View>
            <Switch
              accessibilityLabel={TEXT.toggle}
              value={running}
              disabled={!kyw.loaded}
              onValueChange={(v) => void toggle(v)}
              trackColor={{ false: theme.border, true: theme.action }}
              thumbColor={theme.text}
            />
          </View>
          <View style={styles.counters}>
            {(['accepted', 'diverged', 'unknown'] as Verdict[]).map((v) => (
              <View key={v} style={styles.counter}>
                <View style={[styles.dot, { backgroundColor: VERDICT_COLOR[v] }]} />
                <Text style={styles.counterValue}>{history.counters[v]}</Text>
                <Text style={styles.counterLabel}>{VERDICT_LABEL[v]}</Text>
              </View>
            ))}
          </View>
          {perHour !== null && <Text style={styles.muted}>Recent pace: about {perHour} tasks per hour.</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{TEXT.gridTitle}</Text>
          <Grid records={records} selectedId={selected?.id ?? null} onSelect={(r) => setSelectedId(r.id)} />
          {!selected && <Text style={styles.muted}>{TEXT.gridEmpty}</Text>}
          {selected && (
            <View accessibilityLiveRegion="polite" style={[styles.result, { borderColor: VERDICT_COLOR[selected.verdict] }]}>
              <Text style={styles.resultHead}>
                {VERDICT_LABEL[selected.verdict].toUpperCase()}
                {selected.short ? `  ·  ${selected.short}` : ''}
              </Text>
              <Text style={styles.resultText}>{resultSentence(selected)}</Text>
              <Text style={styles.muted}>
                {new Date(selected.at).toLocaleTimeString()} · {selected.ms} ms · {formatBytes(selected.bytes)} · {selected.host}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{TEXT.rpcTitle}</Text>
          <View style={styles.chips}>
            {PROVIDERS.map((p) => {
              const active = p.id === settings.provider
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => void updateSettings({ provider: p.id })}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && { color: theme.ink }]}>{p.label}</Text>
                  {p.beta && <Text style={[styles.beta, active && { color: theme.ink, borderColor: theme.ink }]}>{TEXT.beta}</Text>}
                </Pressable>
              )
            })}
          </View>
          {provider.secretLabel && (
            <>
              <Text style={styles.label}>{provider.secretLabel}</Text>
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
                  trackColor={{ false: theme.border, true: theme.action }}
                  thumbColor={theme.text}
                />
              </View>
              <Text style={styles.muted}>{TEXT.rpcNote}</Text>
            </>
          )}
        </View>

        <Text style={styles.footer}>{TEXT.explain}</Text>
        <Text style={styles.footer}>{TEXT.about}</Text>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { color: theme.text, fontSize: 24, fontWeight: '800' },
  muted: { color: theme.muted, fontSize: 13, lineHeight: 18 },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1.5, borderRadius: 12, padding: 14, gap: 10 },
  cardTitle: { color: theme.text, fontSize: 17, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  status: { color: theme.text, fontSize: 15, marginTop: 2 },
  counters: { flexDirection: 'row', gap: 16 },
  counter: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 12, height: 12, borderRadius: 3 },
  counterValue: { color: theme.text, fontSize: 17, fontWeight: '700' },
  counterLabel: { color: theme.muted, fontSize: 13 },
  result: { borderWidth: 1.5, borderRadius: 10, padding: 12, gap: 4, backgroundColor: theme.bg },
  resultHead: { color: theme.text, fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  resultText: { color: theme.text, fontSize: 15, lineHeight: 21 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: theme.border,
    backgroundColor: theme.bg,
  },
  chipActive: { backgroundColor: theme.action, borderColor: theme.action },
  chipText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  beta: {
    color: theme.muted,
    fontSize: 10,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: theme.muted,
    borderRadius: 4,
    paddingHorizontal: 4,
    textTransform: 'uppercase',
  },
  label: { color: theme.text, fontSize: 14, fontWeight: '600' },
  input: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: theme.border,
    backgroundColor: theme.bg,
    color: theme.text,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  footer: { color: theme.muted, fontSize: 12, lineHeight: 17 },
})
