import { useRouter } from 'expo-router'
import React, { useState } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { runRecipientCheck } from '@/src/guard/service'
import { useHistory, type HistoryEntry } from '@/src/state/history'
import { useWalletState } from '@/src/state/wallet'
import { Button, Footer } from '@/src/ui/components'
import { theme } from '@/src/ui/theme'
import { toUiState } from '@/src/ui/verdict'

function Row({ entry }: { entry: HistoryEntry }) {
  const { record, entries } = useHistory()
  const wallet = useWalletState()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const ui = toUiState(entry)
  return (
    <View style={styles.row}>
      <Text style={[styles.decision, { color: ui.tone === 'accent' ? theme.accent : theme.stop }]}>
        {ui.label.toUpperCase()}
      </Text>
      <Text selectable style={styles.addr}>{entry.address}</Text>
      <Text style={styles.meta}>Checked {new Date(entry.checkedAt).toLocaleString()}</Text>
      <View style={styles.actions}>
        <View style={{ flex: 1 }}>
          <Button
            variant="secondary"
            title="Re-check"
            busy={busy}
            onPress={async () => {
              setBusy(true)
              // Same contact sources as the main check: without them Re-check skips the poisoning
              // screen and a lookalike could be re-recorded as ALLOW, then serve as a "contact".
              const v = await runRecipientCheck(entry.address, { history: entries, wallet: wallet.session?.address })
              record({
                address: entry.address,
                decision: toUiState(v).decision,
                explanation: v.explanation,
                checkedAt: Date.now(),
              })
              setBusy(false)
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            variant="secondary"
            title="Open"
            onPress={() => router.navigate({ pathname: '/', params: { address: entry.address } })}
          />
        </View>
      </View>
    </View>
  )
}

export default function History() {
  const { entries, clear } = useHistory()
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <FlatList
        data={entries}
        keyExtractor={(e) => e.address}
        contentContainerStyle={styles.body}
        ListHeaderComponent={
          <Text style={styles.intro}>
            Addresses you checked on this device. Re-check before you pay the same address again: signals can change.
          </Text>
        }
        ListEmptyComponent={<Text style={styles.empty}>Nothing checked yet.</Text>}
        renderItem={({ item }) => <Row entry={item} />}
        ListFooterComponent={
          <>
            {entries.length > 0 && <Button variant="secondary" title="Clear history" onPress={clear} />}
            <Footer />
          </>
        }
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, gap: 12 },
  intro: { color: theme.muted, fontSize: 14, lineHeight: 20 },
  empty: { color: theme.muted, textAlign: 'center', paddingVertical: 32 },
  row: { backgroundColor: theme.white, borderColor: theme.border, borderWidth: 1, borderRadius: 12, padding: 14, gap: 6 },
  decision: { fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  addr: { color: theme.text, fontSize: 13, fontFamily: 'monospace' },
  meta: { color: theme.muted, fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
})
