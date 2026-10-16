# Claude Code Guidelines

## Linting

- Use **pickier** for linting — never use eslint directly
- Run `bunx --bun pickier .` to lint, `bunx --bun pickier . --fix` to auto-fix
- When fixing unused variable warnings, prefer `// eslint-disable-next-line` comments over prefixing with `_`

## Frontend

- Use **stx** for templating — never write vanilla JS (`var`, `document.*`, `window.*`) in stx templates
- Use **crosswind** as the default CSS framework which enables standard Tailwind-like utility classes
- stx `<script>` tags should only contain stx-compatible code (signals, composables, directives)
- Follow the **stx standards**: `~/Documents/stx-standards` (filed upstream as
  [stacksjs/stx#1791](https://github.com/stacksjs/stx/issues/1791); `12-enforcement.md` is the
  gate before "done", `14-triage.md` for hydration misses). The three rules this repo breaks
  today, with counts as of 8 Oct 2026, so a new file does not add to them:
  - no vanilla DOM — **4 sites** left, each deliberate and commented: the mobile `location`
    API (not `window.location`), the tab bar's pathname fallback for when the router never
    answered, an invite **code** on the clipboard (`copyLink` would make it a URL), and the
    unused `SearchFilter.stx`. Timers go through `useTimeout`/`useInterval`, navigation
    through `navigate()`, listeners through `useEventListener`, which registers its own
    teardown. Count by stripping comments first — prose about `document.` matches a naive grep
  - only what stx itself injects is really available in a client block (stacksjs/stx#2068). `useDebounceFn`,
    `useTimeoutFn` and friends are declared in `storage/framework/types/browser-auto-imports.d.ts`
    but are **not** injected: calling one threw `useDebounceFn is not defined` at hydration and
    took the whole page's setup down, with tsc and the linter silent. `useTimeout`,
    `useInterval`, `useEventListener`, `useSearchParams` are injected and verified working
  - a shared `resources/functions` module must not touch a web API. A native screen
    runs with the language intrinsics (`JSON`, `Intl`, `encodeURIComponent`) plus
    what the runtime assigns — `fetch`, bridged to the Network capability, and
    `craft`. Nothing assigns `URLSearchParams`, `URL` or `TextEncoder`, so
    `leaderboardQuery` building its string with `URLSearchParams` made the screen
    issue no request at all while passing every browser test. Verified in the
    native test context, which is a bare JS context as JavaScriptCore is; stx
    installs no shims. **`bun run gate:stx` is clean of this as of 16 Oct
    2026**: the last two offenders, `normalizeEvidenceUrl` and
    `normalizeTrackerUrl`, moved to `app/Support/evidenceUrls.ts` rather than
    being rewritten — only server actions call them, and hand-parsing a URL for
    a check whose job is to refuse `javascript:` is a worse trade than putting
    the code where the real `URL` exists
  - `:if` on an interactive node was a silent dead button when the condition
    *turned* true (stacksjs/stx#2067) — **fixed in stx 0.2.504**, re-measured with
    the three-button probe (flipped-later now runs). `bun run gate:stx` holds
    0.2.504 as the floor instead of banning the pattern, so this comes back as a
    failure only if the framework goes backwards
  - **no `:if` in `resources/native/**` — use `:show`.** Not because `:if` is
    ignored. It emits structural operations and always has: `removeNode` when
    the condition is false, `createNode` + `insertChild` when it turns true,
    standalone and inside a `:for`. What is actually true is narrower — **the
    initial RENDER carries every branch regardless of the condition**, and the
    corrections arrive in the first post-mount MUTATE batch. So the first frame
    shows all of them: Trails showed its spinner, its error slot, its result
    count and "No trail matches that." together, and a challenge the viewer sent
    got an Accept button. stx 0.2.532 adds a `display` patch beside each
    structural op, but the branches are still all in that initial RENDER, so the
    window does not close — measured on 0.2.520 and 0.2.532 alike. `:show` lands
    in the same batch, so it is no faster; it is just far easier to assert on,
    and it keeps the node mounted, so a test asserting a control is *not*
    offered reads `style.display`, not the text. The gate fails on any `:if`
    under `resources/native/` for that reason, not the original one.
    **I filed stacksjs/stx#2074 saying `setVisible` is never called; that was
    wrong** — I read the RENDER payload and stopped there. Which is the rule
    underneath this one: **the initial RENDER is not the frame.** A binding
    missing from it may still arrive a batch later, so a probe that reads only
    the render document will report a drop that is really a delay.
    `tests/unit/native-conditional-timing.test.ts` pins both halves
  - a bound `:geometry` on `MapPolyline` **does** reach the host — as
    `{"op":"updateNode","patch":{"props":{"geometry":[…]}}}`, on 0.2.520 as well
    as 0.2.532. I filed stacksjs/stx#2073 claiming the compiler dropped it, and
    it does not: the initial RENDER carries only
    `data-stx-parent-bindings="geometry"` and the flat array follows in the first
    post-mount batch, which is what I mistook for a drop. Nothing was blocking
    the map screens
  - text from a signal is interpolated as its own call — `{{ heading() }}` (stacksjs/stx#2069). Concatenating a
    bare signal (`{{ 'for ' + query }}`) renders `[object Object]`, and `{{ 'for ' + query() }}`
    renders nothing; build the string in a `derived()` and interpolate that
  - no `<style>` block in a `.stx` file — **2,090 lines** across `resources/**`,
    down from 2,326 on 15 Oct 2026 when the route and contour classes moved out.
    An earlier count of 1,804 looked only at `resources/views/**` and missed what
    the components carry. Tokens and `@keyframes` belong in `config/crosswind.ts`,
    repeated shapes in its `shortcuts` — and anything that has no utility to
    shortcut to goes in its **`preflights`**, which is the destination that was
    missing. `stroke`, `stroke-width` and `fill` on an SVG child have no utility,
    so `.wl-route-*` could never have been a shortcut.
    **Not `components/styles.stx`**: that file is inlined into every page, so
    moving 1.8KB there to save it on seven views put 3.1KB of HTML on every
    *other* page — measured, after doing exactly that by mistake.
    A preflight is better but not free, and the first write-up of this
    overstated it by measuring HTML only. **The generated stylesheet is
    per-page** — `/records`, `/clubs` and `/feed` each link a different
    `/_stx/css.<hash>.css` — and a preflight is injected into every one of
    them. So the seven route views lost 1.8KB of inline HTML and gained 1.7KB
    of linked CSS, while fifteen pages that never draw a route gained 1.7KB
    they do not use: 1.8% of a 96KB sheet. The trade bought one definition
    instead of seven, which is worth it for a shape the whole app shares —
    and is exactly the wrong trade for CSS only one page uses.
    What is left is concentrated — `index.stx` 934, `styles.stx` 366,
    `record.stx` 296, `app.stx` 127 — and **the rule does not fit it**, which
    is worth knowing before spending another session on it. Measured on
    `index.stx`: all 88 of its classes are used, none appears in any other
    file, and it carries its own light/dark palette (`--page-paper`,
    `--page-muted`, `--page-ink`) that overlaps nothing in the design system.
    A preflight is the wrong home for it — the generated sheet is per-page, so
    934 lines there is ~20KB added to all 22 pages to serve one. Utilities are
    the rule's real intent, but only about 55% of the rules could become one
    (27 descendant selectors, 9 states, 5 media queries, 4 pseudo-elements and
    2 keyframes cannot), and the convertible half is mostly `background:
    var(--page-paper)` — which in markup becomes `bg-[#f3f5f1]` and loses the
    token. Cross-file duplication is down to 4 selectors (`.live-pip`,
    `.qr-frame`, `.qr-frame svg`, a search-cancel reset), so there is no
    sharing left to find either. **A page-local `<style>` block for a page
    nothing else shares is the right shape; the number to watch is how much of
    it is duplicated, not how big it is.**
  - comment with `{{-- --}}`, never `<!-- -->` — **clear**. All 352 were converted
    on 15 Oct 2026, and `bun run gate:stx` now fails on the next one rather than
    tracking a backlog. They shipped to the browser as content: ten pages carried
    21-35 each, and losing them took 6-9KB off every one. The hazard was never
    the weight though — one mentioning `<html>`, `<!DOCTYPE` or `</script` makes
    `hasDocumentShell` skip the shell, which turns every in-app navigation into a
    full reload, and nothing stopped somebody writing that comment tomorrow.
    Verified by diffing the served HTML before and after: 4,242 lines each way,
    two differing, both the dev server's own reload counter
  - at most two script blocks per file — **clear**. One server block plus one client
    block is the shape, and prose quoting `<script server>` inflates a naive count

**A native screen's requests go through `createNativeApi`**
(`resources/functions/native-api.ts`). Twelve screens each held the same
memoized keychain read and the same token-bearing `fetch`, three byte-identical,
and the four detail screens added the same 404-versus-failure split on top —
copying it a thirteenth time is how one copy quietly stops matching the others.
The helper is **native-only**, unlike the rest of `resources/functions`: a
browser page goes through `apiFetch`, which carries a cookie and a CSRF token a
native screen does not have. It lives there anyway so the gate keeps checking it
for web APIs. Four screens are deliberately *not* on it: Records, Search and
Trails send no token at all (the helper would add a keychain round trip they do
not want), and ManualActivity needs the raw `Response` for `messageFrom`, which
`api.send` parses and discards.

**The native test fixture hands the bundle no timer** (`tests/fixtures/nativeScreen.ts`).
The runtime does not promise one — the bridge arms its request timeout as
`typeof globalThis.setTimeout === 'function' ? … : null` — so a screen leaning on
a timer would pass in a test and fail on a phone. It was also the intermittent
native failure: with `setTimeout` in scope every request armed a 30-second bridge
timeout, eight files left fifteen uncleared between them (a test asserting a
request was *made* has no reason to answer it), and in a suite longer than thirty
seconds those fired mid-run as `Request js_… timed out after 30000ms` against
whichever file was executing. Measured 16 Oct 2026: 192 native tests pass with no
timer in scope, three consecutive full runs at 2,850 passing and zero timeouts.
A test in `native-conditional-timing.test.ts` fails if a timer is put back.

**Do not count any of this by hand.** `bun run gate:stx` is the counter, and it found
two of the numbers above wrong within a minute of existing. It runs stx's own DOM
validator (which `config/stx.ts` now enables with `strict`), the native-screen rules,
the comment and `</script` landmines, the script-block limit, and it ratchets the two
backlog counts so a new file cannot add to them. Blocking rules are the ones already
cleared; the backlog fails only on an increase.

## Dependencies

- **buddy-bot** handles dependency updates — not renovatebot
- **better-dx** provides shared dev tooling as peer dependencies — do not install its peers (e.g., `typescript`, `pickier`, `bun-plugin-dtsx`) separately if `better-dx` is already in `package.json`
- If `better-dx` is in `package.json`, ensure `bunfig.toml` includes `linker = "hoisted"`

## Commits

- Use conventional commit messages (e.g., `fix:`, `feat:`, `chore:`)
