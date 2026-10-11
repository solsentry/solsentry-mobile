// The mockup's Claim sheet: amount, where it goes, Approve (the wallet signs and sends), then confirming and done.
import Ionicons from '@expo/vector-icons/Ionicons'
import * as Linking from 'expo-linking'
import React from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native'

import { solscanTx } from '../config'
import { figure, fonts, makeStyles, useTheme } from '../ui/theme'
import type { ClaimOutcome } from './claim-flow'
import { ACCOUNT_TEXT as T, HOME_TEXT } from './copy'
import { formatSkr } from './server-points'
import { outcomeText } from './SkrCard'

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

export function ClaimSheet(props: {
  visible: boolean
  onClose: () => void
  amountRaw: bigint
  wallet: string
  walletName: string | null
  claiming: boolean
  outcome: ClaimOutcome | null
  onApprove: () => void
}) {
  const theme = useTheme()
  const styles = useStyles()
  const out = props.outcome ? outcomeText(props.outcome) : null
  const done = props.outcome?.kind === 'paid' || props.outcome?.kind === 'sent'
  // While the wallet is open or the server confirms, the sheet stays: closing it would hide the result.
  const close = () => {
    if (!props.claiming) props.onClose()
  }
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.wrap}>
        <Pressable accessibilityRole="button" accessibilityLabel={HOME_TEXT.close} style={styles.scrim} onPress={close} />
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <View style={styles.head}>
            <Text style={styles.title}>{HOME_TEXT.claimCta}</Text>
            <Text style={styles.amount}>{formatSkr(done && props.outcome && 'amountRaw' in props.outcome ? props.outcome.amountRaw : props.amountRaw)} SKR</Text>
          </View>
          <View style={styles.dest}>
            <Text style={styles.mono}>{HOME_TEXT.claimTo}</Text>
            <Text style={styles.mono}>{props.walletName ?? short(props.wallet)}</Text>
          </View>
          {done ? (
            <View style={styles.ok}>
              <Ionicons name="checkmark" size={16} color={theme.allow} />
              <Text style={styles.okText}>{out?.text}</Text>
            </View>
          ) : props.claiming ? (
            <View style={styles.wait}>
              <ActivityIndicator color={theme.action} />
              <Text style={styles.muted}>{T.claiming}</Text>
            </View>
          ) : (
            <Pressable accessibilityRole="button" onPress={props.onApprove} style={({ pressed }) => [styles.approve, pressed && { opacity: 0.85 }]}>
              <Text style={styles.approveText}>{HOME_TEXT.approve}</Text>
            </Pressable>
          )}
          {out && !done && <Text style={styles.warn}>{out.text}</Text>}
          {out?.signature ? (
            <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(solscanTx(out.signature!))}>
              <Text style={styles.link}>{T.viewTx}</Text>
            </Pressable>
          ) : (
            !done && <Text style={styles.muted}>{T.claimFee}</Text>
          )}
        </View>
      </View>
    </Modal>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    wrap: { flex: 1, justifyContent: 'flex-end' },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: t.scrim },
    sheet: {
      backgroundColor: t.surface,
      borderTopWidth: 1,
      borderColor: t.border2,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 28,
      gap: 14,
    },
    grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: t.border2, alignSelf: 'center' },
    head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
    title: { color: t.text, fontFamily: fonts.body, fontSize: 19, fontWeight: '600', letterSpacing: -0.4 },
    amount: { ...figure, color: t.text, fontFamily: fonts.mono, fontSize: 22, fontWeight: '500' },
    dest: { flexDirection: 'row', justifyContent: 'space-between' },
    mono: { color: t.muted, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase' },
    approve: { height: 50, borderRadius: 10, backgroundColor: t.action, alignItems: 'center', justifyContent: 'center' },
    approveText: { color: t.ink, fontFamily: fonts.body, fontSize: 14.5, fontWeight: '600' },
    wait: { height: 50, borderRadius: 10, borderWidth: 1, borderColor: t.border2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
    ok: { minHeight: 50, borderRadius: 10, backgroundColor: t.name === 'dark' ? 'rgba(95,209,180,0.12)' : 'rgba(31,122,102,0.10)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12 },
    okText: { color: t.allow, fontFamily: fonts.body, fontSize: 14, fontWeight: '600', flexShrink: 1 },
    muted: { color: t.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
    warn: { color: t.actionText, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
    link: { color: t.actionText, fontFamily: fonts.mono, fontSize: 12, textDecorationLine: 'underline' },
  }),
)
