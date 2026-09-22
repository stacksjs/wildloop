import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

/**
 * Every action a route names has to exist.
 *
 * The router imports the action file when the request arrives, so a name with
 * no file behind it is not a startup error: it is a 500 on that endpoint, in
 * production, whenever somebody (or a crawler) hits it. bughq caught exactly
 * that for `POST /api/drivers` on 22 Sep 2026.
 */
const projectRoot = new URL('../../', import.meta.url).pathname

function actionExists(action: string): boolean {
  return existsSync(join(projectRoot, 'app', `${action}.ts`))
    || existsSync(join(projectRoot, 'node_modules/@stacksjs/defaults/app', `${action}.ts`))
}

describe('route actions', () => {
  it('names an action file that exists, for every API route', async () => {
    const routes = await readFile(join(projectRoot, 'routes/api.ts'), 'utf8')
    const named = [...routes.matchAll(/'(Actions\/[A-Za-z0-9/]+)'/g)].map(match => match[1])

    expect(named.length).toBeGreaterThan(100)
    expect([...new Set(named)].filter(action => !actionExists(action))).toEqual([])
  })
})
