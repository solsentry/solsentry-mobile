// Settings card: where the reads go. SolSentry by default, or the user's own RPC URL, tested by a signed probe.
import Constants from 'expo-constants'
import React, { useEffect, useRef, useState } from 'react'
import { Alert, AppState, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'

import { Button } from '../ui/components'
import { fonts, makeStyles, useTheme } from '../ui/theme'
import { KYW_API_BASE } from './config'
import { TEXT, probeProblemText, probeReportLines, probeTestedText, switchProviderPrompt } from './copy'
import { getDevice, signMessageWithDevice } from './device-runtime'
import { chosenRpcProbeIsStale, probeChosenRpc, submitProbe } from './probe-client'
import { PROVIDER_CHOICES, providerInfo, type ProviderId } from './providers'
import { getState, recordProbeReport, setSecret, updateSettings } from './store'
import { useKyw } from './useKyw'

export function RpcSection({ showTitle = true }: { showTitle?: boolean }) {
  const theme = useTheme()
  const styles = useStyles()
  const kyw = useKyw()
  const { settings, running } = kyw
  const provider = providerInfo(settings.provider)
  const [probing, setProbing] = useState<ProviderId | null>(null)
  const probeInFlight = useRef(false)
  const [probeProblem, setProbeProblem] = useState<{ provider: ProviderId; text: string } | null>(null)
  const [now, setNow] = useState(Date.now)
  const report = kyw.probeReports[provider.id]
  // The field is a draft: tasks read only what was committed (end of editing, Test, leaving the screen),
  // never a half-typed URL.
  const saved = kyw.secrets[provider.id] ?? ''
  const [draft, setDraft] = useState(saved)
  const draftRef = useRef({ id: provider.id, value: saved })
  useEffect(() => {
    setDraft(saved)
    draftRef.current = { id: provider.id, value: saved }
    // Only when the provider changes: a commit of this draft must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id])
  const commit = async (): Promise<string> => {
    const { id, value } = draftRef.current
    if ((getState().secrets[id] ?? '') !== value) await setSecret(id, value)
    return value
  }
  // Leaving the screen commits what was typed.
  useEffect(() => () => void commit(), [])
  const reportStale = chosenRpcProbeIsStale(report ?? null, provider.id, kyw.secrets[provider.id] ?? '', now)

  useEffect(() => {
    const refresh = () => setNow(Date.now())
    const timer = setInterval(refresh, 30_000)
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh()
    })
    return () => {
      clearInterval(timer)
      subscription.remove()
    }
  }, [])

  // A tap on the other choice while validation runs asks first: an accidental tap must not move the
  // reads (and the user's URL) without the user seeing it.
  const choose = (id: ProviderId) => {
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
    const secret = await commit()
    try {
      const result = await probeChosenRpc({
        fetch,
        apiBase: KYW_API_BASE,
        provider: id,
        secret,
        clientVersion: Constants.expoConfig?.version ?? '0',
      })
      // The key or URL changed while the test ran: this result describes the old one.
      if ((getState().secrets[id] ?? '') !== secret) return
      if (!result.ok) setProbeProblem({ provider: id, text: probeProblemText(result.problem) })
      else if (result.kind === 'report') {
        await recordProbeReport(id, result.report)
        // The bonus counts only once SolSentry holds the signed report.
        const device = await getDevice()
        const sent = await submitProbe({
          fetch,
          apiBase: KYW_API_BASE,
          report: result.report,
          deviceKeyId: device.kind === 'key' ? device.id : null,
          signWithDevice: signMessageWithDevice(device),
        })
        if (!sent.ok || !sent.signed) setProbeProblem({ provider: id, text: TEXT.probeNotSent })
      }
    } finally {
      setNow(Date.now())
      setProbing(null)
      probeInFlight.current = false
    }
  }

  // An install that saved a named provider before keeps it until the user picks one of these two.
  const choices = PROVIDER_CHOICES.includes(provider.id) ? PROVIDER_CHOICES : [...PROVIDER_CHOICES, provider.id]

  return (
    <View style={{ gap: 10 }}>
      {showTitle && <Text style={styles.eyebrow}>{TEXT.rpcTitle}</Text>}
      <Text style={styles.muted}>{TEXT.rpcInfo}</Text>
      {choices.map((id) => {
        const p = providerInfo(id)
        const active = id === settings.provider
        return (
          <Pressable
            key={id}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            onPress={() => choose(id)}
            style={[styles.prow, active && { borderColor: theme.action }]}
          >
            <Text style={styles.pname}>{p.label}</Text>
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
            value={draft}
            onChangeText={(v) => {
              setDraft(v)
              draftRef.current = { id: provider.id, value: v }
            }}
            onEndEditing={() => void commit()}
            onSubmitEditing={() => void commit()}
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
    </View>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    eyebrow: { color: t.muted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
    muted: { color: t.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
    label: { color: t.text, fontFamily: fonts.body, fontSize: 14, fontWeight: '600' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    prow: {
      height: 52,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.surface2,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
    },
    pname: { flex: 1, color: t.text, fontFamily: fonts.body, fontSize: 14, fontWeight: '600' },
    radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: t.border2, alignItems: 'center', justifyContent: 'center' },
    radioFill: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.action },
    keyBox: { borderWidth: 1, borderColor: t.border2, borderRadius: 12, padding: 12, gap: 10 },
    input: {
      fontFamily: fonts.mono,
      height: 44,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: t.border2,
      backgroundColor: t.bg,
      color: t.text,
      paddingHorizontal: 12,
      fontSize: 12,
    },
  }),
)
