import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deepLinkFlow, maestroReportSummary, parseAdbDevices, prepareIosSimulatorBundle, requestedPlatform, selectAndroidDeepLinkActivity, selectIosSimulator, validateBundledFrontend, validateIosAppBundle, validateNativeTabLinks } from '../../scripts/run-mobile-e2e'
import { inferDevelopmentTeam, selectAvailableIphone } from '../../scripts/run-ios-device'

describe('mobile E2E runner', () => {
  it('selects a booted iPhone before a shutdown simulator', () => {
    expect(selectIosSimulator({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
          { isAvailable: true, name: 'iPhone 17', state: 'Shutdown', udid: 'shutdown' },
          { isAvailable: true, name: 'iPhone 17 Pro', state: 'Booted', udid: 'booted' },
        ],
        'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [
          { isAvailable: true, name: 'Apple Watch', state: 'Booted', udid: 'watch' },
        ],
      },
    })?.udid).toBe('booted')
  })

  it('returns only ready Android devices', () => {
    expect(parseAdbDevices('List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n')).toEqual(['emulator-5554'])
  })

  it('selects only an available physical iPhone', () => {
    expect(selectAvailableIphone({
      result: {
        devices: [
          {
            identifier: 'core-unavailable',
            properties: {
              connection: { state: 'unavailable' },
              hardware: { deviceType: 'iPhone', platform: 'iOS', udid: 'phone-offline' },
              state: { name: 'Offline iPhone' },
            },
          },
          {
            identifier: 'core-ready',
            properties: {
              connection: { state: 'available' },
              hardware: { deviceType: 'iPhone', platform: 'iOS', udid: 'phone-ready' },
              state: { name: 'Trail Phone' },
            },
          },
        ],
      },
    })?.udid).toBe('phone-ready')
  })

  it('infers an unambiguous Apple development team', () => {
    expect(inferDevelopmentTeam('1) ABC "Apple Development: Chris (DXBQ84FJL4)"')).toBe('DXBQ84FJL4')
    expect(inferDevelopmentTeam('0 valid identities found')).toBeNull()
  })

  it('selects the app activity registered for an Android deep link', () => {
    const output = '2 activities found:\ncom.android.browser/.BrowserActivity\norg.wildloop.app/org.wildloop.app.MainActivity\n'
    expect(selectAndroidDeepLinkActivity(output, 'org.wildloop.app')).toBe('org.wildloop.app/org.wildloop.app.MainActivity')
    expect(selectAndroidDeepLinkActivity(output, 'org.missing.app')).toBeNull()
  })

  it('accepts only supported platform arguments', () => {
    expect(requestedPlatform(['--verbose', 'android'])).toBe('android')
    expect(requestedPlatform(['ios'])).toBe('ios')
    expect(() => requestedPlatform(['web'])).toThrow('Usage:')
  })

  it('uses the flow matching each platform link confirmation behavior', () => {
    expect(deepLinkFlow('android')).toBe('02-deep-link.yaml')
    expect(deepLinkFlow('ios')).toBe('02-deep-link-ios.yaml')
  })

  it('reads failures from Maestro JUnit even when its process exits successfully', () => {
    expect(maestroReportSummary(`
      <testsuite tests="2" failures="1">
        <testcase name="pass" />
        <testcase name="fail"><failure>not visible</failure></testcase>
      </testsuite>
    `)).toEqual({ failures: 1, tests: 2 })
  })

  it('removes only the embedded Watch app from simulator products', () => {
    const app = mkdtempSync(join(tmpdir(), 'wildloop-ios-simulator-'))
    mkdirSync(join(app, 'Watch'))
    mkdirSync(join(app, 'PlugIns'))

    expect(prepareIosSimulatorBundle(app)).toBe(app)
    expect(existsSync(join(app, 'Watch'))).toBe(false)
    expect(existsSync(join(app, 'PlugIns'))).toBe(true)
  })

  it('rejects a mobile bundle that lost reactive page setup', () => {
    const output = mkdtempSync(join(tmpdir(), 'wildloop-mobile-dist-'))
    const reactivePage = '<script>window.__stx_latestSetup = () => ({})</script>'
    for (const page of ['index.html', 'feed.html', 'trails.html', 'territories.html', 'profile.html', 'settings.html', 'login.html'])
      writeFileSync(join(output, page), reactivePage)
    writeFileSync(join(output, 'record.html'), '<main>Record</main>')

    expect(() => validateBundledFrontend(output)).toThrow('record.html is missing its reactive STX page setup')
  })

  it('rejects native tabs that would be intercepted by the SPA router', () => {
    const output = mkdtempSync(join(tmpdir(), 'wildloop-mobile-tabs-'))
    writeFileSync(join(output, 'index.html'), [
      '<header class="native-app-sticky-top">',
      '<a href="/feed">',
      '<a href="/notifications">',
      '<a href="/settings">',
      '</header>',
      '<a href="/feed" class="native-tab-item" data-stx-link>',
      '<a href="/trails" class="native-tab-item">',
      '<a href="/record" class="native-tab-item">',
      '<a href="/territories" class="native-tab-item">',
      '<a href="/profile" class="native-tab-item">',
    ].join(''))

    expect(() => validateNativeTabLinks(output)).toThrow('Built native /feed tab must use document navigation')
  })

  it('rejects native header links that would be intercepted by the SPA router', () => {
    const output = mkdtempSync(join(tmpdir(), 'wildloop-mobile-header-'))
    writeFileSync(join(output, 'index.html'), [
      '<header class="native-app-sticky-top">',
      '<a href="/feed">',
      '<a href="/notifications">',
      '<a href="/settings" data-stx-link>',
      '</header>',
      '<a href="/feed" class="native-tab-item">',
      '<a href="/trails" class="native-tab-item">',
      '<a href="/record" class="native-tab-item">',
      '<a href="/territories" class="native-tab-item">',
      '<a href="/profile" class="native-tab-item">',
    ].join(''))

    expect(() => validateNativeTabLinks(output)).toThrow('Built native header /settings link must use document navigation')
  })

  it('locates the bundled iOS entry point before simulator installation', () => {
    const root = mkdtempSync(join(tmpdir(), 'wildloop-ios-app-'))
    const resources = join(root, 'WildLoop.app', 'dist')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'index.html'), '<main>WildLoop</main>')

    expect(validateIosAppBundle(join(root, 'WildLoop.app'))).toBe(join(resources, 'index.html'))
  })

  it('rejects an iOS app product with no bundled entry point', () => {
    const root = mkdtempSync(join(tmpdir(), 'wildloop-empty-app-'))
    mkdirSync(join(root, 'WildLoop.app'), { recursive: true })

    expect(() => validateIosAppBundle(join(root, 'WildLoop.app'))).toThrow('missing its bundled index.html')
  })
})
