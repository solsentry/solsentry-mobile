import 'react-native-get-random-values'
import './polyfill'
import { AppRegistry } from 'react-native'
import 'expo-router/entry'
import { install } from 'react-native-quick-crypto'
import { TASK_NAME } from './modules/kyw-service'
import { validationTask } from './src/kyw/engine'
import { startWidgetSync } from './src/kyw/widget-runtime'

install()

// The foreground service starts this task; it returns when validation is switched off.
AppRegistry.registerHeadlessTask(TASK_NAME, () => validationTask)
// The home screen widget follows the store in the app and in the headless task alike.
startWidgetSync()
