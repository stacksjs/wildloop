import { describe, expect, it } from 'bun:test'
import {
  battleRowsFrom,
  feedBadge,
  feedLine,
  hereLine,
  herePhrase,
  territoryHistory,
} from '../../resources/functions/battles'
import {
  isOwnTerritory,
  territoryIdFrom,
  territoryActionLabel,
  territoryFrom,
  territoryHolderLine,
  territoryStandingText,
} from '../../resources/functions/territories'

/**
 * One territory's own page, added when `/territory/:id` was promoted.
 *
 * The thing worth pinning is the third voice. The battle feed names the
 * territory ("Marta is attacking Balboa Loop"); on the territory's own page
 * the reader is already looking at it, so the line is relative to the ground
 * ("Marta is attacking it"). Three voices now read the same rows, and the way
 * this has gone wrong before is two of them converging.
 */

const ME = 12
const RIVAL = 44

const FEATURE = {
  territory: {
    properties: {
      id: 7,
      name: 'Balboa Loop',
      ownerId: ME,
      ownerName: 'Glenn',
      areaSize: 240_000,
      conquestCount: 2,
      defendCount: 5,
      claimedAt: '2026-10-01T07:00:00.000Z',
      status: 'active',
      centerLat: 32.73,
      centerLng: -117.15,
    },
    geometry: { type: 'Polygon', coordinates: [[[-117.16, 32.72], [-117.14, 32.72], [-117.14, 32.74]]] },
  },
}

function battle(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    territory_id: 7,
    territoryName: 'Balboa Loop',
    attacker_id: RIVAL,
    attackerName: 'Marta',
    defender_id: ME,
    defenderName: 'Glenn',
    status: 'conquered',
    areaCaptured: 1200,
    created_at: '2026-10-14T07:00:00.000Z',
    ...over,
  }
}

describe('territoryFrom', () => {
  /*
   * `TerritoryShowAction` says it answers "shaped exactly like a feature from
   * /api/territories/map", so it is read through the same function — a second
   * reader could disagree about the ring order, which is the silent failure
   * this whole module exists to avoid.
   */
  it('reads one territory through the same reader as the map', () => {
    const row = territoryFrom(FEATURE)!

    expect(row).toMatchObject({ id: 7, name: 'Balboa Loop', userId: ME, areaSize: 240_000 })
    expect(row.ring).toEqual([[32.72, -117.16], [32.72, -117.14], [32.74, -117.14]])
  })

  it('answers nothing for a payload with no territory', () => {
    for (const payload of [null, undefined, {}, { territory: null }, 'nope'])
      expect(territoryFrom(payload)).toBeNull()
  })
})

describe('territoryIdFrom', () => {
  it('reads a plain id', () => {
    expect(territoryIdFrom('7')).toBe(7)
    expect(territoryIdFrom('07')).toBe(7)
    expect(territoryIdFrom(7)).toBe(7)
    expect(territoryIdFrom(' 7 ')).toBe(7)
  })

  /*
   * The reason this is not `Number.parseInt`. It reads both of these as 7, so
   * `/territory/7.5.1` would load a zone the path does not name — the same
   * hazard the web page's `-1` sentinel guards against.
   */
  it('refuses a parameter that only starts like a number', () => {
    expect(territoryIdFrom('7.5.1')).toBeNull()
    expect(territoryIdFrom('7abc')).toBeNull()
    expect(territoryIdFrom('7 8')).toBeNull()
    expect(Number.parseInt('7.5.1', 10)).toBe(7)
  })

  it('refuses anything that is not a positive whole id', () => {
    for (const raw of ['', '0', '-3', 'abc', 'NaN', '1e3', '1.0', null, undefined, {}, [], Number.NaN])
      expect(territoryIdFrom(raw as unknown)).toBeNull()
  })

  it('refuses an id past safe integers rather than rounding it', () => {
    expect(territoryIdFrom('9007199254740993')).toBeNull()
  })
})

describe('whose ground it is', () => {
  const mine = territoryFrom(FEATURE)!
  const theirs = territoryFrom({ territory: { ...FEATURE.territory, properties: { ...FEATURE.territory.properties, ownerId: RIVAL, ownerName: 'Marta' } } })!

  it('knows the viewer\'s own', () => {
    expect(isOwnTerritory(mine, ME)).toBe(true)
    expect(isOwnTerritory(theirs, ME)).toBe(false)
  })

  /*
   * Signed out, nothing is the viewer's. A `viewerId` of 0 is the screen's
   * "not known yet" and must not match an `ownerId` of 0 on an unclaimed zone.
   */
  it('gives nobody ownership of anything', () => {
    expect(isOwnTerritory(mine, null)).toBe(false)
    expect(isOwnTerritory(mine, 0)).toBe(false)
    const unclaimed = territoryFrom({ territory: { ...FEATURE.territory, properties: { ...FEATURE.territory.properties, ownerId: 0, ownerName: '' } } })!
    expect(isOwnTerritory(unclaimed, 0)).toBe(false)
  })

  it('names the holder, in the second person where it applies', () => {
    expect(territoryHolderLine(mine, ME)).toBe('Held by you')
    expect(territoryHolderLine(theirs, ME)).toBe('Held by Marta')
    expect(territoryHolderLine(null, ME)).toBe('')
  })

  it('says whether it is being fought over', () => {
    expect(territoryStandingText(mine)).toBe('Secure')
    expect(territoryStandingText({ ...mine, status: 'contested' })).toBe('Contested')
  })

  /* The button goes to the same place either way; the words are the point. */
  it('offers the action that fits', () => {
    expect(territoryActionLabel(mine, ME)).toBe('Defend it')
    expect(territoryActionLabel(theirs, ME)).toBe('Conquer this')
    expect(territoryActionLabel(mine, null)).toBe('Conquer this')
  })
})

describe('territoryHistory', () => {
  const battles = battleRowsFrom({
    battles: [
      battle({ id: 1, territory_id: 7, created_at: '2026-10-12T07:00:00.000Z' }),
      battle({ id: 2, territory_id: 7, created_at: '2026-10-14T07:00:00.000Z' }),
      battle({ id: 3, territory_id: 99, created_at: '2026-10-15T07:00:00.000Z' }),
    ],
  })

  it('keeps only this zone\'s battles', () => {
    expect(territoryHistory(battles, 7).map(b => b.id)).toEqual([2, 1])
  })

  /* Sorted rather than trusted: the endpoint orders by date and a page that
   * depends on that reorders silently the day it stops. */
  it('puts the newest first, whatever order they arrived in', () => {
    const shuffled = [battles[0], battles[1]]
    expect(territoryHistory(shuffled, 7).map(b => b.id)).toEqual([2, 1])
    expect(territoryHistory([battles[1], battles[0]], 7).map(b => b.id)).toEqual([2, 1])
  })

  it('has nothing for a zone nobody has fought over', () => {
    expect(territoryHistory(battles, 1234)).toEqual([])
    expect(territoryHistory([], 7)).toEqual([])
  })
})

describe('the voice on a territory\'s own page', () => {
  const taken = battleRowsFrom({ battles: [battle({ status: 'conquered' })] })[0]
  const open = battleRowsFrom({ battles: [battle({ status: 'active' })] })[0]
  const held = battleRowsFrom({ battles: [battle({ status: 'defended' })] })[0]

  it('speaks relative to the ground, which the reader is already looking at', () => {
    expect(herePhrase(taken)).toBe('took ground here')
    expect(herePhrase(open)).toBe('is attacking it')
    expect(herePhrase(held)).toBe('was held off')
  })

  it('reads as a sentence with the attacker', () => {
    expect(hereLine(open)).toBe('Marta is attacking it')
  })

  /*
   * Three voices read these rows now. This one must not drift into the feed's,
   * which names the territory — on its own page that reads as a stutter.
   */
  it('does not name the territory the page is already about', () => {
    for (const row of [taken, open, held]) {
      expect(hereLine(row)).not.toContain('Balboa Loop')
      expect(feedLine(row)).toContain('Balboa Loop')
    }
  })

  /* The badge is the feed's, deliberately: "Conquered" means the same here. */
  it('shares the feed\'s badge, which does mean the same thing', () => {
    expect(feedBadge(taken)).toBe('Conquered')
    expect(feedBadge(open)).toBe('Contested')
    expect(feedBadge(held)).toBe('Defended')
  })
})
