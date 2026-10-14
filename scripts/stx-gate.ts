#!/usr/bin/env bun
/**
 * The gate before "done" for anything touching a `.stx` file.
 *
 * The stx standards (stacksjs/stx#1791, chapter 12) make the point this script
 * exists for: *"'Done' is not a judgement you are permitted to make. It is the
 * output of a fixed set of commands."* Every rule here was learned by breaking
 * it, and each one names what it costs.
 *
 * Two tiers, because a gate that is red on arrival is not a gate:
 *
 * - **Blocking** rules are the ones this repo has cleared. A new violation is a
 *   regression and fails the run.
 * - **Tracked** rules are the known backlog. They carry the count as of the day
 *   they were measured and fail only if the count goes *up*, so the backlog can
 *   be paid down without a new file quietly adding to it.
 *
 * Run: `bun run gate:stx`
 */

import { Glob } from 'bun'

const VIEWS = 'resources/**/*.stx'

/** The backlog, with the day it was counted. Lower these as they are paid down. */
const TRACKED = {
  // Counted over `resources/**`, which is wider than the `resources/views/**` a
  // first pass measured: components carry CSS and comments too, and the
  // narrower count under-reported both by a few hundred.
  styleLines: { limit: 2089, what: 'lines of CSS inside <style> blocks' },
  // Paid down to zero on 15 Oct 2026: all 352 became `{{-- --}}`, which is
  // stripped at compile. The limit stays as a ratchet, so the next one fails.
  htmlComments: { limit: 0, what: '<!-- --> comments, which ship to the browser as content' },
}

let failures = 0
let warnings = 0

function fail(rule: string, detail: string): void {
  failures++
  console.error(`✗ ${rule}\n  ${detail}`)
}

function warn(rule: string, detail: string): void {
  warnings++
  console.warn(`· ${rule}\n  ${detail}`)
}

async function files(): Promise<string[]> {
  const found: string[] = []
  for await (const file of new Glob(VIEWS).scan())
    found.push(file)
  return found.sort()
}

/** Script bodies with comments blanked, so prose about `document.` is not a finding. */
function clientScripts(source: string): string[] {
  const bodies: string[] = []
  for (const match of source.matchAll(/<script(?![^>]*\bserver\b)[^>]*>([\s\S]*?)<\/script>/g)) {
    bodies.push(match[1]
      .replace(/\/\*[\s\S]*?\*\//g, blank => '\n'.repeat(blank.split('\n').length - 1))
      .replace(/\/\/.*$/gm, ''))
  }
  return bodies
}

const sources = new Map<string, string>()
for (const file of await files())
  sources.set(file, await Bun.file(file).text())

// ── 1. stx's own DOM-API guard ───────────────────────────────────────────────
// Prohibited browser APIs, each with the stx replacement. It ships as code and
// is discarded unless `config/stx.ts` sets `strict`, which is how a
// `location.assign` survived a hand audit that found four other sites.
{
  const config = (await import('../config/stx')).default as { strict?: unknown }
  if (config.strict == null)
    fail('config/stx.ts has no `strict` key', 'stx\'s DOM validator is loaded and every finding discarded.')

  const { validateClientScript } = await import('@stacksjs/stx/script-validation') as any
  let reported = 0
  const write = console.warn
  console.warn = (...args: unknown[]) => { reported++; write(...args) }
  for (const [file, source] of sources) {
    for (const body of clientScripts(source))
      validateClientScript(body, file, { enabled: true, failOnViolation: false })
  }
  console.warn = write
  if (reported > 0)
    fail('stx DOM guard', `${reported} prohibited browser API call(s) above. Exempt one line with \`// stx-strict-ignore-next-line <rule> -- why\`.`)
}

// ── 2. The stx floor for a revealed `:if` handler (stacksjs/stx#2067) ───────
// A Button revealed by a condition that turns true kept the handler from the
// first RENDER, so the tap did nothing and said nothing. Fixed in 0.2.504,
// which hydrates the revealed handler in the same batch. Below that, `:if` on
// anything tappable is a silent dead button, so the floor is the rule.
{
  const FIXED_IN = [0, 2, 504]
  const installed = (await import('@stacksjs/stx/package.json', { with: { type: 'json' } })).default.version as string
  const parts = installed.split('.').map(Number)
  const older = FIXED_IN.some((floor, index) => (parts[index] ?? 0) !== floor
    ? (parts[index] ?? 0) < floor
    : false)

  if (older) {
    const offenders = [...sources].filter(([, source]) => /<(?:Button|Pressable|TouchableOpacity|TouchableHighlight)[^>]*:if=/.test(source))
    if (offenders.length > 0)
      fail(`stx ${installed} predates the \`:if\` handler fix`, `${offenders.length} file(s) put \`:if\` on an interactive node. Fixed in 0.2.504 (stacksjs/stx#2067).`)
  }
}

// ── 2b. `:if` does nothing on a native screen (stacksjs/stx#2074) ────────────
// The compiler puts the binding in the manifest and the native runtime has no
// handler for it, so every branch renders: Trails showed its spinner, its
// error slot, its result count and "No trail matches that." in the same frame,
// and a challenge the viewer sent got a working Accept button. `:show` goes
// through `setVisible` and is correct inside a `:for` as well as outside, so
// it is the spelling until that issue closes.
for (const [file, source] of sources) {
  if (!file.startsWith('resources/native/'))
    continue
  const uses = source.match(/:if=/g)?.length ?? 0
  if (uses > 0)
    fail(`${file}: \`:if\` on a native screen`, `${uses} use(s). The native runtime never applies it — use \`:show\` (stacksjs/stx#2074).`)
}

// ── 3. The portable list boundary (093ef1ac) ─────────────────────────────────
// FlatList's item-template expansion is host-specific; a keyed `:for` renders
// the shared mutation protocol and keeps row identity and event scope.
for (const [file, source] of sources) {
  if (file.startsWith('resources/native/') && source.includes('<FlatList'))
    fail(`${file}: FlatList`, 'Use a keyed `:for` on the element inside a View/ScrollView.')
}

// ── 4. Web APIs in a module a native screen shares ──────────────────────────
// A native screen gets the language intrinsics plus what the runtime assigns
// (`fetch`, `craft`). `URLSearchParams` passed every browser test and made the
// leaderboard issue no request at all.
//
// Only the bindings a screen actually imports are a failure. A module can hold
// a `new URL()` in an export nobody native calls — `route-records.ts` does, in
// its evidence-URL validators — and that is a note, because it throws the day
// somebody imports it rather than today.
{
  const WEB_ONLY = /\b(?:URLSearchParams|TextEncoder|TextDecoder|localStorage|sessionStorage)\b|\bnew URL\(/
  const imported = new Map<string, Set<string>>()

  for (const [file, source] of sources) {
    if (!file.startsWith('resources/native/'))
      continue
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from '\.\.\/functions\/([\w-]+)'/g)) {
      const module = `resources/functions/${match[2]}.ts`
      const names = match[1].split(',').map(name => name.replace(/\s+as\s+\w+/, '').trim()).filter(Boolean)
      const set = imported.get(module) ?? new Set<string>()
      names.forEach(name => set.add(name))
      imported.set(module, set)
    }
  }

  for (const [module, names] of imported) {
    const text = (await Bun.file(module).text().catch(() => ''))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    if (!WEB_ONLY.test(text))
      continue

    // Which exports hold it: from each `export ... name` to the next one.
    const bodies = [...text.matchAll(/export (?:async )?(?:function|const) (\w+)([\s\S]*?)(?=\nexport |$)/g)]
    const offending = bodies.filter(body => WEB_ONLY.test(body[2])).map(body => body[1])
    const reached = offending.filter(name => names.has(name))

    if (reached.length > 0)
      fail(`${module}: a native screen imports ${reached.join(', ')}, which use a web API`, 'JavaScriptCore has none. Rewrite with the language intrinsics.')
    else
      warn(`${module}: ${offending.join(', ')} use a web API`, `No native screen imports them yet — it imports ${[...names].join(', ')}. It throws the day one does.`)
  }
}

// ── 5. Landmines: `</script` in a body, banned tokens in an HTML comment ─────
// An HTML comment ships to the browser as content. One mentioning `<html>` or
// `<!DOCTYPE` makes `hasDocumentShell` skip the shell, and every in-app
// navigation becomes a full reload.
for (const [file, source] of sources) {
  for (const match of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script\s*>/g)) {
    if (/<\/script/i.test(match[1]))
      fail(`${file}: \`</script\` inside a script body`, 'It terminates the block early. Write "the client script block".')
  }
  for (const match of source.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (/<\/?html\b|<!DOCTYPE\b|<\/?script\b/i.test(match[1]))
      fail(`${file}: banned token in an HTML comment`, 'Use `{{-- --}}`, which is compiled away.')
  }
}

// ── 6. At most two script blocks ─────────────────────────────────────────────
for (const [file, source] of sources) {
  const stripped = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  const blocks = stripped.match(/<script(?:\s+[^>]*)?>/g) ?? []
  if (blocks.length > 2)
    fail(`${file}: ${blocks.length} script blocks`, 'One server block plus one client block is the shape.')
}

// ── 7. Tracked backlog: ratchet only ────────────────────────────────────────
{
  let styleLines = 0
  let htmlComments = 0
  for (const source of sources.values()) {
    for (const block of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
      styleLines += block[1].trim().split('\n').length
    htmlComments += (source.match(/<!--/g) ?? []).length
  }

  for (const [count, tracked] of [[styleLines, TRACKED.styleLines], [htmlComments, TRACKED.htmlComments]] as const) {
    if (count > tracked.limit)
      fail(`backlog grew: ${count} ${tracked.what}`, `The recorded count is ${tracked.limit}. A new file must not add to it.`)
    else if (count < tracked.limit)
      warn(`backlog shrank: ${count} ${tracked.what}`, `Lower the limit in scripts/stx-gate.ts from ${tracked.limit} to ${count}.`)
  }
}

console.log(`\n${sources.size} .stx files checked — ${failures} failure(s), ${warnings} note(s)`)
process.exit(failures > 0 ? 1 : 0)
