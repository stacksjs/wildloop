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
            // Awaited: inside an async context this resolves to
            // \`open(_:options:)\`, which is itself async on current SDKs.
            await UIApplication.shared.open(url)
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
`
}

/*
 * There is deliberately no `performActionFor` handler here.
 *
 * Craft's own app delegate implements it — v0.0.90's template did not, which
 * is what this file first assumed, and the simulator build said otherwise:
 * "invalid redeclaration of 'application(_:performActionFor:completionHandler:)'"
 * against WildLoopApp.swift. Tapped home-screen shortcuts are Craft's to
 * deliver; what it has no answer for, and what this file exists for, is the
 * Spotlight and Siri row.
 */

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

export async function writeIosShortcuts(projectDir: string, options: IosShortcutsOptions): Promise<string> {
  const path = shortcutsSourcePath(projectDir, options.appName)
  await writeFile(path, iosShortcutsSwift(options))
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
  console.log(`Wrote ${APP_SHORTCUTS.length} App Shortcuts to ${path}`)

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
