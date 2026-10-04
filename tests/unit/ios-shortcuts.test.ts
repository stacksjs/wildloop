import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  conflictingProviders,
  donatedActivityTypes,
  iosShortcutsSwift,
  shortcutsSourcePath,
  swiftPhraseLiteral,
  swiftIdentifier,
  swiftString,
  withActivityTypes,
  writeActivityTypes,
  writeIosShortcuts,
} from '../../scripts/generate-ios-shortcuts'
import { APP_SHORTCUTS } from '../../resources/functions/app-shortcuts'
import { TRAIL_SPOTLIGHT_SLOTS, trailSpotlightActions } from '../../resources/functions/trail-spotlight'

/** The shape Craft's template emits: nested dicts, root dict last. */
const CRAFT_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>org.wildloop.app</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSExceptionDomains</key>
        <dict>
            <key>localhost</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <true/>
            </dict>
        </dict>
    </dict>
</dict>
</plist>
`

const options = { appName: 'Wildloop', scheme: 'wildloop' }

describe('Swift building blocks', () => {
  it('escapes what would end a string literal', () => {
    expect(swiftString('Trails "near" me')).toBe('"Trails \\"near\\" me"')
    expect(swiftString('back\\slash')).toBe('"back\\\\slash"')
  })

  it('turns an id into a type name', () => {
    expect(swiftIdentifier('trails-near-me')).toBe('TrailsNearMe')
    expect(swiftIdentifier('view_stats')).toBe('ViewStats')
    expect(swiftIdentifier('3d-view')).toBe('Shortcut3dView')
  })

  it('carries the application-name token as a real interpolation', () => {
    // One backslash, not two: escaped, the processor rejects the utterance.
    expect(swiftPhraseLiteral('Show my stats in Wildloop', 'Wildloop')).toBe('"Show my stats in \\(.applicationName)"')
    expect(swiftPhraseLiteral('Show my stats', 'Wildloop')).toBe('"Show my stats with \\(.applicationName)"')
  })

  it('still escapes the text around the token', () => {
    expect(swiftPhraseLiteral('Open "Wildloop" now', 'Wildloop')).toBe('"Open \\"\\(.applicationName)\\" now"')
  })
})

describe('the generated Swift', () => {
  const swift = iosShortcutsSwift(options)

  it('declares one intent per shortcut and one provider', () => {
    expect(swift).toContain('struct OpenFavoritesIntent: AppIntent')
    expect(swift).toContain('struct OpenTrailsNearMeIntent: AppIntent')
    expect(swift).toContain('struct OpenViewStatsIntent: AppIntent')
    expect(swift.match(/AppShortcutsProvider/g)).toHaveLength(1)
    expect(swift).toContain('struct WildloopAppShortcuts: AppShortcutsProvider')
  })

  it('opens each shortcut’s own deep link', () => {
    expect(swift).toContain('URL(string: "wildloop://profile?tab=saved")')
    expect(swift).toContain('URL(string: "wildloop://trails?near=me")')
    expect(swift).toContain('URL(string: "wildloop://stats")')
    // Awaited inside perform(): the async overload is what an async context
    // resolves to, and Xcode rejects it bare.
    expect(swift.match(/await UIApplication\.shared\.open\(url\)/g)).toHaveLength(APP_SHORTCUTS.length)
  })

  it('brings the app forward, since the link is what places it', () => {
    expect(swift.match(/static var openAppWhenRun: Bool = true/g)).toHaveLength(APP_SHORTCUTS.length)
  })

  it('offers every shortcut to Spotlight, with its title and symbol', () => {
    for (const shortcut of APP_SHORTCUTS) {
      expect(swift).toContain(`shortTitle: "${shortcut.title}"`)
      expect(swift).toContain(`systemImageName: "${shortcut.symbol}"`)
    }
    expect(swift.match(/AppShortcut\(\n {12}intent:/g)).toHaveLength(APP_SHORTCUTS.length)
  })

  it('states the iOS version every one of these types needs', () => {
    // 16.4, not the app's 16.0 deployment target: the AppShortcut initializer
    // that takes shortTitle and systemImageName is 16.4+, and a 16.0
    // attribute over it does not compile.
    expect(swift.match(/@available\(iOS 16\.4, \*\)/g)).toHaveLength(APP_SHORTCUTS.length + 1)
    expect(swift).not.toContain('@available(iOS 16.0')
    expect(swift).toContain('import AppIntents')
    expect(swift).toContain('import UIKit')
  })

  it('follows the scheme the build registered', () => {
    expect(iosShortcutsSwift({ appName: 'Wildloop', scheme: 'wildloop-dev' }))
      .toContain('URL(string: "wildloop-dev://stats")')
  })

  it('never doubles the backslash in an utterance, which fails metadata export', () => {
    // `\\(.applicationName)` in the file is a literal, not an interpolation,
    // and appintentsmetadataprocessor rejects the whole target for it.
    expect(swift.includes('\\\\(.applicationName)')).toBe(false)
    expect(swift.split('\\(.applicationName)').length - 1).toBe(APP_SHORTCUTS.length)
  })

  it('says it is generated, and where from', () => {
    expect(swift.startsWith('// Generated by scripts/generate-ios-shortcuts.ts')).toBe(true)
    expect(swift).toContain('resources/functions/app-shortcuts.ts')
  })
})

describe('writing into a project', () => {
  async function project(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'wildloop-ios-'))
    await mkdir(join(dir, 'Sources'), { recursive: true })
    return dir
  }

  it('lands beside the app’s other sources', async () => {
    const dir = await project()
    const path = await writeIosShortcuts(dir, options)

    expect(path).toBe(shortcutsSourcePath(dir, 'Wildloop'))
    expect(path.endsWith('Sources/WildloopAppShortcuts.swift')).toBe(true)
    expect(await Bun.file(path).text()).toContain('AppShortcutsProvider')
  })

  it('notices another provider, which iOS would leave ambiguous', async () => {
    const dir = await project()
    const ours = await writeIosShortcuts(dir, options)
    expect(await conflictingProviders(dir, ours)).toEqual([])

    const theirs = join(dir, 'Sources', 'CraftAppExtensions.swift')
    await writeFile(theirs, 'struct CraftShortcuts: AppShortcutsProvider {}\n')
    expect(await conflictingProviders(dir, ours)).toEqual([theirs])
  })

  /*
   * The script used to report its own output.
   *
   * `appName` was once capitalised differently, and Craft never prunes the
   * sources it regenerates around, so the file that spelling produced outlived
   * it. On macOS the write lands back in that same inode and `readdir` returns
   * the name it was created with, which an exact compare reads as somebody
   * else's provider — a warning on every iOS build, about nothing.
   */
  it('does not report its own file back under a different capitalisation', async () => {
    const dir = await project()
    // Written under the old spelling, asked about under the new one: this is
    // exactly what `readdir` hands back on a case-insensitive filesystem after
    // the write has already landed in that file.
    const onDisk = join(dir, 'Sources', 'WildLoopAppShortcuts.swift')
    await writeFile(onDisk, 'struct WildloopAppShortcuts: AppShortcutsProvider {}\n')

    const ours = join(dir, 'Sources', 'WildloopAppShortcuts.swift')
    expect(await conflictingProviders(dir, ours)).toEqual([])
  })

  /*
   * And the half that only a case-sensitive filesystem would have shown: there
   * the stale file is a second file, declaring a second provider, and iOS
   * honours whichever it likes. One has to go, and it is not the fresh one.
   */
  it('clears a stale provider left under a different capitalisation', async () => {
    const dir = await project()
    const stale = join(dir, 'Sources', 'WildLoopAppShortcuts.swift')
    await writeFile(stale, 'struct WildLoopAppShortcuts: AppShortcutsProvider {}\n')

    const ours = await writeIosShortcuts(dir, options)
    const providers = (await readdir(join(dir, 'Sources')))
      .filter(entry => entry.toLowerCase().endsWith('appshortcuts.swift'))

    // One file, and under the spelling this run asked for. The count alone
    // proves nothing on a case-insensitive filesystem, where the stale file
    // absorbs the write and stays the only one either way — what separates
    // the two is whose name survived.
    expect(providers).toEqual(['WildloopAppShortcuts.swift'])
    expect(await Bun.file(ours).text()).toContain('AppShortcutsProvider')
  })

  it('leaves a provider that is genuinely another file alone', async () => {
    const dir = await project()
    const ours = await writeIosShortcuts(dir, options)
    const theirs = join(dir, 'Sources', 'OtherAppShortcuts.swift')
    await writeFile(theirs, 'struct OtherAppShortcuts: AppShortcutsProvider {}\n')

    await writeIosShortcuts(dir, options)
    expect(existsSync(theirs)).toBe(true)
    expect(await conflictingProviders(dir, ours)).toEqual([theirs])
  })
})

describe('what it deliberately leaves to Craft', () => {
  it('declares no quick-action handler, which Craft\u2019s own delegate already has', () => {
    // The simulator build rejected a second one: "invalid redeclaration of
    // 'application(_:performActionFor:completionHandler:)'".
    const swift = iosShortcutsSwift(options)
    expect(swift).not.toContain('performActionFor')
    expect(swift).not.toContain('extension')
  })
})

describe('the activity types a tapped entry needs declared', () => {
  it('declares every action the app donates, under the bundle id', () => {
    const types = donatedActivityTypes('org.wildloop.app')

    for (const shortcut of APP_SHORTCUTS)
      expect(types).toContain(`org.wildloop.app.${shortcut.id}`)
    for (const action of trailSpotlightActions())
      expect(types).toContain(`org.wildloop.app.${action}`)

    expect(types).toHaveLength(APP_SHORTCUTS.length + TRAIL_SPOTLIGHT_SLOTS)
    expect(new Set(types).size).toBe(types.length)
  })

  it('declares them in the root dictionary, not a nested one', () => {
    const plist = withActivityTypes(CRAFT_PLIST, ['org.wildloop.app.favorites'])

    expect(plist).toContain('    <key>NSUserActivityTypes</key>')
    expect(plist).toContain('        <string>org.wildloop.app.favorites</string>')
    // Still well-formed, and the declaration is inside the document's own dict.
    expect(plist.split('<dict>')).toHaveLength(plist.split('</dict>').length)
    expect(plist.trimEnd().endsWith('</dict>\n</plist>')).toBe(true)
    expect(plist.indexOf('NSUserActivityTypes')).toBeGreaterThan(plist.indexOf('NSAppTransportSecurity'))
  })

  it('replaces what an earlier build declared instead of stacking a second list', () => {
    const once = withActivityTypes(CRAFT_PLIST, ['org.wildloop.app.trail-slot-0', 'org.wildloop.app.trail-slot-1'])
    const again = withActivityTypes(once, ['org.wildloop.app.trail-slot-0'])

    expect(again.split('<key>NSUserActivityTypes</key>')).toHaveLength(2)
    expect(again).not.toContain('trail-slot-1')
    expect(withActivityTypes(once, ['org.wildloop.app.trail-slot-0', 'org.wildloop.app.trail-slot-1'])).toBe(once)
  })

  it('escapes a bundle id that would not be XML', () => {
    expect(withActivityTypes(CRAFT_PLIST, ['org.wild&loop.app.favorites'])).toContain('org.wild&amp;loop.app.favorites')
  })

  it('says so rather than throwing when there is no plist to declare them in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ios-plist-'))
    expect(await writeActivityTypes(dir, 'org.wildloop.app')).toBeNull()

    await writeFile(join(dir, 'Info.plist'), CRAFT_PLIST)
    expect(await writeActivityTypes(dir, 'org.wildloop.app')).toBe(join(dir, 'Info.plist'))
    expect(await Bun.file(join(dir, 'Info.plist')).text()).toContain('org.wildloop.app.trail-slot-3')
  })

  it('refuses a file that is not a plist, rather than appending to it', () => {
    expect(() => withActivityTypes('not a plist', ['org.wildloop.app.favorites'])).toThrow(/root dictionary/)
  })
})
