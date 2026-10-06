import Clipboard from '@react-native-clipboard/clipboard'
import * as Linking from 'expo-linking'
import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { DEVICE_CHECK_ENABLED, NAME_RPC_URL, SNS_PROXY_URL, solscanTx, VERDICT_MAX_AGE_MS } from '@/src/config'
import { DeviceCheckSection } from '@/src/device/DeviceCheckSection'
import type { RecipientVerdict, SenderVerdict } from '@/src/guard/checks'
import { runRecipientCheck, runSenderCheck } from '@/src/guard/service'
import type { ResolveDeps } from '@/src/pay/names'
import { nameBlockVerdict, resolveRecipientInput } from '@/src/pay/recipient'
import { parseScanned, unsupportedReason, type SolanaPayRequest } from '@/src/pay/solana-pay'
import { useHistory } from '@/src/state/history'
import { useWalletState } from '@/src/state/wallet'
import { Button, Footer, VerdictCard } from '@/src/ui/components'
import { theme } from '@/src/ui/theme'
import { sendEnabled, toUiState } from '@/src/ui/verdict'
import { sendSol } from '@/src/wallet/mwa'
import { formatLamportsAsSol, parseSolToLamports } from '@/src/wallet/mwa-math'

const NAME_DEPS: ResolveDeps = { fetch: (u, i) => globalThis.fetch(u, i), rpcUrl: NAME_RPC_URL, snsProxyUrl: SNS_PROXY_URL }

/** Name the recipient field resolved to at check time; the verdict is for `address`. */
interface ResolvedName {
  name: string
  address: string
  source: string
}

function short(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-6)}`
}

function fundingLine(v: SenderVerdict): string | null {
  if (v.funding?.status === 'found') return `First funder (one hop back): ${v.funding.funder}`
  if (v.funding?.status === 'unknown') return `First funder: not determined (${v.funding.reason.toLowerCase().replace(/_/g, ' ')}).`
  return null
}

const CLIP_LEN = 80

function clip(text: string): string {
  return text.length > CLIP_LEN ? `${text.slice(0, CLIP_LEN)}…` : text
}

export default function CheckAndSend() {
  const params = useLocalSearchParams<{ address?: string; pay?: string; t?: string }>()
  const router = useRouter()
  const { record, entries } = useHistory()
  const wallet = useWalletState()

  const [address, setAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [verdict, setVerdict] = useState<RecipientVerdict | null>(null)
  const [checkedFor, setCheckedFor] = useState('')
  /** The address the verdict is for (the resolved one when the field holds a name). */
  const [checkedTarget, setCheckedTarget] = useState('')
  const [resolved, setResolved] = useState<ResolvedName | null>(null)
  /** Solana Pay request that filled the form; cleared when the recipient is edited. */
  const [payRequest, setPayRequest] = useState<SolanaPayRequest | null>(null)
  const lastPay = useRef('')
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
      setPayRequest(null)
      resetResult()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.address])

  // A scanned QR or an opened solana: link arrives as ?pay=<data>&t=<nonce>.
  useEffect(() => {
    const key = `${params.t ?? ''}|${params.pay ?? ''}`
    if (!params.pay || key === lastPay.current) return
    lastPay.current = key
    applyScanned(params.pay)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.pay, params.t])

  function resetResult() {
    setVerdict(null)
    setResolved(null)
    setReviewed(false)
    setError(null)
    setSent(null)
  }

  /** Fill the form from a QR / link and run the recipient check. It never skips the check. */
  function applyScanned(data: string) {
    const parsed = parseScanned(data)
    resetResult()
    if (!parsed.ok) {
      setPayRequest(null)
      setError(parsed.error)
      return
    }
    if (parsed.request.kind === 'address') {
      const addr = parsed.request.address
      setPayRequest(null)
      setAddress(addr)
      void once(() => doCheck(addr))
      return
    }
    const req = parsed.request.request
    setPayRequest(req)
    if (req.kind === 'transaction') {
      setError(unsupportedReason(req))
      return
    }
    setAddress(req.recipient)
    setAmount(req.amount ?? '')
    void once(() => doCheck(req.recipient))
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
  const verdictIsCurrent = !!verdict && checkedFor === trimmed
  const payBlocked = payRequest ? unsupportedReason(payRequest) : null

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

  const onCheck = () => once(() => doCheck(trimmed))
  const onSend = () => once(doSend)

  async function doCheck(input: string) {
    const field = input.trim()
    setError(null)
    setSent(null)
    setReviewed(false)
    setResolved(null)
    setBusy('check')
    try {
      // A name is resolved fresh on every check; the check runs on the resolved address.
      const target = await resolveRecipientInput(field, NAME_DEPS)
      if (!target.ok) {
        if (!target.isName) {
          setVerdict(null)
          setError(target.error)
          return
        }
        // Name that cannot be resolved: Block with the reason (fail closed).
        setVerdict(nameBlockVerdict(target.error))
        setCheckedFor(field)
        setCheckedTarget('')
        setCheckedAt(Date.now())
        return
      }
      if (target.name) setResolved({ name: target.name.name, address: target.address, source: target.name.source })
      // never throws; errors come back as "block"
      const v = await runRecipientCheck(target.address, { history: entries, wallet: wallet.session?.address })
      const now = Date.now()
      setVerdict(v)
      setCheckedFor(field)
      setCheckedTarget(target.address)
      setCheckedAt(now)
      record({ address: target.address, decision: toUiState(v).decision, explanation: v.explanation, checkedAt: now })
    } finally {
      setBusy(null)
    }
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
    if (!sendEnabled(ui, reviewed, false) || !checkedTarget) return
    if (payBlocked) {
      setError(payBlocked)
      return
    }
    let lamports: bigint
    try {
      lamports = parseSolToLamports(amount)
    } catch (e) {
      setError((e as Error).message)
      return
    }
    setBusy('send')
    try {
      if (checkedTarget !== trimmed) {
        // The field holds a name. Names are transferable: re-resolve right before signing
        // and refuse on any change.
        const again = await resolveRecipientInput(trimmed, NAME_DEPS)
        if (!again.ok || again.address !== checkedTarget) {
          setVerdict(null)
          setResolved(null)
          setError(
            again.ok
              ? `${trimmed} now points to a different address (${again.address}). Check again before sending.`
              : again.error,
          )
          return
        }
      }
      const extras =
        payRequest?.kind === 'transfer' && payRequest.recipient === checkedTarget
          ? { references: payRequest.references, memo: payRequest.memo }
          : undefined
      const r = await sendSol(checkedTarget, lamports, checkedAt, wallet.session?.authToken, extras)
      wallet.setSession(r.session)
      setSent({ signature: r.signature })
    } catch (e) {
      setError(`Send did not complete: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const onConnect = () => once(doConnect)
  const onSenderCheck = () => once(doSenderCheck)

  async function doConnect() {
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

  async function doSenderCheck() {
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

          <Button variant="secondary" title="Scan QR (Solana Pay)" onPress={() => router.push('/scan')} disabled={busy !== null} />

          {payRequest && (
            <View style={styles.payBox}>
              <Text style={styles.payTitle}>
                {payRequest.kind === 'transaction' ? 'Transaction request' : 'Solana Pay request'}
              </Text>
              {/* label/message are free text chosen by whoever made the QR: say so, and keep them short. */}
              {!!payRequest.label && <Text style={styles.payText}>Label (set by the QR, not verified): {clip(payRequest.label)}</Text>}
              {!!payRequest.message && <Text style={styles.payText}>Message: {clip(payRequest.message)}</Text>}
              {payRequest.kind === 'transfer' && (
                <Text style={styles.payText}>
                  Requested: {payRequest.amount ?? 'any amount'} {payRequest.splToken ? 'tokens' : 'SOL'}
                  {payRequest.memo ? ` · memo "${payRequest.memo}"` : ''}
                </Text>
              )}
              {payRequest.kind === 'transfer' && payRequest.splToken && (
                <Text selectable style={styles.mono}>Token mint: {payRequest.splToken}</Text>
              )}
              {payRequest.kind === 'transaction' && <Text selectable style={styles.mono}>{payRequest.link}</Text>}
              {!!payBlocked && <Text style={styles.stopped}>{payBlocked}</Text>}
            </View>
          )}

          <Text style={styles.label}>Recipient address or name</Text>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={(t) => {
              setAddress(t)
              setPayRequest(null)
              resetResult()
            }}
            placeholder="Address, name.sol, name.sns or name.skr"
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
                setPayRequest(null)
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
          {parsedAmount !== null && !(payRequest?.kind === 'transfer' && payRequest.splToken) && (
            <Text style={styles.hint}>You will send {formatLamportsAsSol(parsedAmount)} SOL</Text>
          )}

          <Button title="Check recipient" onPress={onCheck} busy={busy === 'check'} disabled={busy !== null || !trimmed} />

          {error && <Text style={styles.error}>{error}</Text>}

          {resolved && verdictIsCurrent && (
            <View style={styles.resolvedBox}>
              <Text style={styles.resolvedTitle}>
                {resolved.name} resolves to ({resolved.source}):
              </Text>
              <Text selectable style={styles.resolvedAddr}>{resolved.address}</Text>
              <Text style={styles.payText}>This is the address that was checked and will be paid.</Text>
            </View>
          )}

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
              ) : payBlocked ? (
                <Text style={styles.stopped}>Not sending: {payBlocked}</Text>
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

          {DEVICE_CHECK_ENABLED && (
            <>
              <View style={styles.divider} />
              <DeviceCheckSection />
            </>
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
  payBox: { backgroundColor: theme.accentTint, borderRadius: 12, padding: 14, gap: 6 },
  payTitle: { color: theme.text, fontWeight: '700', fontSize: 15 },
  payText: { color: theme.text, fontSize: 14, lineHeight: 20 },
  resolvedBox: { borderColor: theme.accent, borderWidth: 1.5, borderRadius: 12, padding: 14, gap: 6, backgroundColor: theme.white },
  resolvedTitle: { color: theme.text, fontWeight: '700', fontSize: 14 },
  resolvedAddr: {
    color: theme.text,
    fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
})
