import { useRouter } from 'expo-router'
import React from 'react'
import { ScrollView, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { TEXT } from '@/src/kyw/copy'
import { RpcSection } from '@/src/kyw/RpcSection'
import { ScreenBar } from '@/src/ui/components'
import { FadeUp } from '@/src/ui/motion'
import { makeStyles } from '@/src/ui/theme'

/** Where the reads go: SolSentry by default, or the user's own RPC URL (opened from the RPC badge or Settings). */
export default function RpcScreen() {
  const router = useRouter()
  const styles = useStyles()
  return (
    <SafeAreaView style={styles.safe}>
      <ScreenBar title={TEXT.rpcTitle} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <FadeUp order={0} style={styles.card}>
          <RpcSection />
        </FadeUp>
      </ScrollView>
    </SafeAreaView>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: t.bg },
    body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 32, gap: 10 },
    card: { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  }),
)
