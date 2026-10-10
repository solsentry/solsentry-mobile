// Self-test builds only. Never imported by a normal release (see app/selftest.tsx).
import React, { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'

import { theme } from '../../ui/theme'
import { KYW_API_BASE } from '../config'
import { runSelfTest, type SelfTestReport, type SelfTestVector } from './run'
import vectors from './vectors.json'

export default function SelfTestScreen() {
  const [report, setReport] = useState<SelfTestReport | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      const r = runSelfTest(vectors as SelfTestVector[])
      // Read from the PC with `adb logcat -s ReactNativeJS`.
      console.log(`KYW_SELFTEST ${JSON.stringify({ ...r, engine: (globalThis as { HermesInternal?: unknown }).HermesInternal ? 'hermes' : 'other' })}`)
      setReport(r)
    }, 50)
    return () => clearTimeout(timer)
  }, [])
  return (
    <SafeAreaView style={styles.safe}>
      {/* This screen is always dark, whatever the app theme. */}
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Vector self-test</Text>
        <Text style={styles.text}>API base: {KYW_API_BASE}</Text>
        {!report && <Text style={styles.text}>Running…</Text>}
        {report && (
          <>
            <Text style={[styles.big, { color: report.passed === report.total ? theme.allow : theme.block }]}>
              {report.passed} / {report.total} vectors match
            </Text>
            <Text style={styles.text}>{report.ms} ms on this device</Text>
            {report.failures.map((f) => (
              <Text key={f} style={[styles.text, { color: theme.block }]}>
                FAILED {f}
              </Text>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, gap: 10 },
  title: { color: theme.text, fontSize: 22, fontWeight: '800' },
  big: { fontSize: 26, fontWeight: '800' },
  text: { color: theme.text, fontSize: 15 },
})
