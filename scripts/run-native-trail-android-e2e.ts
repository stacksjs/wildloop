import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import mobile from '../config/mobile'
import { QA_PORTS } from '../tests/browser/qa-ports'
import { QA_SOCIAL_ACCOUNT } from '../tests/browser/qa-social-account'
import { decodeRouteParts, primaryRoutePart } from '../resources/functions/trail-geometry'
import { assertAndroidPlatformHealthy, maestroEnvironment, maestroReportSummary, parseAdbDevices, validateGeneratedNativeApp } from './run-mobile-e2e'

interface PersistedReview { id: number, rating: number, content: string }

/** Check server persistence independently of the native screen's local state. */
export function assertNativeReviewPersistence(
  reviews: PersistedReview[], phase: 'create' | 'edit' | 'delete', content: string, previousId?: number,
): number | undefined {
  if (phase === 'delete') {
    if (reviews.length) throw new Error('The native delete did not remove the persisted review.')
    return
  }
  const rating = phase === 'create' ? 5 : 4
  if (reviews.length !== 1 || reviews[0].content !== content || reviews[0].rating !== rating)
    throw new Error(`The native ${phase} did not persist the expected review and rating.`)
  if (phase === 'edit' && reviews[0].id !== previousId)
    throw new Error('Editing created a second review instead of updating the original.')
  return reviews[0].id
}

/** Use only an owned emulator, a disposable database and normally published SDKs. */
export async function runNativeTrailAndroidE2e(): Promise<void> {
  const root = resolve('storage/framework/runtime/e2e/native-trail-android')
  const project = resolve('storage/framework/mobile/android')
  const origin = `http://127.0.0.1:${QA_PORTS.app}`
  await mkdir(root, { recursive: true })
  async function command(args: string[], name: string, env: Record<string, string> = {}): Promise<string> {
    console.log(`Native Android trail QA: ${name}`)
    const child = Bun.spawn(args, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    await writeFile(join(root, `${name}.log`), stdout + stderr)
    if (status) throw new Error(`${args[0]} exited ${status}; see ${name}.log`)
    return stdout
  }
  if (!process.argv.includes('--skip-build')) {
    await command(['bun', 'run', 'build:android'], 'app-build', { MOBILE_URL: `${origin}/feed` })
  }
  validateGeneratedNativeApp(project)
  const config = JSON.parse(await readFile(join(project, 'craft.config.json'), 'utf8'))
  if (config.devServerURL !== `${origin}/feed` || config.mapProvider !== 'maplibre')
    throw new Error('Android trail QA requires its own loopback API and the native MapLibre provider.')
  const gradle = await readFile(join(project, 'app/build.gradle.kts'), 'utf8')
  if (!gradle.includes('org.maplibre.gl:android-sdk:') || gradle.includes('play-services-maps'))
    throw new Error('Android trail QA requires the real key-free native map SDK.')
  if (process.argv.includes('--build-only')) return

  const devices = parseAdbDevices(await command(['adb', 'devices'], 'devices'))
  const device = process.env.NATIVE_QA_ANDROID_DEVICE
  if (!device || !/^emulator-\d+$/.test(device) || !devices.includes(device)) throw new Error('NATIVE_QA_ANDROID_DEVICE must name an owned, ready emulator.')
  const adb = (args: string[], name: string) => command(['adb', '-s', device, ...args], name)
  const platformEvents = async (phase: string) => {
    const events = await adb(['logcat', '-b', 'events', '-d', '-v', 'threadtime'], `platform-${phase}`)
    assertAndroidPlatformHealthy(events)
  }
  await platformEvents('before')
  for (const port of [QA_PORTS.app, QA_PORTS.api]) {
    const occupied = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false)
    if (occupied) throw new Error(`QA port ${port} is occupied; select a different QA_PORT_BASE.`)
  }
  const qa = Bun.spawn(['bun', 'scripts/start-recording-qa.ts'], { stdout: Bun.file(join(root, 'qa-server.log')), stderr: 'inherit' })
  const forwards: number[] = []
  try {
    const deadline = Date.now() + 180000
    while (!await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)) {
      if (qa.exitCode !== null || Date.now() > deadline) throw new Error('Isolated native QA server did not become ready.')
      await Bun.sleep(250)
    }
    for (const port of [QA_PORTS.app, QA_PORTS.api]) {
      await adb(['reverse', `tcp:${port}`, `tcp:${port}`], `reverse-${port}`)
      forwards.push(port)
    }
    const listed = await (await fetch(`${origin}/api/trails?q=Craggy&country=all&limit=10`)).json() as any
    let trail: any
    for (const candidate of listed.trails ?? []) {
      const detail = await (await fetch(`${origin}/api/trails/${candidate.id}`)).json() as any
      if (detail.trail?.hasGeometry) { trail = detail.trail; break }
    }
    if (!trail) throw new Error('Native Android QA requires its seeded recorded route.')
    const profileResponse = await fetch(`${origin}/api/trails/${trail.id}/profile`)
    if (!profileResponse.ok) throw new Error('Native Android QA requires the trail profile endpoint to be available.')
    const profile = (await profileResponse.json()) as { points: Array<{ mi: number, ft: number | null }> }
    const endpoint = profile.points?.at(-1)
    if (!endpoint || profile.points.length < 2 || !Number.isFinite(endpoint.mi) || (endpoint.ft !== null && !Number.isFinite(endpoint.ft)))
      throw new Error('Native Android QA requires a selectable recorded route profile.')
    const endElevation = endpoint.ft === null ? 'elevation unavailable' : `${endpoint.ft} ft`
    const first = primaryRoutePart([...decodeRouteParts(trail.geometry), ...(Array.isArray(trail.pieceRoutes) ? trail.pieceRoutes : [])])[0]
    if (!first) throw new Error('The seeded trail has no recorded route start.')
    await adb(['emu', 'geo', 'fix', String(first[1]), String(first[0])], 'seed-location')
    const reviews = async (): Promise<PersistedReview[]> => {
      const response = await fetch(`${origin}/api/trails/${trail.id}/reviews`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`Reading persisted reviews failed: ${response.status}`)
      return ((await response.json()) as any).reviews
    }
    if ((await reviews()).length) throw new Error('The isolated trail must start without reviews.')
    await adb(['install', '-r', join(project, 'app/build/outputs/apk/debug/app-debug.apk')], 'app-install')
    const marker = crypto.randomUUID().slice(0, 8)
    const review = `Android QA ${marker}: clear signs and a beautiful ridge.`
    const edit = `Android QA ${marker}: updated after a return visit.`
    const variables = {
      APP_ID: mobile.android.packageName, TRAIL_ID: String(trail.id), TRAIL_NAME: trail.name,
      E2E_EMAIL: QA_SOCIAL_ACCOUNT.email, E2E_PASSWORD: QA_SOCIAL_ACCOUNT.sessionSecret,
      REVIEW_TEXT: review, EDITED_REVIEW_TEXT: edit,
      PROFILE_END_TEXT: `${endpoint.mi.toFixed(2)} mi · ${endElevation}`,
      INLINE_PROFILE_END_TEXT: `${endpoint.mi.toFixed(2)} mi, ${endElevation}`,
      GPX_NAME: `${trail.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80)}.gpx`,
    }
    let reviewId: number | undefined
    for (const phase of ['maps', 'utilities', 'sharing', 'directions', 'directions-map', 'review-create', 'review-edit', 'review-delete'] as const) {
      const report = join(root, `${phase}.xml`)
      await command([
        'maestro', `--device=${device}`, '--no-ansi', 'test',
        ...Object.entries(variables).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
        '--format', 'junit', '--output', report, '--debug-output', join(root, 'debug', phase),
        '--test-output-dir', join(root, 'tests', phase), `.maestro/native-trail/${phase}.yaml`,
      ], phase, maestroEnvironment())
      const summary = maestroReportSummary(await readFile(report, 'utf8'))
      if (!summary.tests || summary.failures || summary.skipped) throw new Error(`Native Android ${phase} did not execute and pass every required test.`)
      if (phase.startsWith('review-')) {
        const saved = await reviews()
        await writeFile(join(root, `${phase}-persistence.json`), JSON.stringify(saved, null, 2))
        const action = phase === 'review-create' ? 'create' : phase === 'review-edit' ? 'edit' : 'delete'
        reviewId = assertNativeReviewPersistence(saved, action, action === 'create' ? review : edit, reviewId)
      }
      if (phase === 'utilities') {
        const files = await adb(['shell', 'run-as', mobile.android.packageName, 'find', '.', '-type', 'f'], 'export-files')
        const paths = files.split(/\r?\n/).filter(path => /^[a-zA-Z0-9_./-]+\.gpx$/.test(path))
        let exported = false
        for (const path of paths) {
          const xml = await adb(['exec-out', 'run-as', mobile.android.packageName, 'cat', path], 'exported-gpx')
          if (xml.includes('<gpx ') && xml.includes('<trkseg>') && xml.includes(`<trkpt lat="${first[0]}" lon="${first[1]}"`)) exported = true
        }
        if (!exported) throw new Error('The native GPX export did not contain the recorded route coordinates.')
      }
      if (phase === 'directions' || phase === 'directions-map') {
        const activities = await adb(['shell', 'dumpsys', 'activity', 'activities'], `${phase}-activities`)
        const resumed = activities.split('\n').filter(line => /(?:mResumedActivity|topResumedActivity):/.test(line))
        const expectedHandler = /\b(?:com\.google\.android\.apps\.maps|com\.android\.chrome)\//
        const unfinishedActivity = /(?:ResolverActivity|ChooserActivity|FirstRunActivity)\b/
        if (!resumed.length || resumed.some(line => !expectedHandler.test(line) || unfinishedActivity.test(line)))
          throw new Error('Directions did not reach ready Chrome or Google Maps on the stock Play test device.')
      }
      await platformEvents(phase)
    }
    console.log('Native Android maps, sticky actions, location, GPX, route customization, actual share-link paste and persisted review create/edit/delete passed.')
  }
  finally {
    await adb(['logcat', '-d', '-s', 'CraftNativeAndroid:V', 'AndroidRuntime:E'], 'app-runtime').catch(() => {})
    await adb(['shell', 'uiautomator', 'dump', '/sdcard/wildloop-trail-final.xml'], 'final-tree').then(() =>
      adb(['pull', '/sdcard/wildloop-trail-final.xml', join(root, 'final-tree.xml')], 'pull-final-tree')).catch(() => {})
    for (const port of forwards) await adb(['reverse', '--remove', `tcp:${port}`], `remove-reverse-${port}`).catch(() => {})
    qa.kill('SIGTERM')
    await qa.exited
  }
}

if (import.meta.main) await runNativeTrailAndroidE2e()
