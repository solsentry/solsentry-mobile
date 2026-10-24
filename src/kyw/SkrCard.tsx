import * as Linking from 'expo-linking'
import React from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

import { SKR_PAYOUT, solscanTx } from '../config'
import { Button } from '../ui/components'
import { figure, fonts, makeStyles, useTheme } from '../ui/theme'
import { formatSolUp } from './claim'
import type { ClaimOutcome } from './claim-flow'
import { ACCOUNT_TEXT as T } from './copy'
import { formatServerPoints, formatSkr, heldSkr, skrClosed, skrFigure, type ServerPoints } from './server-points'
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
export function SkrCard({ account, server, onClaim }: { account: ReturnType<typeof useAccount>; server: ServerPoints | null; onClaim?: () => void }) {
  const theme = useTheme()
  const styles = useStyles()
  const skr = server?.skr ?? null
  const { wallet, claiming, claim, cancelled, claimSkr } = account
  // No SKR for this phone (not sent yet, or Genesis only): the Account screen shows points instead.
  if (!skr || skrClosed(skr)) return null
  const out = claim ? outcomeText(claim) : null
  // The server says the claim is off only when asked; after that answer the button goes.
  const canClaim = claim?.kind !== 'disabled'
  const enough = skr.balanceRaw >= skr.minClaimRaw
  // SKR held by an unsent claim still belongs to the wallet: the figure keeps it and the line below says so.
  const held = heldSkr(skr, cancelled)
  const shown = skr.balanceRaw + (held ?? 0n)
  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Text style={styles.eyebrow}>{T.rewardsTitle}</Text>
        <Text style={styles.chip}>{T.skrWindow(formatSkr(skr.window.earnedRaw), formatSkr(skr.window.capRaw))}</Text>
      </View>
      <View style={styles.value}>
        <Text style={styles.amount}>{skrFigure(shown).main}</Text>
        <Text style={[styles.unit, { marginLeft: -4 }]}>{skrFigure(shown).tail}</Text>
        <Text style={styles.unit}>{T.skrUnit}</Text>
      </View>
      <Text style={styles.muted}>{SKR_PAYOUT === 'later' ? T.skrServerLater : T.skrServer}</Text>
      {server && (
        <Text style={styles.muted}>
          {T.pointsSplit(formatServerPoints(server.points), server.wallet?.points != null ? formatServerPoints(server.wallet.points) : null)}
        </Text>
      )}
      {skr.pool === 'empty' ? (
        <Text style={styles.warn}>{T.poolEmpty}</Text>
      ) : SKR_PAYOUT === 'later' ? (
        !wallet && <Text style={styles.warn}>{T.laterNeedsWallet}</Text>
      ) : !canClaim ? null : !wallet ? (
        <Text style={styles.warn}>{T.claimNeedsWallet}</Text>
      ) : claiming ? (
        <View style={styles.row}>
          <ActivityIndicator color={theme.action} />
          <Text style={styles.muted}>{T.claiming}</Text>
        </View>
      ) : (
        <>
          {skr.openClaim && <Text style={styles.muted}>{held !== null ? T.claimHeld(formatSkr(held)) : T.claimOpen}</Text>}
          <Button title={T.claim} disabled={!enough && !skr.openClaim} onPress={() => (onClaim ? onClaim() : void claimSkr())} />
          {!enough && !skr.openClaim && <Text style={styles.muted}>{T.claimMin(formatSkr(skr.minClaimRaw))}</Text>}
          {(enough || skr.openClaim) && <Text style={styles.muted}>{T.claimFee}</Text>}
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
    headRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
    chip: { color: t.actionText, fontFamily: fonts.mono, fontSize: 11 },
  }),
)
