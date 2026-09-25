import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import mobileConfig from '../config/mobile'
import { isLoopback, PRODUCTION_URL, resolveMobileServer, serverArgument } from './mobile-target'

/**
 * A device as `devicectl list devices --json-output` writes it. Newer Xcodes
 * nest everything under `properties` when asked to omit deprecated fields;
 * Xcode 26.0 has no such option and writes the older top-level
 * `connectionProperties` / `hardwareProperties` / `deviceProperties`. Both are
 * read.
 */
interface CoreDevice {
  identifier: string
  properties?: {
    connection?: { state?: string }
    hardware?: { deviceType?: string, platform?: string, udid?: string }
    state?: { name?: string }
  }
  connectionProperties?: { pairingState?: string, tunnelState?: string }
  hardwareProperties?: { deviceType?: string, platform?: string, udid?: string }
  deviceProperties?: { name?: string }
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
// The config's literal type says `false` today; the check is for the day it is switched on.
const watchAppEnabled = (mobileConfig.ios.capabilities as { watchApp?: boolean } | undefined)?.watchApp === true

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

/**
 * The one team the Apple Development certificates on this Mac sign for.
 *
 * The team is the certificate subject's OU. The ten characters in brackets in
 * the certificate's name are the developer's own ID, not the team: Chris's
 * certificate reads "Apple Development: Chris Breuer (DXBQ84FJL4)" while his
 * team is 3JJRNQW6B7. Reading the name signed builds for a team no account
 * has, and put that ID into wildloop.org's apple-app-site-association.
 */
export function inferDevelopmentTeam(subjects: string[]): string | null {
  const teams = new Set(subjects
    .filter(subject => /CN=Apple Development:/.test(subject))
    .map(subject => subject.match(/(?:^|[\n,]\s*)OU=([A-Z0-9]{10})(?:$|[\n,])/)?.[1])
    .filter((team): team is string => !!team))
  return teams.size === 1 ? [...teams][0] : null
}

function developmentCertificateSubjects(): string[] {
  const pems = execute(['/usr/bin/security', 'find-certificate', '-a', '-c', 'Apple Development', '-p'], { capture: true })
  const now = Date.now()
  return (pems.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [])
    .map(pem => new X509Certificate(pem))
    .filter(certificate => Date.parse(certificate.validTo) > now)
    .map(certificate => certificate.subject)
}

export function requiresDevelopmentTeam(args: string[]): boolean {
  return !args.includes('--compile-only')
}

function developmentTeam(): string {
  if (process.env.APPLE_TEAM_ID) return process.env.APPLE_TEAM_ID
  const inferred = inferDevelopmentTeam(developmentCertificateSubjects())
  if (!inferred) throw new Error('Set APPLE_TEAM_ID to the 10-character team ID used for iOS development signing (the OU of its Apple Development certificate, not the ID in the certificate name).')
  return inferred
}

export function selectAvailableIphone(payload: CoreDevicePayload, requestedId?: string): IosPhone | null {
  const phones = (payload.result?.devices ?? [])
    .filter((device) => {
      const hardware = device.properties?.hardware ?? device.hardwareProperties
      const legacy = device.connectionProperties
      const available = device.properties?.connection
        ? device.properties.connection.state === 'available'
        : legacy?.pairingState === 'paired' && !!legacy.tunnelState && legacy.tunnelState !== 'unavailable'
      return available && hardware?.platform === 'iOS' && hardware.deviceType === 'iPhone'
    })
    .map(device => ({
      coreDeviceId: device.identifier,
      name: device.properties?.state?.name ?? device.deviceProperties?.name ?? 'iPhone',
      udid: device.properties?.hardware?.udid ?? device.hardwareProperties?.udid ?? device.identifier,
    }))

  if (!requestedId) return phones.length === 1 ? phones[0] : null
  return phones.find(phone => phone.udid === requestedId || phone.coreDeviceId === requestedId || phone.name === requestedId) ?? null
}

function availableIphone(xcode: string): IosPhone {
  const output = join(mkdtempSync(join(tmpdir(), 'wildloop-devices-')), 'devices.json')
  execute(['xcrun', 'devicectl', 'list', 'devices', '--json-output', output], {
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

/**
 * The server a phone build loads: wildloop.org, or an https `--server` (a
 * tunnel to this Mac, say). Deliberately not MOBILE_URL from the shell: a
 * Simulator session leaves that at localhost, and a phone built with it
 * opened on a server it cannot reach.
 */
export function deviceServerURL(args: string[]): string {
  return resolveMobileServer(serverArgument(args) ?? PRODUCTION_URL, 'device')
}

/** Refuse a built app that loads this Mac, whichever way it was generated. */
export function assertDeviceServer(config: { devServerURL?: unknown }): void {
  if (typeof config.devServerURL !== 'string') return
  if (isLoopback(new URL(config.devServerURL)))
    throw new Error(`This build loads ${config.devServerURL}, which an iPhone cannot reach. Rebuild without --skip-generate.`)
}

function generateProject(xcode: string, teamId: string, bundled: boolean, server: string, personalTeam: boolean): void {
  if (!Bun.which('xcodegen') && !existsSync(join(homedir(), '.local/bin/xcodegen'))) {
    throw new Error('XcodeGen is required. Install it with `brew install xcodegen` or place `xcodegen` in ~/.local/bin.')
  }
  const shared = {
    DEVELOPER_DIR: xcode,
    APPLE_TEAM_ID: teamId,
    MOBILE_E2E: bundled ? '1' : '0',
    MOBILE_URL: server,
    // Signing with any team rewrote the tracked apple-app-site-association
    // for that team, and a push to main deploys it: universal links for the
    // real app would break. The file is only ever regenerated on purpose.
    SKIP_MOBILE_ASSOCIATIONS: '1',
    IOS_PERSONAL_TEAM: personalTeam ? '1' : '0',
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
    join(app, 'Wildloop'),
    join(app, 'dist/index.html'),
    join(app, 'PlugIns/WildloopLiveActivity.appex'),
    ...(includeWatchApp ? [join(app, 'Watch/WildloopWatch.app')] : []),
  ]
}

function validateApp(app: string, xcode: string, signed: boolean): void {
  const required = requiredIosAppPaths(app)
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`Device build is incomplete: ${path}`)
  }

  assertDeviceServer(JSON.parse(readFileSync(join(app, 'craft.config.json'), 'utf8')))

  const architecture = execute(['file', join(app, 'Wildloop')], { capture: true })
  if (!architecture.includes('arm64')) throw new Error('Device build does not contain an arm64 executable')
  if (signed) execute(['codesign', '--verify', '--deep', '--strict', '--verbose=2', app])
  execute(['xcrun', 'plutil', '-lint', join(app, 'Info.plist')], { env: { DEVELOPER_DIR: xcode } })
}

function buildForDevice(xcode: string, teamId: string, phone: IosPhone | null, unsigned: boolean): string {
  mkdirSync(runtimeRoot, { recursive: true })
  const configuration = process.env.IOS_CONFIGURATION ?? 'Release'
  const destination = phone ? `platform=iOS,id=${phone.udid}` : 'generic/platform=iOS'
  const args = [
    'xcodebuild', '-project', join(generatedRoot, 'Wildloop.xcodeproj'), '-scheme', 'Wildloop',
    '-configuration', configuration, '-destination', destination, '-derivedDataPath', runtimeRoot,
  ]
  if (unsigned) args.push('CODE_SIGNING_ALLOWED=NO')
  // Device registration is its own opt-in on the command line. A free team
  // registers the phone without it; a paid team refuses the profile with
  // "Device ... isn't registered in your developer account".
  else args.push('-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', `DEVELOPMENT_TEAM=${teamId}`, 'CODE_SIGN_STYLE=Automatic')
  args.push('build')

  try {
    execute(args, { env: { DEVELOPER_DIR: xcode } })
  }
  catch (error) {
    if (!unsigned) {
      const targets = [bundleId, `${bundleId}.liveactivity`]
      if (watchAppEnabled) targets.push(`${bundleId}.watchkitapp`)
      throw new Error(`${error instanceof Error ? error.message : error}\n\nSigning needs an Apple account in Xcode > Settings > Accounts and automatic profiles for ${targets.join(', ')}. A free (personal) Apple team cannot sign Associated Domains or Push Notifications: rerun with --personal-team.`)
    }
    throw error
  }

  const app = join(runtimeRoot, `Build/Products/${configuration}-iphoneos/Wildloop.app`)
  if (!existsSync(app)) throw new Error(`Xcode did not produce ${app}`)
  validateApp(app, xcode, !unsigned)
  return app
}

function installAndLaunch(app: string, phone: IosPhone, xcode: string): void {
  execute(['xcrun', 'devicectl', 'device', 'install', 'app', '--device', phone.coreDeviceId, app], { env: { DEVELOPER_DIR: xcode } })
  execute(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', phone.coreDeviceId, '--terminate-existing', bundleId], { env: { DEVELOPER_DIR: xcode } })
  console.log(`Wildloop is installed and open on ${phone.name} (${phone.udid}).`)
  console.log('Open wildloop://record from Safari to verify native deep-link delivery.')
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2)
    const args = new Set(argv)
    const compileOnly = args.has('--compile-only')
    const buildOnly = args.has('--build-only') || compileOnly
    const server = deviceServerURL(argv)
    const xcode = developerDir()
    const teamId = requiresDevelopmentTeam(argv) ? developmentTeam() : ''
    const phone = buildOnly ? null : availableIphone(xcode)
    if (!args.has('--skip-generate')) generateProject(xcode, teamId, args.has('--bundled'), server, args.has('--personal-team') || process.env.IOS_PERSONAL_TEAM === '1')
    if (!args.has('--bundled')) console.log(`This iPhone build loads ${server}.`)
    const app = buildForDevice(xcode, teamId, phone, compileOnly)
    if (phone) installAndLaunch(app, phone, xcode)
    else console.log(`Validated iPhone build: ${app}`)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
