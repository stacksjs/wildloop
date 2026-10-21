/**
 * The XCUITest suite, against an installed Wildloop.
 *
 * Why this is separate from `run-mobile-e2e.ts`: Maestro drives the app, and
 * these tests drive iOS. The home screen, a system permission dialog and the
 * absence of one are all outside the app, so they are outside Maestro. They
 * are iOS-only by nature, which is also why they do not replace anything —
 * the Maestro flows still cover both platforms.
 *
 * The project under `tests/ios-ui` never builds Wildloop. Craft regenerates
 * `storage/framework/mobile/ios` from its own template on every `build:ios`,
 * filling the target list from its config, so a test target added there is
 * gone on the next build. These tests attach by bundle id instead, which is
 * what lets the same suite run against a simulator and a phone.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const PROJECT = join(ROOT, 'tests/ios-ui')
const BUNDLE_ID = process.env.IOS_BUNDLE_ID ?? 'org.wildloop.app'

function run(command: string, args: string[], options: { allowFailure?: boolean, env?: NodeJS.ProcessEnv } = {}): number {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT, env: options.env ?? process.env })
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
  return result.status ?? 1
}

function capture(command: string, args: string[]): string {
  return spawnSync(command, args, { encoding: 'utf8' }).stdout ?? ''
}

/** The booted simulator to drive, or the one named by `IOS_SIMULATOR`. */
function bootedSimulator(): { udid: string, name: string } {
  const wanted = process.env.IOS_SIMULATOR
  const listed = JSON.parse(capture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']) || '{"devices":{}}')
  const booted = Object.values(listed.devices as Record<string, any[]>).flat()
  if (!booted.length)
    throw new Error('No booted simulator. Boot one, or run `bun run preview:ios:local` first.')
  const chosen = wanted ? booted.find(device => device.name === wanted || device.udid === wanted) : booted[0]
  if (!chosen)
    throw new Error(`No booted simulator called ${wanted}. Booted: ${booted.map(d => d.name).join(', ')}`)
  return { udid: chosen.udid, name: chosen.name }
}

/**
 * A signed-out app, which is where three of the four tests begin.
 *
 * XCTest has no equivalent of Maestro's `clearState`, and the keychain
 * outlives an uninstall — reinstalling alone left the account in place, which
 * is how a device pass on 20 Oct briefly looked like the gate had failed. The
 * keychain reset is the part that actually signs the device out.
 */
function resetDevice(udid: string): void {
  const app = join(ROOT, 'storage/framework/runtime/e2e/derived-data/ios/Build/Products/Debug-iphonesimulator/Wildloop.app')
  if (!existsSync(app))
    throw new Error('No built app. Run `bun run preview:ios:local` first, so there is something to test.')
  run('xcrun', ['simctl', 'terminate', udid, BUNDLE_ID], { allowFailure: true })
  run('xcrun', ['simctl', 'uninstall', udid, BUNDLE_ID], { allowFailure: true })
  run('xcrun', ['simctl', 'keychain', udid, 'reset'])
  run('xcrun', ['simctl', 'install', udid, app])
}

const device = bootedSimulator()
console.error(`[ios-ui] driving ${device.name} (${device.udid})`)

if (process.env.IOS_UI_KEEP_STATE !== 'true')
  resetDevice(device.udid)

// xcodegen substitutes ${...} from its own environment as it writes the
// project, which is how the credentials reach the scheme.
run('xcodegen', ['generate', '--spec', join(PROJECT, 'project.yml'), '--project', PROJECT], {
  env: { ...process.env, WILDLOOP_BUNDLE_ID: BUNDLE_ID },
})

const credentials = [
  ['E2E_EMAIL', process.env.E2E_EMAIL],
  ['E2E_PASSWORD', process.env.E2E_PASSWORD],
].filter(([, value]) => value) as [string, string][]
if (!credentials.length)
  console.error('[ios-ui] no E2E_EMAIL/E2E_PASSWORD: the signed-in test will skip itself')

// xcodebuild refuses to write over one, and a stale bundle from the last run
// is the normal state of this directory.
const resultBundle = join(ROOT, 'storage/framework/runtime/e2e/ios-ui.xcresult')
rmSync(resultBundle, { recursive: true, force: true })

run('xcodebuild', [
  'test',
  '-project', join(PROJECT, 'WildloopUITests.xcodeproj'),
  '-scheme', 'WildloopUITests',
  '-destination', `platform=iOS Simulator,id=${device.udid}`,
  '-resultBundlePath', resultBundle,
  'CODE_SIGNING_ALLOWED=NO',
])
