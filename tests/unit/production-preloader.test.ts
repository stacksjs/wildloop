import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'

const root = resolve(import.meta.dir, '../..')
const cloud = readFileSync(resolve(root, 'config/cloud.ts'), 'utf8')

function testPrivateKey(): string | undefined {
  const keysFile = resolve(root, '.env.keys')
  if (!existsSync(keysFile)) return undefined
  return readFileSync(keysFile, 'utf8').match(/^DOTENV_PRIVATE_KEY=(.+)$/m)?.[1]?.trim()
}

describe('production preloader', () => {
  it('uses the canonical Stacks package in package-only releases', () => {
    expect(cloud).toContain('@stacksjs/defaults/resources/plugins/preloader')
    expect(cloud).not.toContain('./app/ProductionPreloader.ts')
    expect(existsSync(resolve(root, 'app/ProductionPreloader.ts'))).toBe(false)
  })

  it('resolves the published package entry point', () => {
    expect(() => Bun.resolveSync('@stacksjs/defaults/resources/plugins/preloader', root)).not.toThrow()
  })

  it('lets app models override same-named framework globals', () => {
    const privateKey = testPrivateKey()
    const result = Bun.spawnSync([
      process.execPath,
      '--preload',
      '@stacksjs/defaults/resources/plugins/preloader',
      resolve(root, 'tests/fixtures/production-preloader-probe.ts'),
    ], {
      cwd: root,
      env: {
        ...process.env,
        APP_ENV: 'test',
        NODE_ENV: 'test',
        ...(privateKey ? { DOTENV_PRIVATE_KEY_TEST: privateKey } : {}),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
    expect(JSON.parse(result.stdout.toString())).toEqual({
      reviewTable: 'trail_reviews',
      reviewWhere: 'function',
      userWhere: 'function',
    })
  })
})
