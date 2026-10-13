#!/usr/bin/env bun
/**
 * Compile the app's native screens into the one bundle Craft runs them from.
 *
 * The screen list comes from `ios.nativeScreens` in `config/mobile.ts` — the
 * same map the generated `craft.config.json` carries, so the bundle and the
 * host cannot disagree about which paths are native. `resources/native.config.json`
 * used to hold a second copy of that list; it is gone.
 */
import { compileNativeScreens } from '@stacksjs/actions/build/native-screens'
import mobile from '../config/mobile'

const root = new URL('..', import.meta.url).pathname
const output = `${root}storage/framework/native`

const result = await compileNativeScreens(mobile.ios, root, output)

if (!result) {
  console.error('ios.nativeScreens lists no screens — nothing to compile.')
  process.exit(1)
}

for (const diagnostic of result.diagnostics)
  console.warn(`[native] ${diagnostic.message}`)

console.log(`Native screens: ${result.outFile}`)
