import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

type MobilePlatform = 'android' | 'ios'

interface IosDevice {
  isAvailable?: boolean
  name: string
  state: string
  udid: string
}

interface SimctlDevices {
  devices?: Record<string, IosDevice[]>
}

const projectRoot = resolve(import.meta.dir, '..')
const generatedRoot = join(projectRoot, 'storage/framework/mobile')
const resultsRoot = join(projectRoot, 'storage/framework/runtime/e2e')
const flowRoot = join(projectRoot, '.maestro/flows')
const testLocation = { latitude: '37.7749', longitude: '-122.4194' }
// Every page reached by the native smoke and deep-link flows must survive the
// bundled fallback. Checking only a pair of tabs let a bad Record or Settings
// bundle pass before the simulator reached it.
const requiredReactivePages = [
  'index.html',
  'feed.html',
  'trails.html',
  'record.html',
  'territories.html',
  'profile.html',
  'settings.html',
  'login.html',
]

function normalizedEnvironment(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function execute(command: string[], options: { capture?: boolean, env?: Record<string, string | undefined> } = {}): string {
  const result = Bun.spawnSync(command, {
    cwd: projectRoot,
    env: normalizedEnvironment(options.env),
    stdout: options.capture ? 'pipe' : 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) throw new Error(`Command failed (${result.exitCode}): ${command.join(' ')}`)
  return options.capture ? result.stdout.toString().trim() : ''
}

function requireCommand(name: string): void {
  if (!Bun.which(name)) throw new Error(`Missing ${name}. Install it before running mobile E2E tests.`)
}

function requirePath(path: string, description: string): void {
  if (!existsSync(path)) throw new Error(`Missing ${description}: ${path}`)
}

export function parseAdbDevices(output: string): string[] {
  return output
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts[1] === 'device')
    .map(parts => parts[0])
}

export function selectAndroidDeepLinkActivity(output: string, packageName: string): string | null {
  for (const line of output.split('\n')) {
    const component = line.trim().split(/\s+/).find(token => token.startsWith(`${packageName}/`))
    if (component) return component
  }
  return null
}

export function selectAndroidHomePackage(output: string): string | null {
  const component = output.split(/\s+/).find(value => value.includes('/'))
  const packageName = component?.split('/')[0]
  return packageName || null
}

export function selectIosSimulator(payload: SimctlDevices): IosDevice | null {
  const candidates = Object.entries(payload.devices ?? {})
    .filter(([runtime]) => runtime.toLowerCase().includes('ios'))
    .sort(([left], [right]) => right.localeCompare(left, undefined, { numeric: true }))
    .flatMap(([, devices]) => devices)
    .filter(device => device.isAvailable !== false && device.name.startsWith('iPhone'))

  return candidates.find(device => device.state === 'Booted') ?? candidates[0] ?? null
}

export function maestroReportSummary(xml: string): { failures: number, tests: number } {
  return {
    failures: xml.match(/<(?:failure|error)\b/g)?.length ?? 0,
    tests: xml.match(/<testcase\b/g)?.length ?? 0,
  }
}

export function deepLinkFlow(platform: MobilePlatform): string {
  return platform === 'ios' ? '02-deep-link-ios.yaml' : '02-deep-link.yaml'
}

export function prepareIosSimulatorBundle(app: string): string {
  // CoreSimulator can reject an otherwise valid iOS app when an embedded
  // watchOS companion is present. The phone app itself is unchanged; only the
  // generated simulator product loses its separately-tested Watch directory.
  rmSync(join(app, 'Watch'), { force: true, recursive: true })
  return app
}

export function validateBundledFrontend(outputRoot: string): void {
  for (const page of requiredReactivePages) {
    const file = join(outputRoot, page)
    requirePath(file, `built ${page}`)
    const html = readFileSync(file, 'utf8')
    if (!html.includes('__stx_latestSetup')) {
      throw new Error(`Built ${page} is missing its reactive STX page setup`)
    }
  }
}

/**
 * Native bottom tabs must perform document navigation. The Android WebView
 * can load a bundled page directly after a cold start, whereas an SPA fragment
 * swap may leave that page's client module unexecuted.
 */
export function validateNativeTabLinks(outputRoot: string): void {
  for (const page of requiredReactivePages) {
    const output = readFileSync(join(outputRoot, page), 'utf8')
    if (!/<div\b(?=[^>]*\bclass="[^"]*\bnative-tab-visibility\b")[^>]*>[\s\S]*?\bnative-tab-bar\b/i.test(output))
      throw new Error(`Built ${page} is missing the native touch-navigation wrapper`)

    for (const route of ['/feed', '/trails', '/record', '/territories', '/profile']) {
      const link = output.match(new RegExp(`<a\\b(?=[^>]*\\bhref="${route}")(?=[^>]*\\bclass="[^"]*\\bnative-tab-item\\b")[^>]*>`, 'i'))?.[0]
      if (!link) throw new Error(`Built ${page} is missing the native ${route} tab link`)
      if (/\bdata-stx-link\b/i.test(link))
        throw new Error(`Built ${page} native ${route} tab must use document navigation`)
    }

    const header = output.match(/<header\b(?=[^>]*\bnative-app-sticky-top\b)[^>]*>[\s\S]*?<\/header>/i)?.[0]
    if (!header)
      throw new Error(`Built ${page} is missing the native header`)

    for (const route of ['/feed', '/notifications', '/settings']) {
      const link = header.match(new RegExp(`<a\\b(?=[^>]*\\bhref="${route}")[^>]*>`, 'i'))?.[0]
      if (!link)
        throw new Error(`Built ${page} is missing the native header ${route} link`)
      if (/\bdata-stx-link\b/i.test(link))
        throw new Error(`Built ${page} native header ${route} link must use document navigation`)
    }
  }
}

/** Shell CSS must arrive in the document head before a bundled WebView paints. */
export function validateNativeShellStyles(outputRoot: string): void {
  for (const page of requiredReactivePages) {
    const output = readFileSync(join(outputRoot, page), 'utf8')
    const head = output.split('</head>', 1)[0]
    if (!head.includes('href="/css/native-shell.css"'))
      throw new Error(`Built ${page} is missing native shell styles in its document head`)
  }
}

/** A document may load analytics once, never once per rendered component. */
export function validateAnalyticsScriptCount(outputRoot: string): void {
  for (const page of ['index.html', 'feed.html', 'trails.html', 'record.html']) {
    const output = readFileSync(join(outputRoot, page), 'utf8')
    const scripts = output.match(/<script\b(?=[^>]*\bsrc="https:\/\/analyticshq\.org\/script\.js")[^>]*>/gi) ?? []
    if (scripts.length > 1)
      throw new Error(`Built ${page} loads analytics ${scripts.length} times`)
  }
}

export function validateIosAppBundle(app: string): string {
  const index = readdirSync(app, { recursive: true })
    .map(path => path.toString())
    .find(path => path === 'index.html' || path.endsWith('/index.html'))
  if (!index) throw new Error(`Built iOS app is missing its bundled index.html: ${app}`)
  const bundledIndex = join(app, index)
  console.log(`Verified bundled iOS entry point: ${bundledIndex}`)
  return bundledIndex
}

function craftSource(platform: MobilePlatform): string | undefined {
  const envName = platform === 'ios' ? 'CRAFT_IOS_SRC' : 'CRAFT_ANDROID_SRC'
  if (process.env[envName]) return process.env[envName]

  const local = resolve(projectRoot, '../../Tools/craft/packages', platform, 'src/index.ts')
  return existsSync(local) ? local : undefined
}

function stxSourceRoot(): string | undefined {
  if (process.env.STX_SOURCE_ROOT) return process.env.STX_SOURCE_ROOT
  const local = resolve(projectRoot, '../../Tools/stx')
  return existsSync(join(local, 'packages/stx/src/build.ts')) ? local : undefined
}

function buildGeneratedApp(platform: MobilePlatform): void {
  const envName = platform === 'ios' ? 'CRAFT_IOS_SRC' : 'CRAFT_ANDROID_SRC'
  const source = craftSource(platform)
  // Use the project script so Bun applies the checked-in STX patch. `bunx
  // @stacksjs/stx` may execute an isolated cache copy and silently bypass it.
  execute(['bun', 'run', 'build:frontend'], {
    env: {
      MOBILE_E2E: '1',
      ...(stxSourceRoot() ? { STX_SOURCE_ROOT: stxSourceRoot() } : {}),
    },
  })
  validateBundledFrontend(join(projectRoot, 'dist'))
  validateNativeTabLinks(join(projectRoot, 'dist'))
  validateNativeShellStyles(join(projectRoot, 'dist'))
  validateAnalyticsScriptCount(join(projectRoot, 'dist'))
  execute(['bun', 'run', `build:${platform}`], {
    env: {
      MOBILE_E2E: '1',
      ...(source ? { [envName]: source } : {}),
    },
  })
}

function runMaestroFlow(platform: MobilePlatform, deviceId: string, flow: string): void {
  requireCommand('maestro')
  requirePath(flowRoot, 'Maestro flow directory')

  const platformResults = join(resultsRoot, platform)
  const slug = flow.replace(/\.yaml$/, '')
  const report = join(platformResults, `${slug}.xml`)
  mkdirSync(platformResults, { recursive: true })
  execute([
    'maestro',
    `--device=${deviceId}`,
    '--no-ansi',
    'test',
    '--env',
    `APP_ID=${appId(platform)}`,
    '--format',
    'junit',
    '--output',
    report,
    '--debug-output',
    join(platformResults, 'debug', slug),
    '--test-output-dir',
    join(platformResults, 'tests', slug),
    join(flowRoot, flow),
  ])

  const summary = maestroReportSummary(readFileSync(report, 'utf8'))
  if (summary.tests === 0) throw new Error(`Maestro ran no ${platform} tests`)
  if (summary.failures > 0) throw new Error(`Maestro reported ${summary.failures} failed ${platform} test(s)`)
}

function runMaestroJourneys(platform: MobilePlatform, deviceId: string): void {
  runMaestroFlow(platform, deviceId, '01-navigation.yaml')
  runMaestroFlow(platform, deviceId, '03-offline-bundle.yaml')

  if (platform === 'android') {
    const target = execute([
      'adb', '-s', deviceId, 'shell', 'cmd', 'package', 'query-activities', '--brief',
      '-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE', '-d', 'wildloop://record',
    ], { capture: true })
    const component = selectAndroidDeepLinkActivity(target, appId('android'))
    if (!component) throw new Error(`Android did not register wildloop:// for ${appId('android')}`)
    execute([
      'adb', '-s', deviceId, 'shell', 'am', 'start', '-W',
      '-n', component,
      '-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE',
      '-d', 'wildloop://record',
    ])
  }
  else {
    execute(['xcrun', 'simctl', 'openurl', deviceId, 'wildloop://record'])
  }

  runMaestroFlow(platform, deviceId, deepLinkFlow(platform))
}

/**
 * Craft reads from the platform location providers directly. Maestro's
 * coordinate command completes but does not currently populate those bridges,
 * so seed the emulator provider before each deterministic E2E journey.
 */
function seedTestLocation(platform: MobilePlatform, deviceId: string): void {
  if (platform === 'android') {
    execute([
      'adb', '-s', deviceId, 'emu', 'geo', 'fix',
      testLocation.longitude, testLocation.latitude,
    ])
    return
  }

  execute([
    'xcrun', 'simctl', 'location', deviceId, 'set',
    `${testLocation.latitude},${testLocation.longitude}`,
  ])
}

/**
 * Google APIs images occasionally leave Pixel Launcher in an ANR state while
 * WildLoop is foregrounded. The launcher is not part of this journey, so stop
 * that background process before Maestro launches the app under test.
 */
function stopAndroidHomeLauncher(deviceId: string): void {
  const home = execute([
    'adb', '-s', deviceId, 'shell', 'cmd', 'package', 'resolve-activity', '--brief',
    '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME',
  ], { capture: true })
  const packageName = selectAndroidHomePackage(home)
  if (packageName)
    execute(['adb', '-s', deviceId, 'shell', 'am', 'force-stop', packageName])
}

function appId(platform: MobilePlatform): string {
  return platform === 'ios'
    ? process.env.IOS_BUNDLE_ID ?? 'org.wildloop.app'
    : process.env.ANDROID_PACKAGE_NAME ?? 'org.wildloop.app'
}

function runAndroid(preview: boolean): void {
  requireCommand('adb')
  const devices = parseAdbDevices(execute(['adb', 'devices'], { capture: true }))
  if (devices.length !== 1) throw new Error(`Expected exactly one ready Android device, found ${devices.length}`)

  const apk = process.env.MOBILE_E2E_APP
    ?? join(generatedRoot, 'android/app/build/outputs/apk/debug/app-debug.apk')
  requirePath(apk, 'Android E2E APK')
  execute(['adb', '-s', devices[0], 'install', '-r', apk])
  if (preview) {
    execute(['adb', '-s', devices[0], 'shell', 'am', 'force-stop', appId('android')])
    execute(['adb', '-s', devices[0], 'shell', 'monkey', '-p', appId('android'), '-c', 'android.intent.category.LAUNCHER', '1'])
    console.log(`WildLoop is open on Android device ${devices[0]}.`)
  }
  else {
    stopAndroidHomeLauncher(devices[0])
    seedTestLocation('android', devices[0])
    runMaestroJourneys('android', devices[0])
  }
}

function runIos(preview: boolean): void {
  requireCommand('xcodebuild')
  requireCommand('xcrun')

  const payload = JSON.parse(execute(['xcrun', 'simctl', 'list', 'devices', 'available', '-j'], { capture: true })) as SimctlDevices
  const device = selectIosSimulator(payload)
  if (!device) throw new Error('No available iPhone simulator is installed')
  if (device.state !== 'Booted') execute(['xcrun', 'simctl', 'boot', device.udid])
  execute(['xcrun', 'simctl', 'bootstatus', device.udid, '-b'])

  const derivedData = process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, 'wildloop-ios-derived-data')
    : join(resultsRoot, 'derived-data/ios')
  const project = join(generatedRoot, 'ios/WildLoop.xcodeproj')
  requirePath(project, 'generated WildLoop Xcode project')
  mkdirSync(derivedData, { recursive: true })
  execute([
    'xcodebuild',
    '-project', project,
    '-scheme', 'WildLoop',
    '-destination', `platform=iOS Simulator,id=${device.udid}`,
    '-derivedDataPath', derivedData,
    '-configuration', 'Debug',
    'CODE_SIGNING_ALLOWED=NO',
    'build',
  ])

  const app = process.env.MOBILE_E2E_APP
    ?? join(derivedData, 'Build/Products/Debug-iphonesimulator/WildLoop.app')
  requirePath(app, 'iOS E2E app')
  validateIosAppBundle(app)
  execute(['xcrun', 'simctl', 'install', device.udid, prepareIosSimulatorBundle(app)])
  if (preview) {
    requireCommand('open')
    execute(['open', '-a', 'Simulator'])
    execute(['xcrun', 'simctl', 'launch', '--terminate-running-process', device.udid, appId('ios')])
    console.log(`WildLoop is open in Simulator on ${device.name}.`)
  }
  else {
    seedTestLocation('ios', device.udid)
    runMaestroJourneys('ios', device.udid)
  }
}

function usage(): never {
  throw new Error('Usage: bun scripts/run-mobile-e2e.ts <ios|android> [--preview|--build-only|--skip-build]')
}

export function requestedPlatform(args: string[]): MobilePlatform {
  const platform = args.find(value => value === 'ios' || value === 'android')
  if (!platform) return usage()
  return platform
}

if (import.meta.main) {
  try {
    const platform = requestedPlatform(process.argv.slice(2))
    const preview = process.argv.includes('--preview')
    const buildOnly = process.argv.includes('--build-only')
    const skipBuild = process.argv.includes('--skip-build')
    if (buildOnly && skipBuild) throw new Error('--build-only and --skip-build cannot be combined')
    if (preview && buildOnly) throw new Error('--preview and --build-only cannot be combined')
    if (!preview && !buildOnly) requireCommand('maestro')

    if (!skipBuild) buildGeneratedApp(platform)
    if (!buildOnly) platform === 'ios' ? runIos(preview) : runAndroid(preview)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
