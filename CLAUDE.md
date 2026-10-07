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
  - no vanilla DOM — **24 sites** left: `setTimeout`/`setInterval` → `useTimeout`/`useInterval`,
    `location.*` → `navigate()`, `addEventListener` → `@event` or `useEventListener`. Count the
    real ones by stripping comments first; prose about `document.` matches a naive grep
  - no `<style>` block in a `.stx` file — **1,804 lines across 15 views**. Tokens and
    `@keyframes` belong in `config/crosswind.ts`, repeated shapes in its `shortcuts`
  - at most two script blocks per file — clear as of this count, and the reason to keep
    counting: one server block plus one client block is the shape

## Dependencies

- **buddy-bot** handles dependency updates — not renovatebot
- **better-dx** provides shared dev tooling as peer dependencies — do not install its peers (e.g., `typescript`, `pickier`, `bun-plugin-dtsx`) separately if `better-dx` is already in `package.json`
- If `better-dx` is in `package.json`, ensure `bunfig.toml` includes `linker = "hoisted"`

## Commits

- Use conventional commit messages (e.g., `fix:`, `feat:`, `chore:`)
