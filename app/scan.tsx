import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { useRouter } from 'expo-router'
import React, { useRef, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button } from '@/src/ui/components'
import { theme } from '@/src/ui/theme'

/**
 * QR scanner for Solana Pay links and plain addresses. It only hands the scanned text to the
 * Check & Send screen, which parses it, fills the form and runs the recipient check.
 */
export default function Scan() {
  const router = useRouter()
  const [permission, requestPermission] = useCameraPermissions()
  const done = useRef(false)
  const [cameraError, setCameraError] = useState<string | null>(null)

  function onScanned({ data }: BarcodeScanningResult) {
    if (done.current || !data) return
    done.current = true
    router.dismissTo({ pathname: '/', params: { pay: data, t: String(Date.now()) } })
  }

  if (!permission) return <View style={styles.safe} />

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        <Text style={styles.text}>The camera is used only to read a payment QR code. Nothing is recorded or uploaded.</Text>
        {permission.canAskAgain ? (
          <Button title="Allow camera" onPress={requestPermission} />
        ) : (
          // Android stops showing the prompt after a permanent denial; only Settings can re-enable it.
          <Button title="Open settings" onPress={() => void Linking.openSettings()} />
        )}
        <Button variant="secondary" title="Cancel" onPress={() => router.back()} />
      </SafeAreaView>
    )
  }

  if (cameraError) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        <Text style={styles.text}>The camera could not start ({cameraError}). Paste the address instead.</Text>
        <Button variant="secondary" title="Back" onPress={() => router.back()} />
      </SafeAreaView>
    )
  }

  return (
    <View style={styles.safe}>
      <CameraView
        onMountError={(e) => setCameraError(e.message)}
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScanned}
      />
      <SafeAreaView style={styles.overlay} edges={['top', 'bottom']}>
        <Text style={styles.hint}>Point at a Solana Pay QR code or an address QR.</Text>
        <Button variant="secondary" title="Cancel" onPress={() => router.back()} />
      </SafeAreaView>
    </View>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  center: { justifyContent: 'center', padding: 24, gap: 12 },
  text: { color: theme.text, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  overlay: { flex: 1, justifyContent: 'space-between', padding: 16 },
  hint: {
    color: theme.white,
    backgroundColor: 'rgba(28,21,67,0.7)',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    textAlign: 'center',
    overflow: 'hidden',
  },
})
