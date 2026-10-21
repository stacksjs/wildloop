import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * A workflow GitHub cannot read does not fail a job: it fails at once, named
 * by its path instead of its name, and every job in it silently never runs.
 * Removing the last variable under a job's `env:` left the key with nothing
 * under it, and Mobile E2E stopped running on push without anything here
 * noticing. Each workflow parses, and no job carries a key with no value.
 */
const dir = join(import.meta.dir, '../../.github/workflows')
const files = readdirSync(dir).filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))

describe('GitHub workflow files', () => {
  it.each(files)('%s parses, with a name and jobs', (file) => {
    const workflow = Bun.YAML.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, any>
    expect(workflow?.name, `${file} has no name`).toBeString()
    expect(Object.keys(workflow?.jobs ?? {}).length, `${file} has no jobs`).toBeGreaterThan(0)
  })

  it.each(files)('%s has no job with an empty env, steps or runs-on', (file) => {
    const workflow = Bun.YAML.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, any>
    for (const [name, job] of Object.entries<Record<string, unknown>>(workflow.jobs ?? {})) {
      for (const key of ['env', 'steps', 'runs-on', 'with', 'strategy']) {
        if (key in job)
          expect(job[key], `${file} job ${name} has an empty ${key}`).not.toBeNull()
      }
    }
  })
})
