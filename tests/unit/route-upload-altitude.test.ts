import { describe, expect, it } from 'bun:test'
import { routeToGeoJson } from '../../resources/assets/scripts/game-api'
import { evaluateTrackIntegrity, parseTrackSamples } from '../../resources/functions/activity-integrity'

/**
 * The recorder keeps altitude in feet; the server reads the upload in metres.
 *
 * The envelope used to carry the feet unconverted, so the server's 6 m/s
 * vertical-speed limit became 6 ft/s, and a phone's ordinary altitude wobble
 * between two fixes refused a whole run as "an implausible change of
 * altitude".
 */
describe('recorder upload altitude', () => {
  it('sends metres, not the feet the recorder displays', () => {
    const raw = routeToGeoJson([[34.05, -118.25]], [{ t: 1, accuracy: 5, eleFt: 328.084 }])
    const [sample] = parseTrackSamples(raw)
    expect(sample.altitude).toBeCloseTo(100, 6)
  })

  it('keeps a missing altitude missing', () => {
    const raw = routeToGeoJson([[34.05, -118.25]], [{ t: 1, accuracy: 5, eleFt: null }])
    expect(parseTrackSamples(raw)[0].altitude).toBeNull()
  })

  it('does not refuse a run over a 4 m altitude wobble between one-second fixes', () => {
    const start = Date.parse('2026-10-03T12:00:00Z')
    const points: Array<[number, number]> = []
    const samples: Array<{ t: number, accuracy: number, eleFt: number }> = []
    for (let i = 0; i < 180; i++) {
      // About 3 m/s north, with the altitude jumping 4 m every other fix.
      points.push([34.05 + i * 0.000027, -118.25])
      samples.push({ t: start + i * 1000, accuracy: 6 + (i % 5), eleFt: (100 + (i % 2) * 4) * 3.28084 })
    }
    const result = evaluateTrackIntegrity({
      gpxData: routeToGeoJson(points, samples),
      source: 'web_gps',
      activityType: 'Trail Run',
      completedAt: new Date(start + 179_000).toISOString(),
      nowMs: start + 180_000,
    })
    expect(result.reason).toBeNull()
    expect(result.valid).toBe(true)
  })
})
