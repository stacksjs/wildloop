import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import mobileConfig from '../config/mobile'

interface CoreDevice {
  identifier: string
  properties?: {
    connection?: { state?: string }
    hardware?: { deviceType?: string, platform?: string, udid?: string }
    state?: { name?: string }
  }
}

interface CoreDevicePayload {
  result?: { devices?: CoreDevice[] }
}

export interface IosPhone {
  coreDeviceId: string
  name: string
  udid: string
}

const projectRoot = resolve(import.meta.dir, '..')
const generatedRoot = join(projectRoot, 'storage/framework/mobile/ios')
const runtimeRoot = join(projectRoot, 'storage/framework/runtime/ios-device')
const bundleId = process.env.IOS_BUNDLE_ID ?? 'org.wildloop.app'
const watchAppEnabled = mobileConfig.ios.capabilities?.watchApp === true

function normalizedEnvironment(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const localBin = join(homedir(), '.local/bin')
  const path = [localBin, process.env.PATH].filter(Boolean).join(':')
  return Object.fromEntries(
    Object.entries({ ...process.env, PATH: path, ...extra })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function execute(command: string[], options: { capture?: boolean, env?: Record<string, string | undefined> } = {}): string {
  const result = Bun.spawnSync(command, {
    cwd: projectRoot,
    env: normalizedEnvironment(options.env),
    stdout: options.capture ? 'pipe' : 'inherit',
    stderr: options.capture ? 'pipe' : 'inherit',
  })
  if (result.exitCode !== 0) {
    const detail = options.capture ? `\n${result.stderr.toString().trim()}` : ''
    throw new Error(`Command failed (${result.exitCode}): ${command.join(' ')}${detail}`)
  }
  return options.capture ? result.stdout.toString().trim() : ''
}

function developerDir(): string {
  const configured = process.env.DEVELOPER_DIR
  const selected = execute(['/usr/bin/xcode-select', '-p'], { capture: true })
  const candidates = [configured, selected, '/Applications/Xcode.app/Contents/Developer', '/Applications/Xcode-beta.app/Contents/Developer']
  const match = candidates.find(path => path && existsSync(join(path, 'usr/bin/xcodebuild')))
  if (!match) throw new Error('Full Xcode is required. Install Xcode, launch it once, and accept its license.')
  return match
}

export function inferDevelopmentTeam(identityOutput: string): string | null {
  const teams = new Set([...identityOutput.matchAll(/Apple Development:.*\(([A-Z0-9]{10})\)/g)].map(match => match[1]))
  return teams.size === 1 ? [...teams][0] : null
}

export function requiresDevelopmentTeam(args: string[]): boolean {
  return !args.includes('--compile-only')
}

function developmentTeam(): string {
  if (process.env.APPLE_TEAM_ID) return process.env.APPLE_TEAM_ID
  const identities = execute(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'], { capture: true })
  const inferred = inferDevelopmentTeam(identities)
  if (!inferred) throw new Error('Set APPLE_TEAM_ID to the 10-character team ID used for iOS development signing.')
  return inferred
}

export function selectAvailableIphone(payload: CoreDevicePayload, requestedId?: string): IosPhone | null {
  const phones = (payload.result?.devices ?? [])
    .filter((device) => {
      const properties = device.properties
      return properties?.connection?.state === 'available'
        && properties.hardware?.platform === 'iOS'
        && properties.hardware.deviceType === 'iPhone'
    })
    .map(device => ({
      coreDeviceId: device.identifier,
      name: device.properties?.state?.name ?? 'iPhone',
      udid: device.properties?.hardware?.udid ?? device.identifier,
    }))

  if (!requestedId) return phones.length === 1 ? phones[0] : null
  return phones.find(phone => phone.udid === requestedId || phone.coreDeviceId === requestedId || phone.name === requestedId) ?? null
}

function availableIphone(xcode: string): IosPhone {
  const output = join(mkdtempSync(join(tmpdir(), 'wildloop-devices-')), 'devices.json')
  execute(['xcrun', 'devicectl', 'list', 'devices', '--json-output', output, '--omit-deprecated-fields-in-json'], {
    env: { DEVELOPER_DIR: xcode },
  })
  const payload = JSON.parse(readFileSync(output, 'utf8')) as CoreDevicePayload
  const phone = selectAvailableIphone(payload, process.env.IOS_DEVICE_ID)
  if (!phone) {
    throw new Error('No single available iPhone was found. Connect and unlock the paired iPhone, trust this Mac, enable Developer Mode, then rerun. Set IOS_DEVICE_ID when multiple phones are connected.')
  }
  return phone
}

function localSource(packageName: 'craft' | 'stx'): string | undefined {
  const relative = packageName === 'craft' ? '../../Tools/craft/packages/ios/src/index.ts' : '../../Tools/stx'
  const path = resolve(projectRoot, relative)
  return existsSync(path) ? path : undefined
}

function generateProject(xcode: string, teamId: string, bundled: boolean): void {
  if (!Bun.which('xcodegen') && !existsSync(join(homedir(), '.local/bin/xcodegen'))) {
    throw new Error('XcodeGen is required. Install it with `brew install xcodegen` or place `xcodegen` in ~/.local/bin.')
  }
  const shared = {
    DEVELOPER_DIR: xcode,
    APPLE_TEAM_ID: teamId,
    ...(bundled ? { MOBILE_E2E: '1' } : {}),
  }
  execute(['bun', 'run', 'build:frontend'], {
    env: { ...shared, STX_SOURCE_ROOT: process.env.STX_SOURCE_ROOT ?? localSource('stx') },
  })
  execute(['bun', 'run', 'build:ios'], {
    env: { ...shared, CRAFT_IOS_SRC: process.env.CRAFT_IOS_SRC ?? localSource('craft') },
  })
}

export function requiredIosAppPaths(app: string, includeWatchApp = watchAppEnabled): string[] {
  return [
    join(app, 'WildLoop'),
    join(app, 'dist/index.html'),
    join(app, 'PlugIns/WildLoopLiveActivity.appex'),
    ...(includeWatchApp ? [join(app, 'Watch/WildLoopWatch.app')] : []),
  ]
}

function validateApp(app: string, xcode: string, signed: boolean): void {
  const required = requiredIosAppPaths(app)
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`Device build is incomplete: ${path}`)
  }

  const architecture = execute(['file', join(app, 'WildLoop')], { capture: true })
  if (!architecture.includes('arm64')) throw new Error('Device build does not contain an arm64 executable')
  if (signed) execute(['codesign', '--verify', '--deep', '--strict', '--verbose=2', app])
  execute(['xcrun', 'plutil', '-lint', join(app, 'Info.plist')], { env: { DEVELOPER_DIR: xcode } })
}

function buildForDevice(xcode: string, teamId: string, phone: IosPhone | null, unsigned: boolean): string {
  mkdirSync(runtimeRoot, { recursive: true })
  const configuration = process.env.IOS_CONFIGURATION ?? 'Release'
  const destination = phone ? `platform=iOS,id=${phone.udid}` : 'generic/platform=iOS'
  const args = [
    'xcodebuild', '-project', join(generatedRoot, 'WildLoop.xcodeproj'), '-scheme', 'WildLoop',
    '-configuration', configuration, '-destination', destination, '-derivedDataPath', runtimeRoot,
  ]
  if (unsigned) args.push('CODE_SIGNING_ALLOWED=NO')
  else args.push('-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${teamId}`, 'CODE_SIGN_STYLE=Automatic')
  args.push('build')

  try {
    execute(args, { env: { DEVELOPER_DIR: xcode } })
  }
  catch (error) {
    if (!unsigned) {
      const targets = [bundleId, `${bundleId}.liveactivity`]
      if (watchAppEnabled) targets.push(`${bundleId}.watchkitapp`)
      throw new Error(`${error instanceof Error ? error.message : error}\n\nSigning needs an Apple account in Xcode > Settings > Accounts and automatic profiles for ${targets.join(', ')}.`)
    }
    throw error
  }

  const app = join(runtimeRoot, `Build/Products/${configuration}-iphoneos/WildLoop.app`)
  if (!existsSync(app)) throw new Error(`Xcode did not produce ${app}`)
  validateApp(app, xcode, !unsigned)
  return app
}

function installAndLaunch(app: string, phone: IosPhone, xcode: string): void {
  execute(['xcrun', 'devicectl', 'device', 'install', 'app', '--device', phone.coreDeviceId, app], { env: { DEVELOPER_DIR: xcode } })
  execute(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', phone.coreDeviceId, '--terminate-existing', bundleId], { env: { DEVELOPER_DIR: xcode } })
  console.log(`WildLoop is installed and open on ${phone.name} (${phone.udid}).`)
  console.log('Open wildloop://record from Safari to verify native deep-link delivery.')
}

if (import.meta.main) {
  try {
    const args = new Set(process.argv.slice(2))
    const compileOnly = args.has('--compile-only')
    const buildOnly = args.has('--build-only') || compileOnly
    const xcode = developerDir()
    const teamId = requiresDevelopmentTeam([...args]) ? developmentTeam() : ''
    const phone = buildOnly ? null : availableIphone(xcode)
    if (!args.has('--skip-generate')) generateProject(xcode, teamId, args.has('--bundled'))
    const app = buildForDevice(xcode, teamId, phone, compileOnly)
    if (phone) installAndLaunch(app, phone, xcode)
    else console.log(`Validated iPhone build: ${app}`)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
