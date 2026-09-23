import { describe, expect, it } from 'bun:test'
import { matchesText, textQuery } from '../../app/Support/textQuery'
import { groupSearchResults } from '../../resources/functions/search-results'

describe('search results', () => {
  it('groups every answer into rows', () => {
    const groups = groupSearchResults({
      suggestions: [
        { kind: 'region', label: 'Utah', detail: 'Region · 40 trails', href: '/trails?state=UT' },
        { kind: 'place', label: 'Yosemite Valley, CA', detail: '2 trails', href: '/trails?q=Yosemite' },
        { kind: 'trail', label: 'Half Dome', detail: 'Yosemite NP, CA', href: '/trail/7' },
      ],
      athletes: [{ id: 8, name: 'Harvey Lewis', activityCount: 1, followerCount: 5 }],
      clubs: [{ id: 3, name: 'Boulder Trail Runners', location: 'Boulder, CO', memberCount: 1 }],
      events: [
        { id: 4, name: 'Big Backyard', location: 'Bell Buckle, TN', status: 'live' },
        { id: 5, name: 'Winter Yard', status: 'scheduled', startTime: 'not a date' },
      ],
    })

    expect(groups.places.map(p => p.label)).toEqual(['Utah', 'Yosemite Valley, CA'])
    expect(groups.trails).toEqual([{ label: 'Half Dome', detail: 'Yosemite NP, CA', href: '/trail/7' }])
    expect(groups.athletes).toEqual([{ label: 'Harvey Lewis', detail: '1 activity · 5 followers', href: '/athlete/8', initial: 'H' }])
    expect(groups.clubs).toEqual([{ label: 'Boulder Trail Runners', detail: 'Boulder, CO · 1 member', href: '/club/3' }])
    expect(groups.events).toEqual([
      { label: 'Big Backyard', detail: 'Live now · Bell Buckle, TN', href: '/event/4' },
      { label: 'Winter Yard', detail: 'Date to be confirmed', href: '/event/5' },
    ])
  })

  it('drops rows it cannot link to', () => {
    const groups = groupSearchResults({
      suggestions: [{ kind: 'trail', label: 'No link' }],
      athletes: [{ name: 'No id' }],
      clubs: [{ name: 'No id' }],
      events: [{ id: 2 }],
    })
    expect(groups.trails).toEqual([])
    expect(groups.athletes).toEqual([])
    expect(groups.clubs).toEqual([])
    expect(groups.events).toEqual([])
  })
})

describe('text query', () => {
  it('ignores a query too short to narrow anything', () => {
    expect(textQuery('b')).toBe('')
    expect(textQuery(undefined)).toBe('')
    expect(textQuery('  Boulder ')).toBe('boulder')
  })

  it('matches any field, case-insensitively', () => {
    expect(matchesText('boul', 'Front Range Runners', 'Boulder, CO')).toBe(true)
    expect(matchesText('zurich', 'Zurich Night Loop')).toBe(true)
    expect(matchesText('moab', 'Boulder Trail Runners', null)).toBe(false)
    expect(matchesText('', 'anything')).toBe(true)
  })

  it('puts towns first, each opening the trails near it', () => {
    const groups = groupSearchResults({
      towns: [
        { text: 'San Diego, California, United States', center: { lat: 32.71571, lng: -117.16472 }, properties: { name: 'San Diego', region: 'California', countryName: 'United States' } },
        { text: 'Nowhere', center: {} },
      ],
      suggestions: [{ kind: 'place', label: 'Cleveland National Forest', detail: 'CA', href: '/trails?q=Cleveland' }],
    })
    expect(groups.places).toEqual([
      { label: 'San Diego', detail: 'California, United States · Trails nearby', href: '/trails?near=San+Diego&lat=32.71571&lng=-117.16472' },
      { label: 'Cleveland National Forest', detail: 'CA', href: '/trails?q=Cleveland' },
    ])
  })
})
