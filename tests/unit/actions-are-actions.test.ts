import { describe, expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * `app/Actions/` holds actions, and nothing else.
 *
 * That tree is the routing surface: `ls app/Actions/Event` should answer what
 * a client can do with an event in one screen, and both the framework and
 * `tests/unit/route-actions.test.ts` walk it expecting actions.
 *
 * It drifted. Seven files there were helpers named after the folder they sat
 * in — `event-support.ts`, `plan-support.ts`, `garmin.ts` — from nine lines up
 * to 336. Shared logic belongs in `app/Support/`, named for the job rather
 * than the neighbours, because a file named for its neighbours becomes the
 * junk drawer everything later gets dropped into. See AGENTS.md.
 */

async function actionFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      found.push(...await actionFiles(path))
    else if (entry.name.endsWith('.ts'))
      found.push(path)
  }
  return found
}

describe('app/Actions', () => {
  it('contains only actions', async () => {
    const files = await actionFiles('app/Actions')
    expect(files.length).toBeGreaterThan(50)

    const notActions: string[] = []
    for (const file of files) {
      const source = await Bun.file(file).text()
      // An action is a default-exported `new Action({...})`. Anything else in
      // this tree is shared logic that belongs in app/Support/.
      if (!/export default new Action\(/.test(source))
        notActions.push(file)
    }

    expect(notActions, `Not actions — move these to app/Support/ and import them:\n  ${notActions.join('\n  ')}`).toEqual([])
  })

  it('names every file after the action it exports', async () => {
    const files = await actionFiles('app/Actions')
    const misnamed = files.filter(file => !file.endsWith('Action.ts'))
    expect(misnamed, `Expected each to end in Action.ts:\n  ${misnamed.join('\n  ')}`).toEqual([])
  })
})
