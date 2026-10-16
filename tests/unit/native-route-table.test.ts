import { describe, expect, it } from 'bun:test'
import { matchNativePath } from 'craft-native/ios'
import mobile from '../../config/mobile'

/**
 * Which paths the app answers natively, checked against craft's own matcher.
 *
 * `ios.nativeScreens` is a route *table*, not a list of names: the shell
 * matches patterns (`CraftHybridRoutes` in CraftHybrid.swift), and
 * `matchNativePath` is the TypeScript twin of those rules — craft holds both
 * plus its page script to one set of cases. Using it here means this test
 * checks the table against the implementation that will actually route it,
 * rather than against my reading of the precedence rules.
 *
 * Added with `/territory/:id`, the first promoted path with a parameter. Up to
 * then every key was a static string and the table could not be got wrong.
 */

const SCREENS = mobile.ios.nativeScreens as Record<string, string>

function match(path: string) {
  return matchNativePath(SCREENS, path)
}

describe('the native route table', () => {
  it('routes a parameterised path and binds the parameter', () => {
    expect(match('/territory/7')).toMatchObject({ screen: 'TerritoryDetail', params: { id: '7' } })
  })

  /*
   * The reason the precedence rules matter here. `/territories` and
   * `/territory/:id` are one character apart, and a table that let the
   * parameter win would send the list screen's own path to the detail screen.
   */
  it('keeps the list path on the list screen', () => {
    expect(match('/territories')?.screen).toBe('Territories')
    expect(match('/territories')?.params).toEqual({})
  })

  it('does not swallow a deeper path under the parameter', () => {
    // One segment only: `/territory/7/edit` is not this screen.
    expect(match('/territory/7/edit')).toBeNull()
  })

  it('leaves a path with no entry to the web view', () => {
    for (const path of ['/feed', '/trail/7', '/settings', '/'])
      expect(match(path)).toBeNull()
  })

  it('carries a query into params, under the path\'s own', () => {
    const found = match('/territory/7?from=feed')

    expect(found).toMatchObject({ screen: 'TerritoryDetail', params: { id: '7', from: 'feed' } })
  })

  /*
   * A query cannot overwrite a path parameter — craft binds the path's own
   * first and skips a query key that is already set. Worth pinning: the screen
   * reads `params.id` and a link could otherwise choose which zone it loads.
   */
  it('does not let a query override the path parameter', () => {
    expect(match('/territory/7?id=99')?.params.id).toBe('7')
  })

  it('routes every static path in the table to its own screen', () => {
    for (const [pattern, screen] of Object.entries(SCREENS)) {
      if (pattern.includes(':') || pattern.includes('*'))
        continue
      expect(match(pattern)?.screen).toBe(screen)
    }
  })

  /*
   * Every screen the table names must exist, or the build throws at
   * `nativeScreenFiles`. Cheaper to find here than in a build log.
   */
  it('names only screens that exist', async () => {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(import.meta.dir, '../../resources/native')

    for (const screen of new Set(Object.values(SCREENS)))
      expect(existsSync(join(dir, `${screen}.stx`))).toBe(true)
  })
})
