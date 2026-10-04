/**
 * Trails near somebody, ranked the way a trail app ranks them.
 *
 * "Near me" used to be a box ordered like the national catalog: length band,
 * then a rating nobody had given, then the longest route. From Santa Monica
 * that opened on a canyon 25 miles away with Temescal Canyon, four miles
 * away, nowhere on the first screen. The order is now appeal against
 * distance (app/Support/trailRanking.ts); this asks the real endpoint.
 *
 * `scripts/start-recording-qa.ts` seeds six rows around Boulder, more than
 * 300 miles from every other seed, so no other suite's trails can reach in.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

/** A house in north Boulder: Flagstaff Road starts at the end of the street. */
const HOME = 'lat=40.0005&lng=-105.2805'

async function trails(query: string): Promise<any> {
  const response = await fetch(`${API}/trails?${query}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json()
}

const names = (payload: any): string[] => payload.trails.map((t: any) => t.name)

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
}, READY_TIMEOUT_MS + 10_000)

describe.skipIf(!qa)('trails near me', () => {
  it('opens on the trail worth the trip, not the road at the end of the street', async () => {
    const near = await trails(`${HOME}&limit=10`)

    expect(names(near)[0]).toBe('Royal Arch Trail')
    // Closer, and still behind every real trail.
    expect(names(near).indexOf('Flagstaff Road')).toBeGreaterThan(names(near).indexOf('Mesa Trail'))
    expect(names(near).at(-1)).toBe('Proposed Gregory Spur')
  })

  it('lists one trail once, keeping the whole trail rather than a piece of it', async () => {
    const near = await trails(`${HOME}&limit=10`)

    expect(names(near).filter(name => name === 'Royal Arch Trail')).toHaveLength(1)
    expect(near.trails.find((t: any) => t.name === 'Royal Arch Trail').distance).toBe(3.4)
    // The total counts trails, not catalog rows, so "N trails" is true.
    expect(near.meta.total).toBe(5)
  })

  it('says how far each trail is from where the list was asked about', async () => {
    const near = await trails(`${HOME}&limit=10`)

    for (const trail of near.trails)
      expect(typeof trail.milesAway).toBe('number')
    expect(near.trails.find((t: any) => t.name === 'Flagstaff Road').milesAway).toBeLessThan(0.2)

    const national = await trails('country=all&limit=5')
    expect(national.trails.every((t: any) => t.milesAway === undefined)).toBe(true)
  })

  it('puts the closest real trail first under Closest', async () => {
    const closest = await trails(`${HOME}&sort=nearest&limit=10`)

    // The fire road is a real path and genuinely closest. The proposed spur
    // is closer still, and is not a trail anybody should be sent down.
    expect(names(closest)[0]).toBe('Flagstaff Road')
    expect(names(closest).at(-1)).toBe('Proposed Gregory Spur')
    const miles = closest.trails.slice(0, -1).map((t: any) => t.milesAway)
    expect(miles).toEqual([...miles].sort((a, b) => a - b))
  })

  it('pages without repeating or skipping a trail', async () => {
    const all = names(await trails(`${HOME}&limit=10`))
    const paged = [
      ...names(await trails(`${HOME}&limit=2&offset=0`)),
      ...names(await trails(`${HOME}&limit=2&offset=2`)),
      ...names(await trails(`${HOME}&limit=2&offset=4`)),
    ]
    expect(paged).toEqual(all)
  })

  it('keeps every filter while ranking', async () => {
    const long = await trails(`${HOME}&minDistance=5&limit=10`)
    expect(names(long).sort()).toEqual(['Mesa Trail', 'Walker Ranch Loop'])
  })

  it('leaves the orders that mean the same anywhere to the catalog', async () => {
    const longest = await trails(`${HOME}&sort=longest&limit=10`)
    expect(names(longest)[0]).toBe('Walker Ranch Loop')
    // Unranked, so the catalog's rows come back as rows.
    expect(names(longest).filter(name => name === 'Royal Arch Trail')).toHaveLength(2)
  })
})
