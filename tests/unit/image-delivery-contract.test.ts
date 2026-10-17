import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')

function stxFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? stxFiles(path) : path.endsWith('.stx') ? [path] : []
  })
}

describe('image delivery contract', () => {
  it('routes application images through the shared Image component', () => {
    const sources = stxFiles(join(root, 'resources'))
      .map(path => readFileSync(path, 'utf8'))
      .join('\n')

    expect(sources).not.toMatch(/<img\b/i)
    expect(sources).not.toMatch(/<picture\b/i)
    expect(sources).not.toMatch(/style=["'][^"']*background-image/i)
    expect(sources).toContain('<Image')
  })

  it('uses the installed STX package without a source override', () => {
    const build = readFileSync(join(root, 'build.ts'), 'utf8')
    expect(build).toContain("from '@stacksjs/stx'")
    expect(build).not.toContain('STX_SOURCE_ROOT')
    expect(build).not.toContain('Code/Tools/stx')
    expect(build).not.toContain("resolve(import.meta.dir, '../../Tools/stx')")
  })
})
