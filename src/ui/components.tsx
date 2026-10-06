import React from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from './theme'
import type { UiState } from './verdict'

export const ABOUT_TEXT =
  'Risk signals, not guarantees. Unknown addresses produce a warning, not a block. SolSentry never holds your keys; your wallet signs.'

export function Button({
  title,
  onPress,
  disabled,
  busy,
  variant = 'primary',
}: {
  title: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
  variant?: 'primary' | 'secondary'
}) {
  const off = disabled || busy
  const primary = variant === 'primary'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        styles.btn,
        primary ? styles.btnPrimary : styles.btnSecondary,
        off && styles.btnOff,
        pressed && { opacity: 0.85 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? theme.white : theme.accent} />
      ) : (
        <Text style={[styles.btnText, { color: primary ? theme.white : theme.accent }]}>{title}</Text>
      )}
    </Pressable>
  )
}

export function VerdictCard({
  state,
  checkedAt,
  extra,
}: {
  state: UiState
  checkedAt: number
  extra?: string | null
}) {
  const border = state.tone === 'accent' ? theme.accent : theme.stop
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.card, { backgroundColor: state.background, borderColor: border }]}
    >
      <Text style={[styles.cardLabel, { color: state.tone === 'stop' ? theme.white : state.color }]}>
        {state.label.toUpperCase()}
      </Text>
      {!!state.message && <Text style={[styles.cardText, { color: state.textColor }]}>{state.message}</Text>}
      {!!extra && <Text style={[styles.cardText, { color: state.textColor }]}>{extra}</Text>}
      <Text style={[styles.cardTime, { color: state.tone === 'stop' ? theme.white : theme.muted }]}>
        Checked {new Date(checkedAt).toLocaleString()}
      </Text>
    </View>
  )
}

export function Footer() {
  return <Text style={styles.footer}>{ABOUT_TEXT}</Text>
}

export const styles = StyleSheet.create({
  btn: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnPrimary: { backgroundColor: theme.accent },
  btnSecondary: { backgroundColor: theme.white, borderWidth: 1.5, borderColor: theme.accent },
  btnOff: { opacity: 0.4 },
  btnText: { fontSize: 16, fontWeight: '600' },
  card: { borderWidth: 1.5, borderRadius: 12, padding: 16, gap: 6 },
  cardLabel: { fontSize: 20, fontWeight: '800', letterSpacing: 1 },
  cardText: { fontSize: 15, lineHeight: 21 },
  cardTime: { fontSize: 12, marginTop: 4 },
  footer: { color: theme.muted, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingVertical: 16 },
})
