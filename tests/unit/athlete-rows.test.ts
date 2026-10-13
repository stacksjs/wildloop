import { describe, expect, it } from 'bun:test'
import {
  areaKm2,
  athleteActivityText,
  athleteFollowerText,
  athleteMatchLine,
  athleteRowsFrom,
  athleteSearchPath,
  athleteStatsLine,
  athleteTerritoryText,
  followRequest,
} from '../../resources/functions/athletes'

/**
 * The athlete directory, as both screens compute it.
 *
 * Extracted from `resources/views/athletes.stx` when the native screen became
 * the second consumer. The follow verb is in here for the same reason the
 * numbers are: a native screen guessing `POST` where the API wants `PUT` is a
 * button that looks like it worked.
 */

const ROW = {
  id: 9,
  name: 'Harvey Lewis',
  avatar: '/api/avatars/9/x.jpg',
  nearYou: false,
  activityCount: 6,
  followerCount: 4,
  territoriesOwned: 3,
  totalAreaOwned: 3_030_000,
}

describe('athleteRowsFrom', () => {
  it('maps the API shape, coercing the numbers', () => {
    const [row] = athleteRowsFrom({ athletes: [{ id: '9', name: 'Harvey Lewis', activityCount: '6' }] })

    expect(row.id).toBe(9)
    expect(row.activityCount).toBe(6)
    expect(row.avatar).toBeNull()
    expect(row.nearYou).toBe(false)
  })

  it('never leaves a row without a name', () => {
    expect(athleteRowsFrom({ athletes: [{ id: 1 }] })[0].name).toBe('Athlete')
  })

  it('returns nothing for a payload that is not a list', () => {
    expect(athleteRowsFrom(null)).toEqual([])
    expect(athleteRowsFrom({ athletes: 'soon' })).toEqual([])
  })
})

describe('the words on a row', () => {
  it('counts one as one', () => {
    expect(athleteActivityText({ activityCount: 1 })).toBe('1 activity')
    expect(athleteActivityText({ activityCount: 6 })).toBe('6 activities')
    expect(athleteFollowerText({ followerCount: 1 })).toBe('1 follower')
    expect(athleteFollowerText({ followerCount: 4 })).toBe('4 followers')
  })

  /*
   * Territory is what distinguishes this from a run tracker, so it is on the
   * row whenever there is any — and absent rather than "0 held · 0.00 km²",
   * which puts a zero where an achievement goes.
   */
  it('says nothing about territory for somebody holding none', () => {
    expect(athleteTerritoryText({ territoriesOwned: 3, totalAreaOwned: 3_030_000 })).toBe('3 held · 3.03 km²')
    expect(athleteTerritoryText({ territoriesOwned: 0, totalAreaOwned: 0 })).toBe('')
  })

  it('joins the parts for a screen that draws them as one line', () => {
    expect(athleteStatsLine(ROW)).toBe('6 activities · 4 followers · 3 held · 3.03 km²')
    expect(athleteStatsLine({ ...ROW, territoriesOwned: 0, totalAreaOwned: 0 }))
      .toBe('6 activities · 4 followers')
  })

  it('converts square metres to the square kilometres a territory is counted in', () => {
    expect(areaKm2(3_030_000)).toBe('3.03')
    expect(areaKm2(0)).toBe('0.00')
  })
})

describe('athleteMatchLine', () => {
  it('names the query it counted', () => {
    expect(athleteMatchLine(1, 'harv')).toBe('One match for “harv”')
    expect(athleteMatchLine(4, ' harv ')).toBe('4 matches for “harv”')
  })

  it('counts without a query, for the browse list', () => {
    expect(athleteMatchLine(18, '')).toBe('18 matches')
  })
})

describe('the requests', () => {
  /*
   * `PUT` to follow, `DELETE` to stop: the verb carries the direction, so there
   * is no body to get wrong and no second endpoint to keep in step.
   */
  it('follows with PUT and unfollows with DELETE', () => {
    expect(followRequest(9, true)).toEqual({ path: '/api/users/9/follow', method: 'PUT' })
    expect(followRequest(9, false)).toEqual({ path: '/api/users/9/follow', method: 'DELETE' })
  })

  it('escapes what it puts in the search query', () => {
    expect(athleteSearchPath('  harvey lewis  ')).toBe('/api/users/search?q=harvey%20lewis')
    expect(athleteSearchPath('')).toBe('/api/users/search?q=')
  })
})
