import AsyncStorage from '@react-native-async-storage/async-storage'
import Clipboard from '@react-native-clipboard/clipboard'
import * as Linking from 'expo-linking'
import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { NAME_RPC_URL, RPC_URL, SGT_RPC_URL, SNS_PROXY_URL, solscanTx, VERDICT_MAX_AGE_MS } from '@/src/config'
import type { RecipientVerdict, SenderVerdict } from '@/src/guard/checks'
import { runRecipientCheck, runSenderCheck } from '@/src/guard/service'
import type { ResolveDeps } from '@/src/pay/names'
import { nameBlockVerdict, resolveRecipientInput } from '@/src/pay/recipient'
import { fetchSgt, SGT_INFO_TEXT, sgtBadgeText, type SgtResult } from '@/src/seeker/sgt'
import { parseScanned, unsupportedReason, type SolanaPayRequest } from '@/src/pay/solana-pay'
import {
  formAfterAmountEdit,
  formAfterPayRequest,
  formAfterRecipientEdit,
  type PayForm,
} from '@/src/pay/scan-form'
import { useHistory } from '@/src/state/history'
import { useWalletState } from '@/src/state/wallet'
import { Button, Footer, VerdictCard } from '@/src/ui/components'
import { describeError, type UserError, type WalletAction } from '@/src/ui/errors'
import { theme } from '@/src/ui/theme'
import { sendEnabled, toUiState } from '@/src/ui/verdict'
import { sendSol, type WalletSession } from '@/src/wallet/mwa'
import { formatLamportsAsSol, parseSolToLamports } from '@/src/wallet/mwa-math'
import {
  addPending,
  applyRecovery,
  CHECKED_HISTORY_LABEL,
  LOAD_FAILED_NOTICE,
  loadPending,
  lockedFor,
  markDeclined,
  markUnsaved,
  pendingKey,
  pendingMessage,
  prunePending,
  removePending,
  SAVE_FAILED_NOTICE,
  savePending,
  type PendingMap,
  type PendingRecord,
} from '@/src/wallet/pending-sends'
import {
  CHECKING_NETWORK,
  publicRpc,
  recoverPendingSend,
  SendOutcomeUnknownError,
  type PendingSend,
} from '@/src/wallet/send-recovery'

const RECOVERY_DEPS = {
  rpc: publicRpc(RPC_URL),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
}

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
  /** The amount field holds what a QR wrote; a hand edit of the recipient then clears it (scan-form.ts). */
  const [amountFromQr, setAmountFromQr] = useState(false)
  const form: PayForm = { address, amount, amountFromQr, payRequest }
  const setForm = (f: PayForm) => {
    setAddress(f.address)
    setAmount(f.amount)
    setAmountFromQr(f.amountFromQr)
    setPayRequest(f.payRequest)
  }
  const lastPay = useRef('')
  const [checkedAt, setCheckedAt] = useState(0)
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState<null | 'check' | 'send' | 'recheck' | 'connect' | 'sender' | 'disconnect'>(null)
  const [error, setErrorState] = useState<UserError | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const setError = (message: string | null) => {
    setErrorState(message ? { message } : null)
    setShowDetail(false)
  }
  /** Wallet/send failures: human sentence first, raw text only behind "Details". */
  const showError = (e: unknown, action: WalletAction) => {
    setErrorState(describeError(e, action))
    setShowDetail(false)
  }
  const [sent, setSent] = useState<{ signature: string } | null>(null)
  /**
   * Sends whose outcome is not known for sure, by recipient+amount (see pending-sends.ts for when a
   * lock lapses). Editing the form never unlocks a pair. Persisted, so a remount or restart keeps it.
   * The ref is the source of truth (read synchronously by doSend); the state re-renders.
   */
  const pendingRef = useRef<PendingMap>({})
  const [pending, setPendingState] = useState<PendingMap>({})
  /** Send stays disabled until the stored locks are read (no race with a fast tap after launch). */
  const [pendingReady, setPendingReady] = useState(false)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  /** Key of the record whose send or network check is running now (its box is hidden meanwhile). */
  const [checkingKey, setCheckingKey] = useState<string | null>(null)
  /** Progress line while the network is checked; not an error. */
  const [notice, setNotice] = useState<string | null>(null)
  const setPendingMemory = (next: PendingMap) => {
    pendingRef.current = next
    setPendingState(next)
  }
  /** Update the locks and persist them. false = the save failed: the in-memory lock stays, with a warning. */
  async function updatePending(fn: (m: PendingMap) => PendingMap): Promise<boolean> {
    const next = prunePending(fn(pendingRef.current), Date.now())
    setPendingMemory(next)
    try {
      await savePending(AsyncStorage, next)
      return true
    } catch {
      setStorageWarning(SAVE_FAILED_NOTICE)
      return false
    }
  }

  useEffect(() => {
    void loadPending(AsyncStorage, Date.now()).then(({ map, ok }) => {
      // Records written in this session win over what was stored.
      setPendingMemory({ ...map, ...pendingRef.current })
      if (!ok) setStorageWarning(LOAD_FAILED_NOTICE)
      setPendingReady(true)
    })
  }, [])
  const [senderVerdict, setSenderVerdict] = useState<SenderVerdict | null>(null)
  const [senderAt, setSenderAt] = useState(0)
  /** Seeker Genesis Token of the connected wallet only (never shown for a recipient). */
  const [sgt, setSgt] = useState<{ address: string; result: SgtResult | null } | null>(null)
  const sgtRun = useRef(0)
  const walletAddress = wallet.session?.address ?? null

  async function lookupSgt(owner: string) {
    const run = ++sgtRun.current
    setSgt({ address: owner, result: null })
    const result = await fetchSgt(owner, SGT_RPC_URL)
    // A newer lookup (or another wallet) wins; never show one wallet's result for another.
    if (run === sgtRun.current) setSgt({ address: owner, result })
  }

  useEffect(() => {
    if (walletAddress) void lookupSgt(walletAddress)
    else setSgt(null)
    // A sender verdict belongs to the wallet it was run for.
    setSenderVerdict(null)
  }, [walletAddress])

  useEffect(() => {
    if (params.address && params.address !== address) {
      setForm(formAfterRecipientEdit(form, params.address))
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
      setForm(formAfterRecipientEdit(form, addr))
      void once(() => doCheck(addr))
      return
    }
    const req = parsed.request.request
    // Only a SOL transfer request writes the SOL amount; SPL / transaction requests clear it.
    setForm(formAfterPayRequest(form, req))
    if (req.kind === 'transaction') {
      setError(unsupportedReason(req))
      return
    }
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
    if (!pendingReady) return
    const lock = lockedFor(pendingRef.current, checkedTarget, lamports, Date.now())
    if (lock) {
      setError(pendingMessage(lock))
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
      const r = await sendSol(
        checkedTarget,
        lamports,
        checkedAt,
        wallet.session?.authToken,
        extras,
        {
          // Keep a fresh authorization even if the signature is then cancelled; drop a rejected token.
          onSession: wallet.setSession,
          onTokenRejected: wallet.forgetToken,
        },
        // Locked and saved BEFORE the wallet is asked (awaited): an app kill mid-prompt keeps the lock.
        // A failed save still sends, but the record is marked unsaved and the screen warns.
        async (p) => {
          setCheckingKey(pendingKey(p.recipient, p.lamports))
          if (!(await updatePending((m) => addPending(m, p)))) {
            setPendingMemory(markUnsaved(pendingRef.current, p.recipient, p.lamports, true))
          }
        },
      )
      // A signature came back: the transfer is known, the lock goes.
      await updatePending((m) => removePending(m, checkedTarget, lamports))
      wallet.setSession(r.session)
      setSent({ signature: r.signature })
    } catch (e) {
      if (e instanceof SendOutcomeUnknownError) {
        await checkPendingSend(e.pending, e.session)
      } else {
        // A record exists only if the request reached the wallet: then a decline keeps the pair
        // locked (status 'declined'). A failure before the wallet got the request left no record.
        if (lockedFor(pendingRef.current, checkedTarget, lamports, Date.now())) {
          await updatePending((m) => markDeclined(m, checkedTarget, lamports))
        }
        showError(e, 'send')
      }
    } finally {
      setCheckingKey(null)
      setBusy(null)
    }
  }

  /** The wallet may have sent it anyway: never report a failure before the chain says so. */
  // The outcome (not seen / could not confirm) is shown by the record's box, which stays locked.
  async function checkPendingSend(p: PendingSend, session?: WalletSession) {
    setCheckingKey(pendingKey(p.recipient, p.lamports))
    setNotice(CHECKING_NETWORK)
    try {
      const r = await recoverPendingSend(p, RECOVERY_DEPS)
      await updatePending((m) => applyRecovery(m, p, r))
      if (r.status === 'found') {
        if (session) wallet.setSession(session)
        setError(null)
        setSent({ signature: r.signature })
      }
    } finally {
      setNotice(null)
      setCheckingKey(null)
    }
  }

  const onRecheck = (r: PendingRecord) =>
    once(async () => {
      setError(null)
      setSent(null)
      setBusy('recheck')
      try {
        await checkPendingSend(r)
      } finally {
        setBusy(null)
      }
    })

  /** The user checked the wallet history themselves: release the pair. */
  const onCheckedHistory = (r: PendingRecord) =>
    once(async () => {
      await updatePending((m) => removePending(m, r.recipient, r.lamports))
      setError(null)
    })

  const onConnect = () => once(doConnect)
  const onSenderCheck = () => once(doSenderCheck)
  const onDisconnect = () => once(doDisconnect)

  async function doDisconnect() {
    setError(null)
    setBusy('disconnect')
    try {
      // Local session and token are gone before the wallet answers; a failed revoke changes nothing here.
      await wallet.disconnect()
    } finally {
      setBusy(null)
    }
  }

  async function doConnect() {
    setError(null)
    setBusy('connect')
    try {
      await wallet.connect()
    } catch (e) {
      showError(e, 'connect')
    } finally {
      setBusy(null)
    }
  }

  async function doSenderCheck() {
    if (!wallet.session) return
    setError(null)
    setBusy('sender')
    try {
      setSenderVerdict(await runSenderCheck(wallet.session.address))
      setSenderAt(Date.now())
    } catch (e) {
      showError(e, 'sender')
    } finally {
      setBusy(null)
    }
  }

  const senderUi = senderVerdict ? toUiState(senderVerdict) : null
  const canPress = ui
    ? sendEnabled(ui, reviewed, busy !== null) &&
      verdictIsCurrent &&
      parsedAmount !== null &&
      pendingReady &&
      !lockedFor(pending, checkedTarget, parsedAmount, Date.now())
    : false
  const unsaved = Object.values(pending).some((r) => r.unsaved)
  const openPending = Object.entries(prunePending(pending, Date.now())).filter(([k]) => k !== checkingKey)

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
              setForm(formAfterRecipientEdit(form, t))
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
                setForm(formAfterRecipientEdit(form, t.trim()))
                resetResult()
              }
            }}
          />

          <Text style={styles.label}>Amount (SOL)</Text>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={(t) => setForm(formAfterAmountEdit(form, t))}
            placeholder="0.05"
            placeholderTextColor={theme.muted}
            keyboardType="decimal-pad"
          />
          {parsedAmount !== null && !(payRequest?.kind === 'transfer' && payRequest.splToken) && (
            <Text style={styles.hint}>You will send {formatLamportsAsSol(parsedAmount)} SOL</Text>
          )}

          <Button title="Check recipient" onPress={onCheck} busy={busy === 'check'} disabled={busy !== null || !trimmed} />

          {notice && <Text style={styles.notice}>{notice}</Text>}

          {openPending.map(([key, r]) => (
            <View key={key} style={styles.pendingBox}>
              <Text style={styles.payText}>{pendingMessage(r)}</Text>
              <Text selectable style={styles.mono}>
                {formatLamportsAsSol(r.lamports)} SOL to {short(r.recipient)}
              </Text>
              <Text style={styles.hint}>Sending this amount to this address is paused.</Text>
              <Button
                variant="secondary"
                title="Check again"
                onPress={() => onRecheck(r)}
                busy={busy === 'recheck'}
                disabled={busy !== null}
              />
              <Button
                variant="secondary"
                title={CHECKED_HISTORY_LABEL}
                onPress={() => onCheckedHistory(r)}
                disabled={busy !== null}
              />
            </View>
          ))}

          {(storageWarning || unsaved) && (
            <Text style={styles.stopped}>{storageWarning ?? SAVE_FAILED_NOTICE}</Text>
          )}

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.error}>{error.message}</Text>
              {!!error.detail &&
                (showDetail ? (
                  <Text selectable style={styles.errorDetail} onPress={() => setShowDetail(false)}>
                    {error.detail}
                  </Text>
                ) : (
                  <Text style={styles.errorToggle} onPress={() => setShowDetail(true)} accessibilityRole="button">
                    Details
                  </Text>
                ))}
            </View>
          )}

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
              {sgt?.address === wallet.session.address && (
                <View style={styles.sgtBox}>
                  <Text style={styles.sgtLine}>
                    {sgt.result ? sgtBadgeText(sgt.result) : 'Seeker Genesis Token: checking…'}
                    {sgt.result?.status === 'unknown' && (
                      <Text style={styles.sgtRetry} onPress={() => lookupSgt(sgt.address)} accessibilityRole="button">
                        {'  '}Retry
                      </Text>
                    )}
                  </Text>
                  <Text style={styles.hint}>{SGT_INFO_TEXT}</Text>
                </View>
              )}
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
              <Button
                variant="secondary"
                title="Disconnect"
                onPress={onDisconnect}
                busy={busy === 'disconnect'}
                disabled={busy !== null}
              />
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
  notice: { color: theme.text, fontSize: 14, fontWeight: '600' },
  pendingBox: { borderColor: theme.stop, borderWidth: 1.5, borderRadius: 12, padding: 14, gap: 6, backgroundColor: theme.white },
  sgtBox: { gap: 2 },
  sgtLine: { color: theme.text, fontSize: 14, fontWeight: '600' },
  sgtRetry: { color: theme.accent, fontWeight: '700' },
  error: { color: theme.stop, fontSize: 14, lineHeight: 20 },
  errorBox: { gap: 4 },
  errorToggle: { color: theme.muted, fontSize: 12, textDecorationLine: 'underline' },
  errorDetail: { color: theme.muted, fontSize: 12, fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }) },
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
