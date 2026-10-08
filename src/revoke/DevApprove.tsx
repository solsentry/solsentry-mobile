// DEBUG BUILDS ONLY (rendered behind __DEV__ in the Approvals tab): approve 1 raw unit of one of
// the wallet's own token accounts to an address typed here, so there is something to revoke.
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import React, { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { RPC_URL } from '../config'
import { Button } from '../ui/components'
import { theme } from '../ui/theme'
import { withAuthorizedWallet } from '../wallet/mwa-session'
import { buildTestApproveInstruction } from './dev-approve'

export function DevApprove({ owner, authToken, onDone }: { owner: string; authToken?: string; onDone: () => void }) {
  const [account, setAccount] = useState('')
  const [delegate, setDelegate] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setNote(null)
    try {
      const connection = new Connection(RPC_URL, 'confirmed')
      const accountKey = new PublicKey(account.trim())
      const info = await connection.getAccountInfo(accountKey)
      if (!info) throw new Error('Token account not found.')
      const signature = await withAuthorizedWallet(transact, authToken, async (wallet, session) => {
        if (session.address !== owner) throw new Error('The wallet authorized a different account.')
        const ownerKey = new PublicKey(owner)
        const { blockhash } = await connection.getLatestBlockhash()
        const tx = new Transaction({ feePayer: ownerKey, recentBlockhash: blockhash }).add(
          buildTestApproveInstruction(accountKey, new PublicKey(delegate.trim()), ownerKey, info.owner, 1n),
        )
        const [sig] = await wallet.signAndSendTransactions({ transactions: [tx] })
        return sig
      })
      setNote(`Submitted: ${signature}. Refresh the list in a few seconds.`)
      onDone()
    } catch (e) {
      setNote((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.box}>
      <Text style={styles.title}>DEBUG BUILD ONLY: create a test approval (1 raw unit)</Text>
      <TextInput style={styles.input} value={account} onChangeText={setAccount} placeholder="Your token account" placeholderTextColor={theme.muted} autoCapitalize="none" autoCorrect={false} />
      <TextInput style={styles.input} value={delegate} onChangeText={setDelegate} placeholder="Delegate (your second wallet)" placeholderTextColor={theme.muted} autoCapitalize="none" autoCorrect={false} />
      <Button variant="secondary" title="Create test approval" onPress={run} busy={busy} disabled={busy || !account.trim() || !delegate.trim()} />
      {!!note && <Text selectable style={styles.note}>{note}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderColor: theme.border, borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, padding: 14, gap: 8 },
  title: { color: theme.muted, fontSize: 12, fontWeight: '700' },
  input: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 13, color: theme.text },
  note: { color: theme.muted, fontSize: 12 },
})
