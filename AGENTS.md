# AGENTS.md

Guidance for AI coding agents (Claude Code, OpenAI Codex CLI, Cursor, and others)
working in this Stacks application. Every agent reads this file, so it is the one
place to record project-specific rules.

This is the starter version `buddy setup:ai` writes when a project has no
`AGENTS.md` yet. Edit it freely - it is yours, and it is committed so the whole
team (and every agent) sees the same rules.

---

## Project conventions

### Linting

- Use **pickier**, never eslint directly.
- Lint: `bunx --bun pickier .` Auto-fix: `bunx --bun pickier . --fix`
- For unused variables, prefer `// eslint-disable-next-line` over an underscore
  prefix.

### Frontend

- Use **stx** for templating. Never vanilla JS (`var`, `document.*`, `window.*`)
  inside stx templates - use signals (`state` / `derived` / `effect`) and
  composables.
- Use **Crosswind** utility classes for styling.
- Icons are Iconify classes (`i-{collection}-{name}`). Never hand-roll SVG paths
  and never add an icon npm package.
- Stacks ships no animation library. Use Crosswind transitions, CSS keyframes,
  scroll-driven animations, and the motion composables.

### Commits

- Conventional commit messages (`fix:`, `feat:`, `chore:`, ...).
- Only commit or push when asked.

### Requirements

Bun >= 1.3.0, SQLite >= 3.47.2, TypeScript throughout.

---

## Repository map

| Path | What lives here |
|---|---|
| `app/` | Your code: `Actions/`, `Jobs/`, `Listeners/`, `Middleware/`, `Mail/`, `Commands/`, `Models/`, `Skills/`, plus `Routes.ts`, `Events.ts`, `Gates.ts`, `Scheduler.ts` |
| `routes/` | Route files, registered via `app/Routes.ts` |
| `config/` | Typed configuration, one file per subsystem |
| `database/` | Migrations, seeders, local SQLite files |
| `resources/` | stx frontend: `views/`, `components/`, `layouts/`, `partials/` |
| `storage/framework/` | Framework internals and defaults. Read-only reference |
| `tests/` | Bun test suites |

### `app/Actions/` holds actions, and nothing else

Every file under `app/Actions/` exports a single `new Action({...})` as its
default. That tree is the routing surface: `ls app/Actions/Event` should answer
"what can a client do with events" in one screen, and both the framework and
our own tests walk it expecting actions.

Shared logic for a group of actions — helpers, formatters, query builders,
payload shapers, constants — goes in `app/Support/`. Never beside the actions
that use it, and never named after the folder it serves: `eventDistance.ts`,
not `event-support.ts`. "Support" says where a file lives rather than what it
is, and a file named for its neighbours becomes the junk drawer everything
later gets dropped into.

Naming in `app/Support/` is camelCase after the job: `reviewCache.ts`,
`trailAreaPhotos.ts`, `sessionTokens.ts`.

Pure logic the frontend needs too goes in `resources/functions/` instead, where
it is auto-imported into both bundles — `trail-conditions.ts` and
`trail-geometry.ts` are there for that reason.

`tests/unit/actions-are-actions.test.ts` enforces this.

### The `app/` override model

Stacks resolves files from `app/` first and falls back to
`storage/framework/defaults/app/`. To customize a framework default, create the
same path under `app/` and it wins.

---

## Skills

The framework ships a skill per subsystem under
`storage/framework/defaults/ai/skills`, each documenting that area
authoritatively. Read the relevant `SKILL.md` before doing non-trivial work
rather than guessing at an API.

For native iOS and shared mobile/web STX work, read the `stacks-mobile` skill.

Add your own with `app/Skills/<name>/SKILL.md`, then re-run `buddy setup:ai`.

---

## Before finishing

- Lint: `bunx --bun pickier .` (fix with `--fix`)
- Type check: `bun run typecheck:app`
- Test: `buddy test`
