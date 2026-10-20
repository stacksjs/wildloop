import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')

describe('the installed STX runtime cohort', () => {
  it('uses the same engine for framework view servers and application components', () => {
    const engine = Bun.resolveSync('@stacksjs/stx', root)
    const components = Bun.resolveSync('@stacksjs/components', root)
    const plugin = Bun.resolveSync('bun-plugin-stx/serve', root)

    // A valid but older transitive plugin can otherwise emit a browser runtime
    // that lacks APIs required by the application's newer shared components.
    for (const framework of ['@stacksjs/actions', '@stacksjs/buddy']) {
      const entry = Bun.resolveSync(framework, root)
      const server = Bun.resolveSync('bun-plugin-stx/serve', entry)
      expect(server).toBe(plugin)
      expect(Bun.resolveSync('@stacksjs/stx', server)).toBe(engine)
      expect(Bun.resolveSync('@stacksjs/components', entry)).toBe(components)
    }
    expect(Bun.resolveSync('@stacksjs/stx', components)).toBe(engine)
    expect(Bun.resolveSync('@stacksjs/components', Bun.resolveSync('@stacksjs/ui', root))).toBe(components)
  })
})
