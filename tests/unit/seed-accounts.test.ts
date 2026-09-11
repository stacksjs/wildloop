import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const userSeeder = readFileSync(resolve(import.meta.dir, '../../database/seeders/UserSeeder.ts'), 'utf-8')
const roleSeeder = readFileSync(resolve(import.meta.dir, '../../database/seeders/AdminSeeder.ts'), 'utf-8')
const cloud = readFileSync(resolve(import.meta.dir, '../../config/cloud.ts'), 'utf-8')

describe('deployed test accounts', () => {
  it('seeds the requested admin, normal, and paid identities', () => {
    expect(roleSeeder).toContain("'admin@wildloop.test'")
    expect(userSeeder).toContain("'user@wildloop.test'")
    expect(userSeeder).toContain("'paid@wildloop.test'")
  })

  it('assigns normal and paid access independently', () => {
    expect(roleSeeder).toContain("{ email: NORMAL_EMAIL, roles: ['client'] }")
    expect(roleSeeder).toContain("{ email: PAID_EMAIL, roles: ['client', 'paid'] }")
  })

  it('runs idempotent application seeders after production migrations', () => {
    const accountSeed = "'./buddy seed --skip-models --tag deploy --verbose'"

    expect(cloud.indexOf("'./buddy migrate --no-generate'")).toBeLessThan(cloud.indexOf(accountSeed))
    expect(cloud).toContain(accountSeed)
  })

  it('tags the account seeders, which is what puts them in that run', () => {
    // The deploy selects by tag rather than by name, so these two reaching a
    // deployed environment depends on the tag being ON them. Asserting the
    // command alone would pass while the accounts silently stopped being
    // seeded — which is the failure the tag was meant to prevent, arriving
    // from the other direction.
    expect(userSeeder).toContain("static override tags = ['deploy']")
    expect(roleSeeder).toContain("static override tags = ['deploy']")
  })

  it('keeps the demo corpus out of every deploy', () => {
    // The tag is for seeders that are idempotent AND cheap. The ones that
    // build trails, activities and the land derived from them are neither, and
    // a deploy that waited for them would be a different thing entirely.
    for (const name of ['TrailSeeder', 'ActivitySeeder', 'TerritorySeeder']) {
      const source = readFileSync(resolve(import.meta.dir, `../../database/seeders/${name}.ts`), 'utf-8')
      expect(source).not.toContain("tags = ['deploy']")
    }
  })
})
