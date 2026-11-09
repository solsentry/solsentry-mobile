// Manual phone integration, bundled only in a self-test build.
import React, { useRef, useState } from 'react'
import { Button, ScrollView, StyleSheet, Text, TextInput } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { artifactReader } from '../artifact-reader'
import { CertificateClient, type CheckResult } from '../client'
import { MAINNET_POLICY, epochForSlot, finalityMessage } from '../verifier'

export default function CertificateScreen() {
  const [url, setUrl] = useState('http://127.0.0.1:8093')
  const [slot, setSlot] = useState('467424001')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckResult | null>(null)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const cache = useRef<{ key: string; client: CertificateClient } | null>(null)
  const check = async () => {
    setBusy(true)
    setResult(null)
    const start = Date.now()
    try {
      const target = /^\d+$/.test(slot) ? Number(slot) : NaN
      const epoch = epochForSlot(target, MAINNET_POLICY)
      const key = JSON.stringify([url, epoch, pin])
      if (cache.current?.key !== key)
        cache.current = {
          key,
          client: new CertificateClient(
            artifactReader(url, true),
            MAINNET_POLICY,
            pin ? [{ epoch, sha256: pin.trim() }] : [],
          ),
        }
      const value = await cache.current.client.check(target, undefined, 60000)
      setResult(value)
      console.log(`ALPENGLOW_SELFTEST ${JSON.stringify({ ...value, ms: Date.now() - start })}`)
    } catch (error) {
      setResult({
        status: 'unavailable',
        signatureValid: false,
        reason: error instanceof Error ? error.message : 'Invalid input',
      })
    } finally {
      setElapsed(Date.now() - start)
      setBusy(false)
    }
  }
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Block finality check</Text>
        <Text>Test build · mainnet</Text>
        <Text>Artifact server</Text>
        <TextInput style={styles.input} value={url} onChangeText={setUrl} autoCapitalize="none" editable={!busy} />
        <Text>Certificate slot</Text>
        <TextInput
          style={styles.input}
          value={slot}
          onChangeText={setSlot}
          keyboardType="number-pad"
          editable={!busy}
        />
        <Text>Operator table SHA-256 (optional)</Text>
        <TextInput style={styles.input} value={pin} onChangeText={setPin} autoCapitalize="none" editable={!busy} />
        <Text>
          Use a digest obtained through a trusted channel. A digest from the same artifact server does not authenticate
          its validator table.
        </Text>
        <Button title={busy ? 'Checking…' : 'Check certificate'} disabled={busy} onPress={() => void check()} />
        {result && (
          <>
            <Text style={styles.title}>
              {result.status === 'unavailable' ? 'Certificate unavailable.' : finalityMessage(result)}
            </Text>
            {'reason' in result && result.reason && <Text>{result.reason}</Text>}
            {'table' in result && (
              <Text>
                Epoch {result.table.epoch} · {result.table.validators} validators · {result.table.trust}
              </Text>
            )}
            <Text>{elapsed} ms on this device</Text>
          </>
        )}
        <Text>
          A certificate covers a block root. It does not prove transaction inclusion, account balances, or wallet
          safety.
        </Text>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  body: { padding: 20, gap: 14 },
  title: { fontSize: 20, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: '#aaa', borderRadius: 8, padding: 10 },
})
