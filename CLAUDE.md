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
    installs no shims
  - `:if` on an interactive node was a silent dead button when the condition
    *turned* true (stacksjs/stx#2067) — **fixed in stx 0.2.504**, re-measured with
    the three-button probe (flipped-later now runs). `bun run gate:stx` holds
    0.2.504 as the floor instead of banning the pattern, so this comes back as a
    failure only if the framework goes backwards
  - **no `:if` in `resources/native/**` — use `:show`.** The native runtime never
    applies `:if`: the compiler puts the binding in the manifest, nothing reads
    it, and `stxHost.setVisible` is never called, so *every* branch renders.
    Trails shipped showing its spinner, its error slot, its result count and
    "No trail matches that." in the same frame, and a challenge the viewer sent
    got a working Accept button. `:show` goes through `setVisible` and is correct
    inside a `:for` as well as outside — four display operations, all right, in
    the same probe where `:if` produced none. Filed as stacksjs/stx#2074, present
    in 0.2.504 and 0.2.520 alike, so it is not a regression and nothing is coming
    for free. The gate fails on any `:if` under `resources/native/`. Note the
    semantics differ: `:show` keeps the node mounted and hides it, so a test
    asserting a control is *not* offered has to read `style.display`, not the text
  - text from a signal is interpolated as its own call — `{{ heading() }}` (stacksjs/stx#2069). Concatenating a
    bare signal (`{{ 'for ' + query }}`) renders `[object Object]`, and `{{ 'for ' + query() }}`
    renders nothing; build the string in a `derived()` and interpolate that
  - no `<style>` block in a `.stx` file — **2,326 lines** across `resources/**`. An
    earlier count of 1,804 looked only at `resources/views/**` and missed what the
    components carry. Tokens and `@keyframes` belong in `config/crosswind.ts`,
    repeated shapes in its `shortcuts`
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
