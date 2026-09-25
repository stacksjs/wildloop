import { describe, expect, it } from 'bun:test'
import { encodePolyline } from '../../resources/functions/polyline'
import { firstAnswer, footpathFromResponse, footpathRequest, readPoint, valhallaServers } from '../../app/Support/routing'

describe('valhallaServers', () => {
  it('tries our own server first, then the public one', () => {
    expect(valhallaServers({ VALHALLA_URL: 'http://10.0.0.5:8002' }).map(s => s.baseUrl))
      .toEqual(['http://10.0.0.5:8002', 'https://valhalla1.openstreetmap.de'])
  })

  it('uses only the public server until ours is configured', () => {
    expect(valhallaServers({}).map(s => s.baseUrl)).toEqual(['https://valhalla1.openstreetmap.de'])
  })

  it('can turn the fallback off, and never lists one server twice', () => {
    expect(valhallaServers({ VALHALLA_URL: 'http://own', VALHALLA_FALLBACK_URL: 'off' }).map(s => s.baseUrl)).toEqual(['http://own'])
    expect(valhallaServers({ VALHALLA_URL: 'http://own', VALHALLA_FALLBACK_URL: 'http://own' })).toHaveLength(1)
  })

  it('gives our own server the shorter timeout', () => {
    const [own, fallback] = valhallaServers({ VALHALLA_URL: 'http://own' })
    expect(own.timeoutMs).toBeLessThan(fallback.timeoutMs)
  })
})

describe('firstAnswer', () => {
  const servers = [{ baseUrl: 'own', timeoutMs: 1 }, { baseUrl: 'public', timeoutMs: 1 }]

  it('answers from the first server that can', async () => {
    const asked: string[] = []
    const answer = await firstAnswer(servers, async (s) => {
      asked.push(s.baseUrl)
      if (s.baseUrl === 'own')
        throw new Error('outside coverage')
      return 'from public'
    })
    expect(answer).toBe('from public')
    expect(asked).toEqual(['own', 'public'])
  })

  it('does not ask the fallback when the first server answers', async () => {
    const asked: string[] = []
    expect(await firstAnswer(servers, async (s) => {
      asked.push(s.baseUrl)
      return s.baseUrl
    })).toBe('own')
    expect(asked).toEqual(['own'])
  })

  it('reports the last failure when none can, and says when none is configured', async () => {
    await expect(firstAnswer(servers, async (s) => {
      throw new Error(`${s.baseUrl} down`)
    })).rejects.toThrow('public down')
    await expect(firstAnswer([], async () => 1)).rejects.toThrow(/No routing server/)
  })
})

describe('readPoint', () => {
  it('reads lat,lng and refuses the rest', () => {
    expect(readPoint('32.71,-117.16')).toEqual({ lat: 32.71, lng: -117.16 })
    expect(readPoint('91,0')).toBeNull()
    expect(readPoint('abc')).toBeNull()
    expect(readPoint(undefined)).toBeNull()
  })
})

describe('footpath routing', () => {
  it('asks for pedestrian routing that prefers paths and admits mountain trails', () => {
    const body = footpathRequest({ lat: 34.18, lng: -118.77 }, { lat: 34.19, lng: -118.78 }) as any
    expect(body.costing).toBe('pedestrian')
    expect(body.locations).toEqual([{ lat: 34.18, lon: -118.77 }, { lat: 34.19, lon: -118.78 }])
    const pedestrian = body.costing_options.pedestrian
    // Footways and paths cheaper than streets.
    expect(pedestrian.walkway_factor).toBeLessThan(1)
    // Valhalla's default (1) refuses every trail graded above sac_scale=hiking
    // and routed legs along ordinary mountain paths out onto the road.
    expect(pedestrian.max_hiking_difficulty).toBeGreaterThanOrEqual(2)
  })

  it('reads the line from every leg without repeating the joins', () => {
    const leg1 = encodePolyline([[34.18, -118.77], [34.181, -118.771]], 6)
    const leg2 = encodePolyline([[34.181, -118.771], [34.182, -118.772]], 6)
    expect(footpathFromResponse({ trip: { legs: [{ shape: leg1 }, { shape: leg2 }] } })).toEqual([
      { lat: 34.18, lng: -118.77 },
      { lat: 34.181, lng: -118.771 },
      { lat: 34.182, lng: -118.772 },
    ])
  })

  it('treats an answer with no line as no route', () => {
    expect(() => footpathFromResponse({})).toThrow(/No route/)
    expect(() => footpathFromResponse({ trip: { legs: [{ shape: '' }] } })).toThrow(/No route/)
  })
})
