import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { durableCachePath } from '../../app/Support/durableCache'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the durable cache', () => {
  it('lives beside the app database: shared in production, local otherwise', () => {
    expect(durableCachePath('/var/www/wildloop-shared/database/stacks.sqlite')).toBe('/var/www/wildloop-shared/database/cache.sqlite')
    expect(durableCachePath('database/trailbuddy.sqlite')).toBe('database/cache.sqlite')
    expect(durableCachePath(undefined)).toBe('database/cache.sqlite')
  })

  it('keeps an entry for the next process, as a deploy needs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wildloop-durable-cache-'))
    dirs.push(dir)
    const run = (script: string) => Bun.spawnSync({
      cmd: [process.execPath, '-e', `const { durableCache } = await import(${JSON.stringify(join(import.meta.dir, '../../app/Support/durableCache.ts'))}); ${script}`],
      env: { ...process.env, DB_DATABASE_PATH: join(dir, 'stacks.sqlite') },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const write = run(`await durableCache().set('trail-profile:v1:7:abc', [{ mi: 0, ft: 4000 }], 3600)`)
    expect(write.exitCode, write.stderr.toString()).toBe(0)
    const read = run(`console.log(JSON.stringify(await durableCache().get('trail-profile:v1:7:abc')))`)
    expect(read.exitCode, read.stderr.toString()).toBe(0)
    expect(JSON.parse(read.stdout.toString().trim().split('\n').at(-1)!)).toEqual([{ mi: 0, ft: 4000 }])
  }, 30000)
})
