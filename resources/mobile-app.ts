import type { NativeCraft } from '@stacksjs/stx/native'
import { startNativeApp } from './functions/native-app'

/** Craft runs this once for the app's lifetime, independently of any screen. */
export default function app(host: NativeCraft): () => void {
  return startNativeApp(host)
}
