import * as Linking from 'expo-linking'
import { Redirect } from 'expo-router'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { REVOKE_ENABLED, RPC_URL, solscanTx } from '@/src/config'
import { APPROVALS_TEXT, confirmText, kindLabel } from '@/src/revoke/copy'
import { fetchDelegations, type Delegation } from '@/src/revoke/delegations'
import { useWalletState } from '@/src/state/wallet'
import { Button } from '@/src/ui/components'
import { describeError } from '@/src/ui/errors'
import { theme } from '@/src/ui/theme'
import { revokeApproval } from '@/src/wallet/mwa'

type Load = { status: 'loading' } | { status: 'error'; detail: string } | { status: 'ready'; rows: Delegation[] }
type Outcome = { tone: 'ok' | 'note'; text: string; signature?: string; detail?: string }

export default function Approvals() {
  if (!REVOKE_ENABLED) return <Redirect href="/" />
  return <ApprovalsScreen />
}

function ApprovalsScreen() {
  const wallet = useWalletState()
  const owner = wallet.session?.address ?? null
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  /** Token account waiting for the user's confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** Token account whose revoke is with the wallet or being confirmed on chain. */
  const [revoking, setRevoking] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  // React state lags a render behind a fast double tap; a ref does not.
  const inFlight = useRef(false)
  const loadRun = useRef(0)

  const refresh = useCallback(async (address: string) => {
    const run = ++loadRun.current
    setLoad({ status: 'loading' })
    try {
      const rows = await fetchDelegations(address, RPC_URL)
      if (run === loadRun.current) setLoad({ status: 'ready', rows })
    } catch (e) {
      if (run === loadRun.current) setLoad({ status: 'error', detail: (e as Error)?.message ?? String(e) })
    }
  }, [])

  useEffect(() => {
    setConfirming(null)
    setOutcome(null)
    if (owner) void refresh(owner)
  }, [owner, refresh])

  async function once(fn: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await fn()
    } finally {
      inFlight.current = false
    }
  }

  const onConnect = () =>
    once(async () => {
      setConnectError(null)
      try {
        await wallet.connect()
      } catch (e) {
        setConnectError(describeError(e, 'connect').message)
      }
    })

  const onRevoke = (d: Delegation) =>
    once(async () => {
      if (!owner) return
      setConfirming(null)
      setOutcome(null)
      setRevoking(d.account)
      try {
        const r = await revokeApproval(d, owner, wallet.session?.authToken, {
          onSession: (s) => {
            // Keep a fresh token for the listed wallet; another account must not replace the list mid-revoke.
            if (s.address === owner) wallet.setSession(s)
          },
          onTokenRejected: wallet.forgetToken,
        })
        if (r.status === 'revoked') setOutcome({ tone: 'ok', text: APPROVALS_TEXT.success, signature: r.signature })
        else if (r.status === 'cancelled') setOutcome({ tone: 'note', text: APPROVALS_TEXT.cancelled })
        else setOutcome({ tone: 'note', text: APPROVALS_TEXT.unconfirmed, signature: r.signature, detail: r.detail })
        if (r.status !== 'cancelled') await refresh(owner)
      } catch (e) {
        // Thrown only before the wallet was asked to sign: nothing was sent.
        const err = describeError(e, 'revoke')
        setOutcome({ tone: 'note', text: err.message, detail: err.detail })
      } finally {
        setRevoking(null)
      }
    })

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.h1}>{APPROVALS_TEXT.header}</Text>
        <Text style={styles.sub}>{APPROVALS_TEXT.subheader}</Text>

        {!owner ? (
          <>
            <Text style={styles.text}>{APPROVALS_TEXT.notConnected}</Text>
            <Button title="Connect wallet" onPress={onConnect} />
            {!!connectError && <Text style={styles.note}>{connectError}</Text>}
          </>
        ) : (
          <>
            {outcome && (
              <View accessibilityLiveRegion="polite" style={[styles.box, outcome.tone === 'ok' && styles.boxOk]}>
                <Text style={styles.boxTitle}>{outcome.text}</Text>
                {!!outcome.detail && <Text style={styles.detail}>{outcome.detail}</Text>}
                {!!outcome.signature && (
                  <Button
                    variant="secondary"
                    title="Open on Solscan"
                    onPress={() => Linking.openURL(solscanTx(outcome.signature as string))}
                  />
                )}
              </View>
            )}

            {load.status === 'loading' && <ActivityIndicator color={theme.action} style={styles.spinner} />}

            {load.status === 'error' && (
              <View accessibilityLiveRegion="polite" style={styles.box}>
                <Text style={styles.boxTitle}>{APPROVALS_TEXT.error}</Text>
                <Text style={styles.detail}>{load.detail}</Text>
                <Button variant="secondary" title="Try again" onPress={() => void refresh(owner)} />
              </View>
            )}

            {load.status === 'ready' && load.rows.length === 0 && <Text style={styles.text}>{APPROVALS_TEXT.empty}</Text>}

            {load.status === 'ready' &&
              load.rows.map((d) => {
                const badge = kindLabel(d)
                return (
                  <View key={d.account} style={styles.row}>
                    {badge ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{badge.toUpperCase()}</Text>
                      </View>
                    ) : (
                      <Text style={styles.amount}>Approved amount: {d.delegatedUi}</Text>
                    )}
                    <Text style={styles.label}>Can be moved by</Text>
                    <Text selectable style={styles.mono}>{d.delegate}</Text>
                    <Text style={styles.label}>Token</Text>
                    <Text selectable style={styles.mono}>{d.mint}</Text>
                    {d.frozen ? (
                      <Text style={styles.note}>{APPROVALS_TEXT.frozen}</Text>
                    ) : confirming === d.account ? (
                      <>
                        <Text style={styles.text}>{confirmText(d)}</Text>
                        <View style={styles.actions}>
                          <View style={styles.action}>
                            <Button title={APPROVALS_TEXT.revoke} onPress={() => onRevoke(d)} disabled={!!revoking} />
                          </View>
                          <View style={styles.action}>
                            <Button variant="secondary" title="Cancel" onPress={() => setConfirming(null)} />
                          </View>
                        </View>
                      </>
                    ) : (
                      <Button
                        title={APPROVALS_TEXT.revoke}
                        busy={revoking === d.account}
                        disabled={!!revoking}
                        onPress={() => setConfirming(d.account)}
                      />
                    )}
                  </View>
                )
              })}

            {load.status !== 'loading' && !revoking && (
              <Button variant="secondary" title="Refresh" onPress={() => void refresh(owner)} />
            )}
          </>
        )}

        <Text style={styles.footnote}>{APPROVALS_TEXT.footnote}</Text>
      </ScrollView>
    </SafeAreaView>
  )
}

const mono = Platform.select({ android: 'monospace', default: 'Courier' })

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, gap: 12 },
  h1: { color: theme.text, fontSize: 22, fontWeight: '800', lineHeight: 28 },
  sub: { color: theme.muted, fontSize: 14, lineHeight: 20 },
  text: { color: theme.text, fontSize: 15, lineHeight: 21 },
  note: { color: theme.warn, fontSize: 14, fontWeight: '600' },
  spinner: { paddingVertical: 24 },
  box: { borderColor: theme.warn, borderWidth: 1.5, borderRadius: 12, padding: 14, gap: 8, backgroundColor: theme.surface },
  boxOk: { borderColor: theme.allow },
  boxTitle: { color: theme.text, fontSize: 15, fontWeight: '700', lineHeight: 21 },
  detail: { color: theme.muted, fontSize: 12, fontFamily: mono },
  row: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 12, padding: 14, gap: 6 },
  badge: { alignSelf: 'flex-start', backgroundColor: theme.warn, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { color: theme.ink, fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  amount: { color: theme.text, fontSize: 15, fontWeight: '700' },
  label: { color: theme.muted, fontSize: 12, marginTop: 2 },
  mono: { color: theme.text, fontFamily: mono, fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  action: { flex: 1 },
  footnote: { color: theme.muted, fontSize: 12, lineHeight: 17, textAlign: 'center', paddingVertical: 16 },
})
