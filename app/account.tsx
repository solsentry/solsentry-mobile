import { useRouter } from 'expo-router'
import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { pointsStatus, type LinkedWallet } from '@/src/kyw/account'
import { forgetLinkedWallet, linkWalletNow, loadLinkedWallet } from '@/src/kyw/account-runtime'
import { ACCOUNT_TEXT as T } from '@/src/kyw/copy'
import type { DeviceIdentity } from '@/src/kyw/device'
import { getDevice } from '@/src/kyw/device-runtime'
import { Button } from '@/src/ui/components'
import { theme } from '@/src/ui/theme'

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

export default function AccountScreen() {
  const router = useRouter()
  const [device, setDevice] = useState<DeviceIdentity | null>(null)
  const [wallet, setWallet] = useState<LinkedWallet | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void getDevice().then(setDevice)
    void loadLinkedWallet().then(setWallet)
  }, [])

  const link = async () => {
    setBusy(true)
    setNote(null)
    const r = await linkWalletNow()
    setBusy(false)
    if (r.ok) setWallet(r.wallet)
    else setNote(r.reason === 'cancelled' ? T.cancelled : r.reason === 'bad_signature' ? T.badSignature : T.failed)
  }

  const status = device ? pointsStatus({ deviceCheck: device.check, deviceKind: device.kind, wallet }) : null
  const sgtLine = wallet && (wallet.sgt.status === 'verified' ? T.genesis : wallet.sgt.status === 'none' ? T.noGenesis : T.genesisUnknown)

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.muted}>‹ Back</Text>
        </Pressable>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{T.title}</Text>
          <Text style={styles.points}>
            {T.pointsUnknown} <Text style={styles.muted}>{T.pointsLabel}</Text>
          </Text>
          <Text style={styles.muted}>{T.pointsSoon}</Text>
          {status && !status.earns && status.why === 'device_not_verified' && <Text style={styles.muted}>{T.deviceNotVerified}</Text>}
          {!wallet && <Text style={styles.warn}>{T.pendingNote}</Text>}
        </View>

        <View style={styles.card}>
          {wallet ? (
            <>
              <Text style={styles.cardTitle}>{T.linked}</Text>
              <Text style={styles.text}>{short(wallet.address)}</Text>
              {sgtLine && <Text style={wallet.sgt.status === 'verified' ? styles.good : styles.muted}>{sgtLine}</Text>}
              {!wallet.synced && <Text style={styles.muted}>{T.notSynced}</Text>}
              <Button
                variant="secondary"
                title={T.unlink}
                onPress={() => void forgetLinkedWallet().then(() => setWallet(null))}
              />
            </>
          ) : busy ? (
            <View style={styles.row}>
              <ActivityIndicator color={theme.action} />
              <Text style={styles.muted}>{T.linking}</Text>
            </View>
          ) : (
            <Button title={T.link} onPress={() => void link()} />
          )}
          {note && <Text style={styles.warn}>{note}</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{T.redeemTitle}</Text>
          <Text style={styles.muted}>{T.redeemNote}</Text>
          {T.redeemItems.map((i) => (
            <Text key={i} style={styles.disabled}>
              {i} · Coming later
            </Text>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, gap: 16 },
  card: { borderWidth: 1, borderColor: theme.border, borderRadius: 16, padding: 16, gap: 10 },
  cardTitle: { color: theme.text, fontSize: 17, fontWeight: '700' },
  points: { color: theme.text, fontSize: 34, fontWeight: '800' },
  text: { color: theme.text, fontSize: 15 },
  muted: { color: theme.muted, fontSize: 14 },
  warn: { color: theme.warn, fontSize: 14 },
  good: { color: theme.action, fontSize: 14 },
  disabled: { color: theme.muted, fontSize: 15, opacity: 0.6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
})
