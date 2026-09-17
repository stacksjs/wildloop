#!/usr/bin/env bun
/**
 * Generate the App Intents that put WildLoop's shortcuts in Spotlight and Siri.
 *
 * This is the surface in the reference screenshot: searching the app's name
 * shows a Top Hit row of round buttons — Favorites, Trails Near Me, View Stats
 * — under the icon. That row comes from `AppShortcutsProvider`, which is Swift
 * compiled into the app target, so it cannot be declared from the web layer
 * the way the home-screen quick actions can (see useNativeShortcuts).
 *
 * Craft owns the iOS project, and its templates emit no app-specific intents,
 * so this writes one Swift file into the generated project and re-runs
 * xcodegen so the target picks it up. Everything about the shortcuts — their
 * names, symbols, phrases and routes — comes from the same catalogue the other
 * surfaces read, and each intent opens its route as a `wildloop://` link,
 * which is the path Craft already delivers to the webview.
 *
 *   bun scripts/generate-ios-shortcuts.ts [projectDir]
 */
/* eslint-disable ts/no-top-level-await */
import type { AppShortcut } from '../resources/functions/app-shortcuts'
import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { APP_SHORTCUTS, appShortcutDeepLink } from '../resources/functions/app-shortcuts'

/**
 * The iOS version these types need.
 *
 * Not 16.0, which is the app's deployment target and where `AppIntent` and
 * `AppShortcutsProvider` first appeared: the `AppShortcut` initializer that
 * takes `shortTitle` and `systemImageName` — the two things that draw the
 * round button in Spotlight's Top Hit row — arrived in 16.4, and building
 * against it under a 16.0 availability attribute does not compile. Below 16.4
 * the app simply offers no shortcuts.
 */
export const SHORTCUTS_MIN_IOS = '16.4'

export interface IosShortcutsOptions {
  /** The app's display name, used for the provider type and the Siri token. */
  appName: string
  /** The URL scheme registered by the build, without `://`. */
  scheme: string
  shortcuts?: AppShortcut[]
  /**
   * Craft's application delegate, when one was found in the project.
   *
   * Given it, this file also routes a tapped home-screen quick action — see
   * `delegateExtension`. Left out, the intents are still generated and the
   * quick actions merely open the app.
   */
  delegateType?: string
}

/** A Swift string literal, with the two characters that would end it escaped. */
export function swiftString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** `trails-near-me` → `TrailsNearMe`, so it can name a Swift type. */
export function swiftIdentifier(value: string): string {
  const parts = value.split(/[^a-z0-9]+/i).filter(Boolean)
  const name = parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  return /^[a-z]/i.test(name) ? name : `Shortcut${name}`
}

/**
 * A phrase with the app's name replaced by the token Apple requires.
 *
 * Every App Shortcut phrase has to carry `\(.applicationName)` — a phrase
 * without it is rejected at build time — and the catalogue writes the name out
 * in full because that is what reads correctly everywhere else.
 */
export function sirifyPhrase(phrase: string, appName: string): string {
  const token = '\\(.applicationName)'
  const withToken = phrase.replace(new RegExp(escapeRegExp(appName), 'gi'), token)
  return withToken.includes(token) ? withToken : `${phrase} with ${token}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The Swift for the whole file.
 *
 * Every intent opens the app and then opens its own deep link, rather than
 * carrying the navigation itself: the webview is where the app's routing
 * lives, and `UIApplication.open` lands in Craft's `onOpenURL`, which already
 * forwards to it. That keeps this file free of anything that could disagree
 * with the app — it knows a URL and nothing else.
 */
export function iosShortcutsSwift(options: IosShortcutsOptions): string {
  const shortcuts = options.shortcuts ?? APP_SHORTCUTS
  const providerName = `${swiftIdentifier(options.appName)}AppShortcuts`

  const intents = shortcuts.map((shortcut) => {
    const name = `Open${swiftIdentifier(shortcut.id)}Intent`
    const link = appShortcutDeepLink(shortcut, options.scheme)

    return `@available(iOS ${SHORTCUTS_MIN_IOS}, *)
struct ${name}: AppIntent {
    static var title: LocalizedStringResource = ${swiftString(shortcut.title)}
    static var description = IntentDescription(${swiftString(shortcut.subtitle)})

    // The app comes forward first; the URL below is what decides where in it.
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if let url = URL(string: ${swiftString(link)}) {
            UIApplication.shared.open(url)
        }
        return .result()
    }
}`
  })

  const entries = shortcuts.map((shortcut) => {
    const name = `Open${swiftIdentifier(shortcut.id)}Intent`
    return `        AppShortcut(
            intent: ${name}(),
            phrases: [
                ${swiftString(sirifyPhrase(shortcut.phrase, options.appName))}
            ],
            shortTitle: ${swiftString(shortcut.title)},
            systemImageName: ${swiftString(shortcut.symbol)}
        )`
  })

  return `// Generated by scripts/generate-ios-shortcuts.ts — do not edit.
//
// The shortcuts offered in Spotlight and Siri, built from
// resources/functions/app-shortcuts.ts. Regenerate with:
//
//     bun scripts/generate-ios-shortcuts.ts
//
// Each intent opens a ${options.scheme}:// link, which Craft delivers to the
// webview through its existing deep-link path.

import AppIntents
import UIKit

${intents.join('\n\n')}

@available(iOS ${SHORTCUTS_MIN_IOS}, *)
struct ${providerName}: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
${entries.join('\n')}
    }
}
${options.delegateType ? `\n${delegateExtension(options.delegateType)}\n` : ''}`
}

/**
 * The extension that makes a tapped quick action land somewhere.
 *
 * Craft can SET the home-screen shortcuts — `useNativeShortcuts` registers
 * them — but nothing in its app handles one being tapped: there is no
 * `performActionFor`, and the `craftShortcut` event its own JavaScript listens
 * for is never dispatched. So a quick action promising "Trails Near Me" would
 * open the app wherever it was left.
 *
 * This adds the missing half, against the delegate Craft already installs.
 * `@objc` is written out rather than inferred, so that a Swift version or a
 * Craft change that stops this being a protocol witness fails the build
 * instead of silently never being called.
 *
 * The URL is opened rather than handed to Craft's DeepLinkManager directly:
 * it is the same path the intents take, and it does not depend on the name of
 * a type inside Craft.
 */
export function delegateExtension(delegateType: string): string {
  return `// A tapped home-screen quick action. The link travels in the item's
// userInfo, which is what useNativeShortcuts puts there.
extension ${delegateType} {
    @objc
    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        guard let link = shortcutItem.userInfo?["url"] as? String,
              let url = URL(string: link) else {
            completionHandler(false)
            return
        }

        UIApplication.shared.open(url)
        completionHandler(true)
    }
}`
}

/**
 * The name of the app delegate in a generated project, or null when it has
 * none in the shape this expects.
 */
export function findDelegateType(sources: string[]): string | null {
  for (const source of sources) {
    const match = source.match(/class\s+(\w+)\s*:\s*NSObject\s*,\s*UIApplicationDelegate/)
    if (match)
      return match[1]
  }
  return null
}

/** Where the generated file goes inside a Craft iOS project. */
export function shortcutsSourcePath(projectDir: string, appName: string): string {
  return join(projectDir, 'Sources', `${swiftIdentifier(appName)}AppShortcuts.swift`)
}

/**
 * Another provider in the project would make the row ambiguous — iOS takes one
 * — so say so rather than quietly shipping two.
 */
export async function conflictingProviders(projectDir: string, ownPath: string): Promise<string[]> {
  const sources = join(projectDir, 'Sources')
  if (!existsSync(sources))
    return []

  const found: string[] = []
  for (const entry of await readdir(sources)) {
    const path = join(sources, entry)
    if (!entry.endsWith('.swift') || path === ownPath)
      continue
    if ((await Bun.file(path).text()).includes('AppShortcutsProvider'))
      found.push(path)
  }
  return found
}

/** Every Swift source in the project, minus the one this generates. */
async function projectSources(projectDir: string, ownPath: string): Promise<string[]> {
  const sources = join(projectDir, 'Sources')
  if (!existsSync(sources))
    return []

  const texts: string[] = []
  for (const entry of await readdir(sources)) {
    const path = join(sources, entry)
    if (entry.endsWith('.swift') && path !== ownPath)
      texts.push(await Bun.file(path).text())
  }
  return texts
}

export async function writeIosShortcuts(projectDir: string, options: IosShortcutsOptions): Promise<string> {
  const path = shortcutsSourcePath(projectDir, options.appName)
  const delegateType = options.delegateType ?? findDelegateType(await projectSources(projectDir, path)) ?? undefined
  await writeFile(path, iosShortcutsSwift({ ...options, delegateType }))
  return path
}

if (import.meta.main) {
  const projectDir = process.argv[2] ?? join(process.cwd(), 'storage', 'framework', 'mobile', 'ios')

  if (!existsSync(join(projectDir, 'Sources'))) {
    // Not an error: the shortcuts are generated as part of the iOS build, and
    // every other build has no project to write into.
    console.log(`No iOS project at ${projectDir}; skipping App Intents generation.`)
    process.exit(0)
  }

  const { default: mobile } = await import('../config/mobile')
  const options: IosShortcutsOptions = {
    appName: mobile.ios.appName,
    scheme: mobile.ios.urlSchemes?.[0] ?? 'wildloop',
  }

  const path = await writeIosShortcuts(projectDir, options)
  const routesQuickActions = (await Bun.file(path).text()).includes('performActionFor')
  console.log(`Wrote ${APP_SHORTCUTS.length} App Shortcuts to ${path}`)
  if (!routesQuickActions)
    console.warn('::warning::No UIApplicationDelegate found in the project, so a tapped home-screen shortcut will only open the app.')

  const conflicts = await conflictingProviders(projectDir, path)
  if (conflicts.length > 0)
    console.warn(`::warning::Another AppShortcutsProvider is in the project (${conflicts.join(', ')}); iOS will only honour one.`)

  // xcodegen expands `sources: - Sources` into file references when it runs,
  // so a file added afterwards is on disk but not in the target. Regenerating
  // is what actually puts these intents in the build.
  //
  // Skipped under the framework's own source-level escape hatch, where no
  // project was generated in the first place.
  if (process.env.STACKS_IOS_SKIP_XCODEGEN === '1') {
    console.log('STACKS_IOS_SKIP_XCODEGEN=1; leaving the project alone.')
    process.exit(0)
  }

  if (!existsSync(join(projectDir, 'project.yml'))) {
    console.error(`No project.yml at ${projectDir}; the generated intents would not be in any target.`)
    process.exit(1)
  }

  // The same invocation Craft's own builder uses, from inside the project.
  const xcodegen = Bun.spawnSync(['xcodegen', 'generate'], {
    cwd: projectDir,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (xcodegen.exitCode !== 0) {
    console.error('xcodegen could not regenerate the project, so the App Intents above are not in the build. Install it with `brew install xcodegen`.')
    process.exit(1)
  }

  console.log('Regenerated the Xcode project so the intents are in the app target.')
}
