import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  allTrailsPath,
  allTrailsText,
  isSearchable,
  MIN_SEARCH_LENGTH,
  nothingFoundText,
  searchPaths,
  SEARCH_QUICK_LINKS,
  SEARCH_SECTIONS,
  searchSections,
} from '../../resources/functions/search-results'

/**
 * The asking half of search, added to the module that already does the
 * grouping when `/search` was promoted to a native screen.
 *
 * The paths matter most. They were spelled out in the web page's own script,
 * and one of them — the place href inside `groupSearchResults` — was built
 * with `URLSearchParams`, which does not exist in JavaScriptCore. A native
 * screen importing this module would have failed silently.
 */

const GROUPS = {
  places: [{ label: 'San Diego', detail: 'California · Trails nearby', href: '/trails?near=San%20Diego' }],
  trails: [{ label: 'Cowles Mountain', detail: '3 mi', href: '/trail/7' }],
  athletes: [],
  clubs: [{ label: 'Dawn Patrol', detail: '12 members', href: '/club/2' }],
  events: [],
}

describe('searchPaths', () => {
  it('asks five endpoints, each escaped', () => {
    const paths = searchPaths('san diego')

    expect(paths.towns).toBe('/api/geo/search?q=san%20diego&limit=3')
    expect(paths.suggestions).toBe('/api/search/suggest?q=san%20diego')
    expect(paths.athletes).toBe('/api/users/search?q=san%20diego&limit=5')
    expect(paths.clubs).toBe('/api/clubs?q=san%20diego&limit=4')
    expect(paths.events).toBe('/api/events?q=san%20diego&limit=4')
  })

  it('escapes what somebody can actually type', () => {
    expect(searchPaths('Großer Arber & Co').towns).toContain('q=Gro%C3%9Fer%20Arber%20%26%20Co')
    expect(searchPaths('  trimmed  ').towns).toContain('q=trimmed&')
  })

  /*
   * No `URLSearchParams` anywhere in this module: the native screen imports
   * it, and nothing assigns that class in JavaScriptCore.
   */
  it('builds every path without a web API', () => {
    // The call, not the word: this module's comments explain why
    // `URLSearchParams` is not used, and a naive match finds the prose.
    const source = readFileSync(new URL('../../resources/functions/search-results.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

    expect(source).not.toContain('URLSearchParams')
    expect(source).not.toContain('new URL(')
  })
})

describe('isSearchable', () => {
  it('waits for two characters, because one matches most of the catalog', () => {
    expect(MIN_SEARCH_LENGTH).toBe(2)
    expect(isSearchable('a')).toBe(false)
    expect(isSearchable('ab')).toBe(true)
    expect(isSearchable('  a  ')).toBe(false)
    expect(isSearchable(null)).toBe(false)
  })
})

describe('searchSections', () => {
  it('keeps the groups that found something, in the page\'s order', () => {
    expect(searchSections(GROUPS as any).map(section => section.key)).toEqual(['places', 'trails', 'clubs'])
  })

  it('names each one', () => {
    expect(searchSections(GROUPS as any)[0].title).toBe('Places')
    expect(SEARCH_SECTIONS.map(section => section.key)).toEqual(['places', 'trails', 'athletes', 'clubs', 'events'])
  })

  it('has nothing to show before an answer', () => {
    expect(searchSections(null)).toEqual([])
    expect(searchSections(undefined)).toEqual([])
  })
})

describe('the words around a result', () => {
  it('quotes what was typed', () => {
    expect(nothingFoundText('  sna  ')).toBe('Nothing matches “sna” yet.')
    expect(allTrailsText('gorge')).toBe('See all trails matching “gorge”')
  })

  it('escapes it on the way to the trails page', () => {
    expect(allTrailsPath('san diego')).toBe('/trails?q=san%20diego')
  })
})

describe('SEARCH_QUICK_LINKS', () => {
  /*
   * A screen the app draws itself is pushed natively; the two that need a map
   * or a location fix are still the website, and say so by having no screen.
   */
  it('names a native screen for the ones we draw', () => {
    const byLabel = Object.fromEntries(SEARCH_QUICK_LINKS.map(link => [link.label, link.screen]))

    expect(byLabel['Find athletes']).toBe('Athletes')
    expect(byLabel.Clubs).toBe('Clubs')
    expect(byLabel.Events).toBe('Events')
    expect(byLabel.Records).toBe('Records')
  })

  it('leaves the map and the location fix on the website', () => {
    const webOnly = SEARCH_QUICK_LINKS.filter(link => !link.screen).map(link => link.label)

    expect(webOnly).toEqual(['Trails near me', 'Territory map'])
  })

  it('gives every link somewhere to go', () => {
    for (const link of SEARCH_QUICK_LINKS) {
      expect(link.href.startsWith('/')).toBe(true)
      expect(link.detail.length).toBeGreaterThan(0)
    }
  })
})
