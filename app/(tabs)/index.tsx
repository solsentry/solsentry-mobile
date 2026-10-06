import Clipboard from '@react-native-clipboard/clipboard'
import { PublicKey } from '@solana/web3.js'
import * as Linking from 'expo-linking'
import { useLocalSearchParams } from 'expo-router'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { solscanTx, VERDICT_MAX_AGE_MS } from '@/src/config'
import type { RecipientVerdict, SenderVerdict } from '@/src/guard/checks'
import { runRecipientCheck, runSenderCheck } from '@/src/guard/service'
import { useHistory } from '@/src/state/history'
import { useWalletState } from '@/src/state/wallet'
import { Button, Footer, VerdictCard } from '@/src/ui/components'
import { theme } from '@/src/ui/theme'
import { sendEnabled, toUiState } from '@/src/ui/verdict'
import { sendSol } from '@/src/wallet/mwa'
import { formatLamportsAsSol, parseSolToLamports } from '@/src/wallet/mwa-math'

function isValidAddress(s: string): boolean {
  try {
    return new PublicKey(s).toBytes().length === 32
  } catch {
    return false
  }
}

function short(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-6)}`
}

function fundingLine(v: SenderVerdict): string | null {
  if (v.funding?.status === 'found') return `First funder (one hop back): ${v.funding.funder}`
  if (v.funding?.status === 'unknown') return `First funder: not determined (${v.funding.reason.toLowerCase().replace(/_/g, ' ')}).`
  return null
}

export default function CheckAndSend() {
  const params = useLocalSearchParams<{ address?: string }>()
  const { record } = useHistory()
  const wallet = useWalletState()

  const [address, setAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [verdict, setVerdict] = useState<RecipientVerdict | null>(null)
  const [checkedFor, setCheckedFor] = useState('')
  const [checkedAt, setCheckedAt] = useState(0)
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState<null | 'check' | 'send' | 'connect' | 'sender'>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<{ signature: string } | null>(null)
  const [senderVerdict, setSenderVerdict] = useState<SenderVerdict | null>(null)
  const [senderAt, setSenderAt] = useState(0)

  useEffect(() => {
    if (params.address && params.address !== address) {
      setAddress(params.address)
      resetResult()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.address])

  function resetResult() {
    setVerdict(null)
    setReviewed(false)
    setError(null)
    setSent(null)
  }

  const trimmed = address.trim()
  const ui = useMemo(() => (verdict ? toUiState(verdict) : null), [verdict])
  const parsedAmount = useMemo(() => {
    try {
      return parseSolToLamports(amount)
    } catch {
      return null
    }
  }, [amount])
  const verdictIsCurrent =!!verdict && checkedFor === trimmed

  // React state (busy) lags a render behind a fast double tap; a ref does not.
  const inFlight = useRef(false)

  async function once(fn: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await fn()
    } finally {
      inFlight.current = false
    }
  }

  const onCheck = () => once(doCheck)
  const onSend = () => once(doSend)

  async function doCheck() {
    setError(null)
    setSent(null)
    setReviewed(false)
    if (!isValidAddress(trimmed)) {
      setVerdict(null)
      setError('That is not a valid Solana address (base58, 32 bytes).')
      return
    }
    setBusy('check')
    const v = await runRecipientCheck(trimmed) // never throws; errors come back as "block"
    const now = Date.now()
    setVerdict(v)
    setCheckedFor(trimmed)
    setCheckedAt(now)
    record({ address: trimmed, decision: toUiState(v).decision, explanation: v.explanation, checkedAt: now })
    setBusy(null)
  }

  async function doSend() {
    setError(null)
    if (!ui || !verdict || !verdictIsCurrent) {
      setError('Check this address first.')
      return
    }
    if (Date.now() - checkedAt > VERDICT_MAX_AGE_MS) {
      setError('This check is out of date. Run it again before sending.')
      return
    }
    if (!sendEnabled(ui, reviewed, false)) return
    let lamports: bigint
    try {
      lamports = parseSolToLamports(amount)
    } catch (e) {
      setError((e as Error).message)
      return
    }
    setBusy('send')
    try {
      const r = await sendSol(trimmed, lamports, checkedAt, wallet.session?.authToken)
      wallet.setSession(r.session)
      setSent({ signature: r.signature })
    } catch (e) {
      setError(`Send did not complete: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function onConnect() {
    setError(null)
    setBusy('connect')
    try {
      await wallet.connect()
    } catch (e) {
      setError(`Could not connect a wallet: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function onSenderCheck() {
    if (!wallet.session) return
    setBusy('sender')
    setSenderVerdict(await runSenderCheck(wallet.session.address))
    setSenderAt(Date.now())
    setBusy(null)
  }

  const senderUi = senderVerdict ? toUiState(senderVerdict) : null
  const canPress = ui ? sendEnabled(ui, reviewed, busy !== null) && verdictIsCurrent : false

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.h1}>Know who gets paid before the money moves.</Text>

          <Text style={styles.label}>Recipient address</Text>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={(t) => {
              setAddress(t)
              resetResult()
            }}
            placeholder="Paste a Solana address"
            placeholderTextColor={theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <Button
            variant="secondary"
            title="Paste from clipboard"
            onPress={async () => {
              const t = await Clipboard.getString()
              if (t) {
                setAddress(t.trim())
                resetResult()
              }
            }}
          />

          <Text style={styles.label}>Amount (SOL)</Text>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            placeholder="0.05"
            placeholderTextColor={theme.muted}
            keyboardType="decimal-pad"
          />
          {parsedAmount !== null && <Text style={styles.hint}>You will send {formatLamportsAsSol(parsedAmount)} SOL</Text>}

          <Button title="Check recipient" onPress={onCheck} busy={busy === 'check'} disabled={busy !== null || !trimmed} />

          {error && <Text style={styles.error}>{error}</Text>}

          {ui && verdict && verdictIsCurrent && (
            <>
              <VerdictCard state={ui} checkedAt={checkedAt} />
              {ui.requiresReview && (
                <View style={styles.reviewRow}>
                  <Switch
                    value={reviewed}
                    onValueChange={setReviewed}
                    trackColor={{ true: theme.accent, false: theme.border }}
                    thumbColor={theme.white}
                  />
                  <Text style={styles.reviewText}>I reviewed this recipient</Text>
                </View>
              )}
              {ui.stoppedText ? (
                <Text style={styles.stopped}>{ui.stoppedText}</Text>
              ) : (
                <Button title="Send with wallet" onPress={onSend} busy={busy === 'send'} disabled={!canPress} />
              )}
            </>
          )}

          {sent && (
            <View style={styles.sentBox}>
              <Text style={styles.sentTitle}>Submitted. Signature</Text>
              <Text selectable style={styles.mono}>{sent.signature}</Text>
              <Button variant="secondary" title="Open on Solscan" onPress={() => Linking.openURL(solscanTx(sent.signature))} />
            </View>
          )}

          <View style={styles.divider} />
          <Text style={styles.h2}>Your wallet</Text>
          {wallet.session ? (
            <>
              <Text style={styles.mono}>Connected: {short(wallet.session.address)}</Text>
              <Button
                variant="secondary"
                title="Where did my money come from?"
                onPress={onSenderCheck}
                busy={busy === 'sender'}
                disabled={busy !== null}
              />
              {senderUi && senderVerdict && (
                <VerdictCard state={senderUi} checkedAt={senderAt} extra={fundingLine(senderVerdict)} />
              )}
            </>
          ) : (
            <Button variant="secondary" title="Connect wallet" onPress={onConnect} busy={busy === 'connect'} disabled={busy !== null} />
          )}

          <Footer />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, gap: 12 },
  h1: { color: theme.text, fontSize: 22, fontWeight: '800', lineHeight: 28 },
  h2: { color: theme.text, fontSize: 17, fontWeight: '700' },
  label: { color: theme.text, fontSize: 14, fontWeight: '600', marginTop: 4 },
  input: {
    backgroundColor: theme.white,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: theme.text,
  },
  hint: { color: theme.muted, fontSize: 13 },
  error: { color: theme.stop, fontSize: 14, lineHeight: 20 },
  stopped: { color: theme.stop, fontSize: 15, fontWeight: '700' },
  reviewRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  reviewText: { color: theme.text, fontSize: 15, flex: 1 },
  sentBox: { backgroundColor: theme.accentTint, borderRadius: 12, padding: 14, gap: 8 },
  sentTitle: { color: theme.text, fontWeight: '700' },
  mono: { color: theme.text, fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }), fontSize: 12 },
  divider: { height: 1, backgroundColor: theme.border, marginVertical: 8 },
})
