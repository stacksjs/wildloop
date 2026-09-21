#!/usr/bin/env bun
/**
 * Tell the bundled copy of the site which server this build loads.
 *
 * The app ships a copy of the site for when its server cannot be reached,
 * and Craft switches to it on any failed load and never switches back (see
 * resources/functions/native-remote.ts). That copy needs to know where to
 * return to, and the only place it can read from is its own files: this
 * writes the build's server into the bundle as native-remote.json. A
 * bundled-only build (MOBILE_E2E=1) has no server, so the file is removed.
 *
 * Runs in `build:ios`, after `buddy build:ios` has written craft.config.json
 * and copied dist into the Xcode project.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const iosRoot = join(import.meta.dir, '../storage/framework/mobile/ios')

/** The server a generated craft.config.json loads, if it loads one. */
export function nativeRemote(config: { devServerURL?: unknown }): { url: string } | null {
  if (typeof config.devServerURL !== 'string')
    return null
  try {
    const url = new URL(config.devServerURL)
    return url.protocol === 'http:' || url.protocol === 'https:' ? { url: url.origin } : null
  }
  catch {
    return null
  }
}

if (import.meta.main) {
  const config = JSON.parse(readFileSync(join(iosRoot, 'craft.config.json'), 'utf8'))
  const target = join(iosRoot, 'dist/native-remote.json')
  const remote = nativeRemote(config)
  if (remote)
    writeFileSync(target, `${JSON.stringify(remote)}\n`)
  else if (existsSync(target))
    rmSync(target)
  console.log(remote ? `The bundled copy returns to ${remote.url}` : 'Bundled-only build: the bundled copy is the app')
}
