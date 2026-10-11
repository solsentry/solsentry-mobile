import * as Linking from 'expo-linking'
import React from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

import { SKR_PAYOUT, solscanTx } from '../config'
import { Button } from '../ui/components'
import { figure, fonts, makeStyles, useTheme } from '../ui/theme'
import { formatSolUp } from './claim'
import type { ClaimOutcome } from './claim-flow'
import { ACCOUNT_TEXT as T } from './copy'
import { formatSkr, skrFigure, type ServerPoints } from './server-points'
import type { useAccount } from './useAccount'

/** The line under the button after a claim, and its Solscan link when a transaction was sent. */
export function outcomeText(o: ClaimOutcome): { text: string; good: boolean; signature?: string } {
  switch (o.kind) {
    case 'paid':
      return { text: T.claimPaid(formatSkr(o.amountRaw)), good: true, signature: o.signature }
    case 'sent':
      return { text: T.claimSent(formatSkr(o.amountRaw)), good: true, signature: o.signature }
    case 'needs_sol':
      return { text: T.needsSol(formatSolUp(o.needLamports)), good: false }
    case 'pool_empty':
      return { text: T.poolEmpty, good: false }
    case 'expired':
      return { text: T.claimExpired, good: false }
    case 'cancelled':
      return { text: T.claimCancelled, good: false }
    case 'wrong_wallet':
      return { text: T.claimWrongWallet, good: false }
    case 'refused':
      return { text: T.claimRefused, good: false }
    case 'below_minimum':
      return { text: T.claimBelowMin, good: false }
    case 'not_linked':
      return { text: T.claimNotLinked, good: false }
    case 'disabled':
    case 'error':
      return { text: T.claimFailed, good: false }
  }
}

/** SKR balance from SolSentry's ledger and the Claim button. Without the server's SKR field: points only, claim not offered. */
export function SkrCard({ account, server }: { account: ReturnType<typeof useAccount>; server: ServerPoints | null }) {
  const theme = useTheme()
  const styles = useStyles()
  const skr = server?.skr ?? null
  const { wallet, claiming, claim, claimSkr } = account
  if (!skr) {
    return (
      <View style={styles.card}>
        <Text style={styles.eyebrow}>{T.skrTitle}</Text>
        <Text style={styles.muted}>{T.skrSoon}</Text>
      </View>
    )
  }
  const out = claim ? outcomeText(claim) : null
  // The server says the claim is off only when asked; after that answer the button goes.
  const canClaim = claim?.kind !== 'disabled'
  const enough = skr.balanceRaw >= skr.minClaimRaw
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{T.skrTitle}</Text>
      <View style={styles.value}>
        <Text style={styles.amount}>{skrFigure(skr.balanceRaw).main}</Text>
        <Text style={[styles.unit, { marginLeft: -4 }]}>{skrFigure(skr.balanceRaw).tail}</Text>
        <Text style={styles.unit}>{T.skrUnit}</Text>
      </View>
      <Text style={styles.muted}>{SKR_PAYOUT === 'daily' ? T.skrServerDaily : T.skrServer}</Text>
      <Text style={styles.muted}>{T.skrWindow(formatSkr(skr.window.earnedRaw), formatSkr(skr.window.capRaw))}</Text>
      <Text style={styles.muted}>{T.skrRate}</Text>
      {skr.pool === 'empty' ? (
        <Text style={styles.warn}>{T.poolEmpty}</Text>
      ) : SKR_PAYOUT === 'daily' ? (
        !wallet && <Text style={styles.warn}>{T.dailyNeedsWallet}</Text>
      ) : !canClaim ? null : !wallet ? (
        <Text style={styles.warn}>{T.claimNeedsWallet}</Text>
      ) : claiming ? (
        <View style={styles.row}>
          <ActivityIndicator color={theme.action} />
          <Text style={styles.muted}>{T.claiming}</Text>
        </View>
      ) : (
        <>
          {skr.openClaim && <Text style={styles.muted}>{T.claimOpen}</Text>}
          <Button title={T.claim} disabled={!enough && !skr.openClaim} onPress={() => void claimSkr()} />
          {!enough && !skr.openClaim && <Text style={styles.muted}>{T.claimMin(formatSkr(skr.minClaimRaw))}</Text>}
          <Text style={styles.muted}>{T.claimFee}</Text>
        </>
      )}
      {out && <Text style={out.good ? styles.good : styles.warn}>{out.text}</Text>}
      {out?.signature && <Button variant="secondary" title={T.viewTx} onPress={() => void Linking.openURL(solscanTx(out.signature!))} />}
    </View>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    card: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
    eyebrow: { color: t.muted, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
    value: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
    amount: { ...figure, color: t.text, fontSize: 46, lineHeight: 52, fontWeight: '500', letterSpacing: -1.8 },
    unit: { color: t.muted, fontFamily: fonts.mono, fontSize: 20 },
    muted: { color: t.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
    warn: { color: t.actionText, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
    good: { color: t.actionText, fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  }),
)
