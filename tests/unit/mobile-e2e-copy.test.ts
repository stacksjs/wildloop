import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

/**
 * Every line a mobile journey waits for must be a line the app still says.
 *
 * Maestro cannot tell "the screen never arrived" from "the screen arrived and
 * this sentence is not on it": both are `Assertion is false: "..." is visible`
 * after the timeout. So a flow that asserts copy the views no longer render is
 * red on its first step forever, and the journey behind it stops being tested
 * while still looking tested.
 *
 * That has now happened twice. In August the flows still asked for "Find your
 * line" and "Capture Run" after the pages were rebuilt, and Mobile E2E was red
 * for a week on the first assertion of every flow (c1f2d592). The strings were
 * corrected; nothing stopped it recurring. In September the record screen's
 * subtitle, "Close a loop and the ground inside it is yours.", became the run's
 * own settings when setup moved into a modal (62d6dd93) — four flows asserted
 * it, and all four went red again.
 *
 * This is the guard. It is a text search, not a render: it cannot prove the
 * copy is on screen at that moment, only that a view a phone can draw still
 * contains it. That is the shape of what rots — a line deleted or reworded in
 * one place while four flows still ask for it.
 */

/**
 * Strings the app never renders, and no view should be searched for.
 *
 * Each is drawn by the operating system, outside the WebView: permission
 * sheets, and the confirmation iOS may put in front of a deep link.
 */
const SYSTEM_UI: readonly string[] = [
  '^Open$',
  'Don’t Allow',
  'Allow While Using App',
  'Allow Once',
  'would like to use your current location',
]

/** Keys whose value is a literal the device is expected to be showing. */
const COPY_KEYS = /^\s*(?:-\s*)?(?:visible|assertVisible|assertNotVisible|tapOn|text):\s*(.+?)\s*$/

function flowFiles(): string[] {
  const dir = '.maestro/flows'
  return readdirSync(dir).filter(name => name.endsWith('.yaml')).map(name => join(dir, name))
}

/**
 * Chrome a phone never draws, and so never evidence that copy is reachable.
 *
 * The layout mounts both inside `hidden lg:block`. Searching them made this
 * guard miss the very failure it was written for: the record screen lost
 * "Close a loop and the ground inside it is yours.", but the desktop nav
 * carries "Close a loop to claim the ground inside it", and the flows asked
 * for `Close a loop.*` — which the nav answered, on a screen no phone shows.
 */
const DESKTOP_ONLY: readonly string[] = ['nav.stx', 'footer.stx']

/** Every view and component a phone can draw, as one searchable body of text. */
function appCopy(): string {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory())
        walk(path)
      else if (/\.(?:stx|ts)$/.test(entry.name) && !DESKTOP_ONLY.includes(entry.name))
        found.push(readFileSync(path, 'utf8'))
    }
  }
  walk('resources')
  return found.join('\n')
}

/**
 * The assertions in a flow, with the ones that are not copy left out.
 *
 * A bare `${APP_ID}` or an empty match is configuration; quotes are the YAML's
 * and not part of what Maestro matches.
 */
function copyAssertions(source: string): string[] {
  const found: string[] = []
  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('#'))
      continue
    const match = COPY_KEYS.exec(line)
    if (!match)
      continue
    const value = match[1].replace(/^["']|["']$/g, '')
    if (!value || value.includes('${') || SYSTEM_UI.includes(value))
      continue
    found.push(value)
  }
  return found
}

/**
 * A flow's assertion is already a regular expression, so it is reused as one —
 * anchors dropped, because they bound a single element's text and this searches
 * the whole corpus, and case ignored, because a view can write "Tap to start
 * GPS capture" and have the style draw it in capitals.
 */
function asSearch(assertion: string): RegExp {
  return new RegExp(assertion.replace(/^\^/, '').replace(/\$$/, ''), 'i')
}

describe('mobile E2E flows', () => {
  const copy = appCopy()

  it('has flows to check', () => {
    expect(flowFiles().length).toBeGreaterThan(3)
  })

  for (const file of flowFiles()) {
    it(`only waits for copy the app still has: ${file}`, () => {
      const missing = copyAssertions(readFileSync(file, 'utf8'))
        .filter(assertion => !asSearch(assertion).test(copy))

      expect(missing, `No view renders these, so the journey can only time out:\n  ${missing.join('\n  ')}`).toEqual([])
    })
  }
})
