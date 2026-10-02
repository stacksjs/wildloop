import { describe, expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * What `routes/` promises, and what the app actually serves.
 *
 * Two defects fixed together here, both of which looked like routing to
 * anyone reading the folder.
 *
 * `routes/buddy.ts` and `routes/users.ts` had never been served under any
 * version of the registry: the manifest names which files to load, and since
 * the framework default is `{ api: 'api' }`, nothing loaded them. Four routes
 * that read as live and answered 404 (#1013).
 *
 * And the opposite — fifteen routes that read as framework scaffolding and
 * were entirely live. The `/voide` group carried no middleware, so
 * `/api/voide/state` answered 200 on production unauthenticated, beside POST
 * routes that reach `sh -c`, `pkill` and `claude --dangerously-skip-permissions`.
 */

const ROUTES_DIR = 'routes'
/** The framework default when no `app/Routes.ts` names anything else. */
const DEFAULT_REGISTRY = ['api']

async function routeFiles(): Promise<string[]> {
  return (await readdir(ROUTES_DIR))
    .filter(name => name.endsWith('.ts'))
    .map(name => name.replace(/\.ts$/, ''))
}

describe('every file in routes/ is actually served', () => {
  /*
   * A file here that nothing loads is worse than no file: it documents
   * endpoints that answer 404, and the only way to find out is to call them.
   */
  it('contains no route file the registry does not name', async () => {
    const registry = new Set(DEFAULT_REGISTRY)
    const orphans = (await routeFiles()).filter(name => !registry.has(name))

    expect(orphans, `routes/${orphans.join('.ts, routes/')}.ts is never loaded — add it to a registry or delete it`)
      .toEqual([])
  })

  /*
   * If this fails, somebody added `app/Routes.ts` back. That is allowed — it
   * is how a second route file gets loaded — but the list above has to learn
   * about it, or this test starts passing for the wrong reason.
   */
  it('still relies on the default registry, which names only api', async () => {
    expect(await Bun.file('app/Routes.ts').exists()).toBe(false)
  })
})

describe('what api.ts exposes', () => {
  async function api(): Promise<string> {
    return await Bun.file(join(ROUTES_DIR, 'api.ts')).text()
  }

  /*
   * The `/voide` group was a Voice AI code assistant for a different product,
   * registered with no auth. Nothing in Wildloop called it. Its actions open
   * native folder pickers, kill processes, run a CLI with permissions skipped,
   * and commit and push git repositories.
   */
  it('serves no Voide routes', async () => {
    const source = await api()
    expect(source).not.toContain("prefix: '/voide'")
    expect(source).not.toMatch(/\bVoide\b/)
  })

  /*
   * And none of the actions behind them, under any prefix. Re-registering
   * `BuddyBrowseAction` somewhere else would be the same hole at a different
   * address — the group was never the dangerous part.
   */
  it('routes to no Buddy action', async () => {
    expect(await api()).not.toContain('Actions/Buddy/')
  })
})
