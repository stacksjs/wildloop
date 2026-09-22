import { describe, expect, it } from 'bun:test'
import { groupSearchResults } from '../../resources/functions/search-results'

describe('search results', () => {
  it('groups places and regions, trails and athletes into rows', () => {
    const groups = groupSearchResults(
      [
        { kind: 'region', label: 'Utah', detail: 'Region · 40 trails', href: '/trails?state=UT' },
        { kind: 'place', label: 'Yosemite Valley, CA', detail: '2 trails', href: '/trails?q=Yosemite' },
        { kind: 'trail', label: 'Half Dome', detail: 'Yosemite NP, CA', href: '/trail/7' },
      ],
      [{ id: 8, name: 'Harvey Lewis', activityCount: 1, followerCount: 5 }],
    )

    expect(groups.places.map(p => p.label)).toEqual(['Utah', 'Yosemite Valley, CA'])
    expect(groups.trails).toEqual([{ label: 'Half Dome', detail: 'Yosemite NP, CA', href: '/trail/7' }])
    expect(groups.athletes).toEqual([{ label: 'Harvey Lewis', detail: '1 activity · 5 followers', href: '/athlete/8', initial: 'H' }])
  })

  it('drops rows it cannot link to', () => {
    const groups = groupSearchResults([{ kind: 'trail', label: 'No link' }], [{ name: 'No id' }])
    expect(groups.trails).toEqual([])
    expect(groups.athletes).toEqual([])
  })
})
