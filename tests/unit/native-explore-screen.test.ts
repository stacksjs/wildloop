import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, start, waitForRequest, waitForText, visibility } from '../fixtures/nativeScreen'

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Explore.stx'), 'utf8')

const TRAILS = {
  trails: [
    { id: 7, name: 'Eagle Creek Loop', location: 'Columbia River Gorge, Oregon', latitude: 45.64, longitude: -121.92, distance: 12.4, elevation: 1680, difficulty: 'hard', routeType: 'loop', geometry: null },
    { id: 8, name: 'Dog Mountain', location: 'Cascade Locks, Washington', latitude: 45.69, longitude: -121.7, distance: 6.9, elevation: 2800, difficulty: 'hard', routeType: 'out-and-back', geometry: null },
  ],
  meta: { total: 2, hasMore: false },
}

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('Wildloop native trail map (Explore)', () => {
  beforeAll(compileNativeBundle, 30000)

  it('pins trails with markers and keeps its controls on screen with :show', () => {
    expect(SOURCE).toContain('<MapMarker :for="marker in markers()"')
    expect(SOURCE).not.toMatch(/\s:if=/)
  })

  it('asks for trails as the signed-in viewer and says how many it pinned', async () => {
    const screen = await start('Explore')
    const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/trails?limit=80&offset=0')
    expect(request.payload.args[0].headers.authorization).toBe('Bearer native-token')
    answer(screen, request, ok(TRAILS))
    await waitForText(screen, '2 trails on the map')
    // No pin chosen yet, so no card.
    expect(visibility(screen, 'explore-card')).toBe('none')
  })
})
