// How it works: three short steps before the Home, once per INTRO_VERSION; Settings opens them again.
import React, { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { Button } from '../ui/components'
import { FadeUp } from '../ui/motion'
import { fonts, makeStyles } from '../ui/theme'
import { INTRO_TEXT as T } from './copy'
import { updateSettings } from './store'
import { INTRO_VERSION } from './types'

export function IntroSheet({ visible, onDone }: { visible: boolean; onDone?: () => void }) {
  const styles = useStyles()
  const [step, setStep] = useState(0)
  const last = step === T.steps.length - 1
  const done = () => {
    setStep(0)
    void updateSettings({ introSeen: INTRO_VERSION })
    onDone?.()
  }
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={done}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.top}>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={done}>
            <Text style={styles.skip}>{T.skip}</Text>
          </Pressable>
        </View>
        <FadeUp key={step} order={0} style={styles.body}>
          <Text style={styles.count}>{`0${step + 1} / 0${T.steps.length}`}</Text>
          <Text style={styles.title}>{T.steps[step].title}</Text>
          <Text style={styles.text}>{T.steps[step].body}</Text>
        </FadeUp>
        <View style={styles.foot}>
          <View style={styles.dots}>
            {T.steps.map((s, i) => (
              <View key={s.title} style={[styles.dot, i === step && styles.dotOn]} />
            ))}
          </View>
          <Button title={last ? T.start : T.next} onPress={() => (last ? done() : setStep(step + 1))} />
        </View>
      </SafeAreaView>
    </Modal>
  )
}

const useStyles = makeStyles((t) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 24 },
    top: { height: 56, alignItems: 'flex-end', justifyContent: 'center' },
    skip: { color: t.muted, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
    body: { flex: 1, justifyContent: 'center', gap: 16 },
    count: { color: t.actionText, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1 },
    title: { color: t.text, fontFamily: fonts.body, fontSize: 30, fontWeight: '600', letterSpacing: -0.8, lineHeight: 36 },
    text: { color: t.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
    foot: { paddingBottom: 24, gap: 20 },
    dots: { flexDirection: 'row', gap: 6, alignSelf: 'center' },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: t.track },
    dotOn: { width: 18, backgroundColor: t.action },
  }),
)
