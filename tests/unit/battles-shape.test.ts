import { describe, expect, it } from 'bun:test'
import {
  battleRowsFrom,
  battlesPath,
  conquestEmptyText,
  countByStatus,
  feedBadge,
  feedLine,
  feedVerb,
  filterBattlesByArea,
  filterBattlesByPeriod,
  filterConquests,
  isMyAttack,
  liveBattles,
  ownBadge,
  ownBattles,
  ownLine,
  ownPhrase,
  underAttack,
  wonBattle,
} from '../../resources/functions/battles'

/**
 * The reading half of the battle feed, added when `/battles` and `/conquests`
 * were promoted to native screens.
 *
 * One row shape, two voices. The feed talks about other people and the record
 * talks to the player, and the two used to carry separate badge functions that
 * disagreed — the same battle read "Conquered" on one page and "Lost" on the
 * other. Both are here, and these tests are mostly about keeping them apart.
 */

const ME = 12
const RIVAL = 44

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    territory_id: 7,
    territoryName: 'Balboa Loop',
    centerLat: 32.73,
    centerLng: -117.15,
    attacker_id: RIVAL,
    attackerName: 'Marta',
    attackerAvatar: null,
    defender_id: ME,
    defenderName: 'Glenn',
    defenderAvatar: null,
    status: 'conquered',
    areaCaptured: 1200,
    runDistance: 5.1,
    description: '',
    created_at: '2026-10-15T07:00:00.000Z',
    ...over,
  }
}

describe('battlesPath', () => {
  it('asks for the newest of the whole game by default', () => {
    expect(battlesPath()).toBe('/api/territories/battles?limit=200')
  })

  /*
   * A player's own record is every battle they were ever in, not whichever of
   * them are still among the last 200 anyone fought.
   */
  it('asks for all of the athlete\'s own, when it is theirs', () => {
    expect(battlesPath({ mine: true })).toBe('/api/territories/battles?limit=1000&mine=1')
  })

  it('takes an explicit limit', () => {
    expect(battlesPath({ limit: 5 })).toBe('/api/territories/battles?limit=5')
  })
})

describe('battleRowsFrom', () => {
  it('reads the rows the API answers with', () => {
    const [battle] = battleRowsFrom({ battles: [row()] })

    expect(battle).toMatchObject({ id: 1, territoryName: 'Balboa Loop', attacker_id: RIVAL, defender_id: ME, status: 'conquered' })
  })

  it('treats an unknown status as a battle still open', () => {
    expect(battleRowsFrom({ battles: [row({ status: 'weird' })] })[0].status).toBe('active')
  })

  it('keeps a missing centre as unknown rather than zero', () => {
    const [battle] = battleRowsFrom({ battles: [row({ centerLat: null, centerLng: null })] })

    expect(battle.centerLat).toBeNull()
    expect(battle.centerLng).toBeNull()
  })

  it('survives a payload that is not what it should be', () => {
    for (const payload of [null, undefined, {}, 'nope', { battles: 'nope' }, { battles: [null, {}] }])
      expect(battleRowsFrom(payload)).toEqual([])
  })
})

describe('filterBattlesByPeriod', () => {
  /*
   * `now` is passed in rather than read from the clock, so "today" means
   * something fixed instead of depending on when the suite runs.
   */
  const NOW = new Date('2026-10-15T20:00:00.000Z').getTime()
  const battles = battleRowsFrom({
    battles: [
      row({ id: 1, created_at: new Date(NOW - 3600_000).toISOString() }),
      row({ id: 2, created_at: new Date(NOW - 3 * 86_400_000).toISOString() }),
      row({ id: 3, created_at: new Date(NOW - 40 * 86_400_000).toISOString() }),
    ],
  })

  it('keeps everything under all time', () => {
    expect(filterBattlesByPeriod(battles, 'all', NOW)).toHaveLength(3)
  })

  it('keeps the week', () => {
    expect(filterBattlesByPeriod(battles, 'week', NOW).map(b => b.id)).toEqual([1, 2])
  })

  it('keeps today, from midnight', () => {
    expect(filterBattlesByPeriod(battles, 'today', NOW).map(b => b.id)).toEqual([1])
  })

  it('drops a row whose date is unreadable rather than counting it as now', () => {
    const broken = battleRowsFrom({ battles: [row({ created_at: 'not a date' })] })

    expect(filterBattlesByPeriod(broken, 'today', NOW)).toEqual([])
  })
})

describe('filterBattlesByArea', () => {
  const battles = battleRowsFrom({
    battles: [
      row({ id: 1, centerLat: 32.73, centerLng: -117.15 }),
      row({ id: 2, centerLat: 40.71, centerLng: -74.00 }),
      row({ id: 3, centerLat: null, centerLng: null }),
    ],
  })

  it('keeps only what is inside the box', () => {
    const box = { minLat: 32.5, minLng: -117.4, maxLat: 33.0, maxLng: -117.0 }

    expect(filterBattlesByArea(battles, box).map(b => b.id)).toEqual([1])
  })

  it('keeps everything with no box at all', () => {
    expect(filterBattlesByArea(battles, null)).toHaveLength(3)
  })
})

describe('the feed voice', () => {
  it('says what happened, about other people', () => {
    expect(feedVerb(battleRowsFrom({ battles: [row({ status: 'conquered' })] })[0])).toBe('conquered')
    expect(feedVerb(battleRowsFrom({ battles: [row({ status: 'active' })] })[0])).toBe('is attacking')
    expect(feedVerb(battleRowsFrom({ battles: [row({ status: 'defended' })] })[0])).toBe('failed to conquer')
  })

  it('badges a contest still open as contested, not as failed', () => {
    expect(feedBadge(battleRowsFrom({ battles: [row({ status: 'active' })] })[0])).toBe('Contested')
    expect(feedBadge(battleRowsFrom({ battles: [row({ status: 'defended' })] })[0])).toBe('Defended')
  })

  it('reads as a sentence', () => {
    expect(feedLine(battleRowsFrom({ battles: [row({ status: 'active' })] })[0])).toBe('Marta is attacking Balboa Loop')
  })

  it('counts the live ones and each outcome', () => {
    const battles = battleRowsFrom({
      battles: [row({ id: 1, status: 'active' }), row({ id: 2, status: 'conquered' }), row({ id: 3, status: 'defended' })],
    })

    expect(liveBattles(battles).map(b => b.id)).toEqual([1])
    expect(countByStatus(battles, 'conquered')).toBe(1)
    expect(countByStatus(battles, 'defended')).toBe(1)
  })
})

describe('the athlete\'s own record', () => {
  const battles = battleRowsFrom({
    battles: [
      // Theirs, lost.
      row({ id: 1, attacker_id: RIVAL, defender_id: ME, status: 'conquered' }),
      // Theirs, defended.
      row({ id: 2, attacker_id: RIVAL, defender_id: ME, status: 'defended' }),
      // Theirs, an attack that landed.
      row({ id: 3, attacker_id: ME, defender_id: RIVAL, status: 'conquered' }),
      // Somebody else's fight entirely.
      row({ id: 4, attacker_id: 90, defender_id: 91, status: 'conquered' }),
    ],
  })

  /*
   * The bug this replaces: "All" listed every battle in the game under "Your
   * conquests", each labelled as though the player had been in it.
   */
  it('counts only battles the athlete was actually in', () => {
    expect(ownBattles(battles, ME).map(b => b.id)).toEqual([1, 2, 3])
    expect(filterConquests(battles, 'all', ME).map(b => b.id)).toEqual([1, 2, 3])
  })

  it('has nothing to show for nobody', () => {
    expect(ownBattles(battles, null)).toEqual([])
    expect(filterConquests(battles, 'all', 0)).toEqual([])
  })

  it('splits attacks from defences from losses', () => {
    expect(filterConquests(battles, 'attacks', ME).map(b => b.id)).toEqual([3])
    expect(filterConquests(battles, 'defenses', ME).map(b => b.id)).toEqual([1, 2])
    expect(filterConquests(battles, 'lost', ME).map(b => b.id)).toEqual([1])
  })

  /*
   * Every attack used to read "You conquered", including one that only
   * contested the land and one the owner ran off.
   */
  it('tells each outcome from the athlete\'s side', () => {
    const [lost, defended, took] = ownBattles(battles, ME)

    expect(ownLine(lost, ME)).toBe('Marta took ground from you at Balboa Loop')
    expect(ownLine(defended, ME)).toBe('You held off Marta at Balboa Loop')
    expect(ownLine(took, ME)).toBe('You took ground from Glenn at Balboa Loop')
  })

  /*
   * The web page links the territory name as its own element, so it needs the
   * phrase that stops before it; the native screen needs the sentence. Both
   * come from one place rather than one slicing the other's string apart.
   */
  it('offers the phrase without the zone, and the sentence with it', () => {
    const [lost] = ownBattles(battles, ME)

    expect(ownPhrase(lost, ME)).toBe('Marta took ground from you at')
    expect(ownLine(lost, ME)).toBe('Marta took ground from you at Balboa Loop')
    expect(ownLine(lost, ME)).toStartWith(ownPhrase(lost, ME))
  })

  it('leaves no dangling preposition where the zone is the object', () => {
    const open = battleRowsFrom({ battles: [row({ attacker_id: ME, defender_id: RIVAL, status: 'active' })] })[0]

    expect(ownPhrase(open, ME)).toBe('You are contesting')
    expect(ownLine(open, ME)).toBe('You are contesting Balboa Loop')
  })

  it('tells an open battle as open, on either side', () => {
    const mine = battleRowsFrom({ battles: [row({ attacker_id: ME, defender_id: RIVAL, status: 'active' })] })[0]
    const theirs = battleRowsFrom({ battles: [row({ attacker_id: RIVAL, defender_id: ME, status: 'active' })] })[0]

    expect(ownLine(mine, ME)).toBe('You are contesting Balboa Loop')
    expect(ownLine(theirs, ME)).toBe('Marta is attacking Balboa Loop')
  })

  /*
   * The two voices must not converge. The same battle is "Conquered" in the
   * feed and "Lost" to the athlete who held the ground.
   */
  it('badges the same battle differently from the feed', () => {
    const [lost] = ownBattles(battles, ME)

    expect(feedBadge(lost)).toBe('Conquered')
    expect(ownBadge(lost, ME)).toBe('Lost')
  })

  it('badges each of the athlete\'s own outcomes', () => {
    const [lost, defended, took] = ownBattles(battles, ME)

    expect(ownBadge(defended, ME)).toBe('Defended')
    expect(ownBadge(took, ME)).toBe('Conquered')
    expect(ownBadge(lost, ME)).toBe('Lost')
    expect(ownBadge(battleRowsFrom({ battles: [row({ attacker_id: ME, defender_id: RIVAL, status: 'defended' })] })[0], ME)).toBe('Repelled')
    expect(ownBadge(battleRowsFrom({ battles: [row({ attacker_id: ME, defender_id: RIVAL, status: 'active' })] })[0], ME)).toBe('Contesting')
    expect(ownBadge(battleRowsFrom({ battles: [row({ defender_id: ME, attacker_id: RIVAL, status: 'active' })] })[0], ME)).toBe('Under attack')
  })

  it('knows which side the athlete was on', () => {
    expect(isMyAttack(battles[2], ME)).toBe(true)
    expect(isMyAttack(battles[0], ME)).toBe(false)
    expect(isMyAttack(battles[0], null)).toBe(false)
  })

  /* An open battle is neither won nor lost, which is not the same as lost. */
  it('calls an open battle neither', () => {
    const open = battleRowsFrom({ battles: [row({ attacker_id: ME, defender_id: RIVAL, status: 'active' })] })[0]

    expect(wonBattle(open, ME)).toBeNull()
    expect(wonBattle(battles[2], ME)).toBe(true)
    expect(wonBattle(battles[0], ME)).toBe(false)
    expect(wonBattle(battles[1], ME)).toBe(true)
  })

  it('lists the ground being taken right now, and holds the list short', () => {
    const many = battleRowsFrom({
      battles: Array.from({ length: 9 }, (_, index) => row({ id: index + 1, attacker_id: RIVAL, defender_id: ME, status: 'active' })),
    })

    expect(underAttack(many, ME)).toHaveLength(5)
    expect(underAttack(many, null)).toEqual([])
    // An attack of the athlete's own is not their ground being taken. Both
    // sides are set explicitly: `row()` defends as ME by default, so
    // overriding only the attacker puts the athlete on both sides of it.
    const ofMine = battleRowsFrom({ battles: [row({ attacker_id: ME, defender_id: RIVAL, status: 'active' })] })
    expect(underAttack(ofMine, ME)).toEqual([])
  })

  it('says something different for each empty filter', () => {
    const said = new Set(['all', 'attacks', 'defenses', 'lost'].map(filter => conquestEmptyText(filter as any)))

    expect(said.size).toBe(4)
  })
})
