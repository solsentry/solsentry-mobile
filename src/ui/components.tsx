import React from 'react'
import Ionicons from '@expo/vector-icons/Ionicons'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { theme } from './theme'
import type { UiState } from './verdict'

export const ABOUT_TEXT =
  'Risk signals, not guarantees. Allow means no risk signal was found, not that the recipient is safe. An address with no on-chain history shows as a Warning. SolSentry never holds your keys; your wallet signs.'

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
        <ActivityIndicator color={primary ? theme.ink : theme.action} />
      ) : (
        <Text style={[styles.btnText, { color: primary ? theme.ink : theme.action }]}>{title}</Text>
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
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.card, { backgroundColor: state.background, borderColor: state.color }]}
    >
      <VerdictBadge state={state} large />
      {!!state.message && <Text style={[styles.cardText, { color: state.textColor }]}>{state.message}</Text>}
      {!!extra && <Text style={[styles.cardText, { color: state.textColor }]}>{extra}</Text>}
      <Text style={[styles.cardTime, { color: state.tone === 'stop' ? state.textColor : theme.muted }]}>
        Checked {new Date(checkedAt).toLocaleString()}
      </Text>
    </View>
  )
}

/** Decision as icon + word on the verdict color. */
export function VerdictBadge({ state, large }: { state: UiState; large?: boolean }) {
  return (
    <View style={[styles.badge, { backgroundColor: state.color }]}>
      <Ionicons name={state.icon} size={large ? 22 : 16} color={state.onColor} />
      <Text style={[large ? styles.cardLabel : styles.badgeText, { color: state.onColor }]}>
        {state.label.toUpperCase()}
      </Text>
    </View>
  )
}

export function Footer() {
  return <Text style={styles.footer}>{ABOUT_TEXT}</Text>
}

export const styles = StyleSheet.create({
  btn: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnPrimary: { backgroundColor: theme.action },
  btnSecondary: { backgroundColor: theme.surface, borderWidth: 1.5, borderColor: theme.action },
  btnOff: { opacity: 0.4 },
  btnText: { fontSize: 16, fontWeight: '600' },
  card: { borderWidth: 1.5, borderRadius: 12, padding: 16, gap: 6 },
  cardLabel: { fontSize: 20, fontWeight: '800', letterSpacing: 1 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  cardText: { fontSize: 15, lineHeight: 21 },
  cardTime: { fontSize: 12, marginTop: 4 },
  footer: { color: theme.muted, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingVertical: 16 },
})
