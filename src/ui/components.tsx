import React from 'react'
import Ionicons from '@expo/vector-icons/Ionicons'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { fonts, makeStyles, theme, useTheme } from './theme'
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
  const t = useTheme()
  const b = useButtonStyles()
  const off = disabled || busy
  const primary = variant === 'primary'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [b.btn, primary ? b.primary : b.secondary, off && styles.btnOff, pressed && { opacity: 0.85 }]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? t.ink : t.text} />
      ) : (
        <Text style={[styles.btnText, { color: primary ? t.ink : t.text }]}>{title}</Text>
      )}
    </Pressable>
  )
}

// Mockup buttons: filled orange for the main action, outlined in the strong line for the rest.
const useButtonStyles = makeStyles((t) =>
  StyleSheet.create({
    btn: { minHeight: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    primary: { backgroundColor: t.action },
    secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: t.border2 },
    bar: { height: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
    round: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: t.border2, alignItems: 'center', justifyContent: 'center' },
    barTitle: { flex: 1, color: t.text, fontFamily: fonts.title, fontSize: 15, fontWeight: '600', letterSpacing: -0.3 },
  }),
)

/** Top bar of an inner screen: round back button and the title, as the home app bar. */
export function ScreenBar({ title, onBack, right }: { title: string; onBack: () => void; right?: React.ReactNode }) {
  const t = useTheme()
  const b = useButtonStyles()
  return (
    <View style={b.bar}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={6} style={b.round}>
        <Ionicons name="chevron-back" size={17} color={t.text} />
      </Pressable>
      <Text style={b.barTitle}>{title}</Text>
      {right}
    </View>
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
  btnText: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600' },
  card: { borderWidth: 1.5, borderRadius: 12, padding: 16, gap: 6 },
  cardLabel: { fontFamily: fonts.body, fontSize: 20, fontWeight: '800', letterSpacing: 1 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { fontFamily: fonts.body, fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  cardText: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  cardTime: { fontFamily: fonts.body, fontSize: 12, marginTop: 4 },
  footer: { color: theme.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingVertical: 16 },
})
