import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'

/**
 * One Bun, everywhere.
 *
 * `deps.yaml` is what pantry installs into `./pantry/.bin`, and `./buddy` runs
 * the dev server and the QA stack on it. CI, deploys and the production box ran
 * 1.4.2 while pantry still pinned 1.3.14, and the gap only showed as failures
 * nobody could reproduce in CI: Bun 1.3.14's `node:http` client puts the request
 * path on `response.url`, so Playwright's cookie handling threw `"/athlete/1"
 * cannot be parsed as a URL` against any server that set a cookie, and only on
 * a machine whose Bun came from pantry.
 */

const root = resolve(import.meta.dir, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const pinned = /^\s*bun\.sh:\s*(\S+)\s*$/m.exec(read('deps.yaml'))?.[1]

describe('the pinned Bun', () => {
  it('is one exact version in deps.yaml', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('is the version config/deps.ts declares', () => {
    expect(/'bun\.com':\s*'([^']+)'/.exec(read('config/deps.ts'))?.[1]).toBe(pinned)
  })

  it('is the version every workflow sets up', () => {
    const workflows = readdirSync(resolve(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name))
    const setups: string[] = []

    for (const name of workflows) {
      const lines = read(`.github/workflows/${name}`).split('\n')
      lines.forEach((line, index) => {
        if (!/^\s*(?:- )?uses: oven-sh\/setup-bun@/.test(line))
          return
        // The rest of the step: every line until one at or left of its `- `.
        const dash = line.search(/\S/) - (line.trimStart().startsWith('- ') ? 0 : 2)
        let version = 'unset'
        for (const next of lines.slice(index + 1)) {
          if (next.trim() && !next.trimStart().startsWith('#') && next.search(/\S/) <= dash)
            break
          const match = /^\s*bun-version:\s*['"]?([^'"\s]+)/.exec(next)
          if (match)
            version = match[1]
        }
        setups.push(`${name}:${index + 1} ${version}`)
      })
    }

    expect(setups.length).toBeGreaterThan(0)
    expect(setups.filter(setup => !setup.endsWith(` ${pinned}`))).toEqual([])
  })
})
