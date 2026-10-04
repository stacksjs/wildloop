/**
 * Where the isolated QA stack listens.
 *
 * Every port derives from `QA_PORT_BASE` (4320 when unset, which is what CI and
 * every existing habit use). Two worktrees running QA at once — two agents, or
 * a person and an agent — otherwise fight over the same ports: the second
 * stack fails to bind, or worse, the second run's tests find the first run's
 * servers "already up" and test somebody else's code.
 *
 *   QA_PORT_BASE=5320 bun test tests/browser    # a second stack beside the first
 */
const base = Number(process.env.QA_PORT_BASE) || 4320

export const QA_PORTS = {
  /** The bare recorder page (scripts/test-recording-browser.ts). */
  recorder: base - 1,
  app: base,
  api: base + 1,
  /** The local recorder proxy (scripts/test-recording-app.ts). */
  proxy: base + 2,
  /** `buddy dev` starts a docs server too; left on 3006 it collides across stacks. */
  docs: base + 5,
  dashboard: base + 12,
} as const
