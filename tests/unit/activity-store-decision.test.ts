import { describe, expect, it } from 'bun:test'
import { evaluateTrackIntegrity, integrityColumns, storeRefusal } from '../../resources/functions/activity-integrity'

/**
 * What `POST /api/activities` does with a track, decided before it touches the
 * database.
 *
 * Two kinds of "no" used to share one answer, a 422, and the athlete lost the
 * run from their log either way. They are different now. A payload that is
 * not a track at all is still refused. A track that is a recording of
 * something no body does on its own — a car's speed, a lift's climb, a clock
 * running backwards — is saved, marked `rejected`, and never captures or
 * competes.
 */

const NOW = Date.UTC(2026, 7, 12, 12, 30, 0)
const START = NOW - 20 * 60 * 1000

/** One fix every `seconds`, `metres` apart, heading east. */
function track(options: { fixes?: number, metres?: number, seconds?: number, times?: (index: number) => number } = {}): string {
  const fixes = options.fixes ?? 120
  const metres = options.metres ?? 3
  const seconds = options.seconds ?? 1
  // A degree of longitude at 37.77° is about 88 km.
  const step = metres / 88_000
  const coordinates: number[][] = []
  const samples: Array<{ time: number, accuracy: number }> = []
  for (let index = 0; index < fixes; index++) {
    coordinates.push([-122.42 + index * step, 37.77])
    samples.push({ time: options.times ? options.times(index) : START + index * seconds * 1000, accuracy: 5 })
  }
  return JSON.stringify({ type: 'LineString', coordinates, properties: { samples } })
}

function evaluate(gpxData: string | null, activityType = 'Trail Run') {
  return evaluateTrackIntegrity({
    gpxData,
    source: 'web_gps',
    activityType,
    completedAt: new Date(NOW).toISOString(),
    nowMs: NOW,
  })
}

const noHistory = { captureEligible: true, reason: null }

describe('a payload that is not a track', () => {
  it('is refused: not JSON', () => {
    expect(storeRefusal(evaluate('not json'))).toMatch(/at least two valid telemetry samples/)
  })

  it('is refused: no coordinates, or only one', () => {
    expect(storeRefusal(evaluate('[]'))).toMatch(/at least two/)
    expect(storeRefusal(evaluate(JSON.stringify({ type: 'LineString', coordinates: [[-122.42, 37.77]] })))).toMatch(/at least two/)
  })

  it('is refused: coordinates off the globe, or not numbers', () => {
    expect(storeRefusal(evaluate(JSON.stringify([{ lat: 37.77, lng: -122.42 }, { lat: 137.77, lng: -122.42 }])))).toMatch(/invalid coordinate/)
    expect(storeRefusal(evaluate(JSON.stringify([{ lat: 37.77, lng: -122.42 }, { lat: 'north', lng: -122.42 }])))).toMatch(/invalid coordinate/)
  })
})

describe('a track refused on physics', () => {
  it('is saved: an impossible speed', () => {
    // 30 m/s for two minutes: a car, not a runner.
    const integrity = evaluate(track({ metres: 30 }))

    expect(storeRefusal(integrity)).toBeNull()
    expect(integrity.status).toBe('rejected')
    expect(integrity.reason).toMatch(/implausible trail run speed/)
  })

  it('is saved non-scoring, with the reason, whatever the history says', () => {
    const integrity = evaluate(track({ metres: 30 }))

    expect(integrityColumns(integrity, noHistory)).toEqual({
      capture_eligible: false,
      integrity_status: 'rejected',
      integrity_reason: 'Track contains an implausible trail run speed',
    })
  })

  it('is measured from its own fixes, as other live GPS is', () => {
    const integrity = evaluate(track({ metres: 30, fixes: 121 }))

    // 120 steps of 30 m is 3.6 km, about 2.2 miles, over two minutes.
    expect(integrity.distanceMiles).toBeGreaterThan(2)
    expect(integrity.distanceMiles).toBeLessThan(2.5)
    expect(integrity.durationSeconds).toBe(120)
  })

  it('is saved: a clock running backwards, without a negative duration', () => {
    const integrity = evaluate(track({ times: index => START + (index === 60 ? -5_000 : index * 1000) }))

    expect(storeRefusal(integrity)).toBeNull()
    expect(integrity.status).toBe('rejected')
    expect(integrity.reason).toMatch(/monotonically/)
    expect(integrity.durationSeconds).toBeGreaterThan(0)
  })

  it('is saved: an impossible climb', () => {
    const raw = JSON.parse(track())
    raw.properties.samples = raw.properties.samples.map((sample: any, index: number) => ({ ...sample, altitude: index * 40 }))
    const integrity = evaluate(JSON.stringify(raw))

    expect(storeRefusal(integrity)).toBeNull()
    expect(integrity.status).toBe('rejected')
    expect(integrity.reason).toMatch(/altitude/)
  })

  it('never carries a fingerprint, so it cannot make another track a duplicate', () => {
    expect(evaluate(track({ metres: 30 })).fingerprint).toBeNull()
  })
})

describe('what the athlete\'s history adds', () => {
  const honest = () => evaluate(track({ fixes: 600 }))

  it('leaves an honest run verified and eligible', () => {
    expect(storeRefusal(honest())).toBeNull()
    expect(integrityColumns(honest(), noHistory)).toEqual({
      capture_eligible: true,
      integrity_status: 'verified',
      integrity_reason: null,
    })
  })

  it('rejects the same run counted twice: a duplicate trace or two places at once', () => {
    expect(integrityColumns(honest(), { captureEligible: false, reason: 'identical GPS trace to activity 7' })).toEqual({
      capture_eligible: false,
      integrity_status: 'rejected',
      integrity_reason: 'identical GPS trace to activity 7',
    })
  })

  it('keeps a free run verified but not eligible: it never asked to capture', () => {
    expect(integrityColumns(honest(), { captureEligible: false, reason: null })).toEqual({
      capture_eligible: false,
      integrity_status: 'verified',
      integrity_reason: null,
    })
  })
})
