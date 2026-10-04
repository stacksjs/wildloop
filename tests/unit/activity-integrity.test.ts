import { describe, expect, it } from 'bun:test'
import { evaluateTrackIntegrity } from '../../resources/functions/activity-integrity'

function track(options: { points?: number, secondsApart?: number, accuracy?: number | null } = {}): string {
  const points = options.points ?? 24
  const secondsApart = options.secondsApart ?? 10
  const accuracy = options.accuracy === undefined ? 8 : options.accuracy
  const startedAt = Date.UTC(2026, 7, 12, 12, 0, 0)
  const coordinates: number[][] = []
  const samples: Array<{ time: number, accuracy: number | null }> = []
  for (let index = 0; index < points; index++) {
    coordinates.push([-122.42 + index * 0.0001, 37.77])
    samples.push({ time: startedAt + index * secondsApart * 1000, accuracy })
  }
  return JSON.stringify({ type: 'LineString', coordinates, properties: { samples } })
}

/**
 * A track that goes somewhere and then stops dead, the shape of an aid station
 * on a long run: `moving` fixes of real travel, then `resting` fixes that only
 * wander inside the receiver's own noise.
 */
function trackWithRest(moving: number, resting: number, jitterDegrees = 0.00004): string {
  const startedAt = Date.UTC(2026, 7, 12, 12, 0, 0)
  const coordinates: number[][] = []
  const samples: Array<{ time: number, accuracy: number | null }> = []
  // 0.000034 degrees of longitude at this latitude is about three metres, so
  // one fix a second is a solid running pace rather than a speed the burst
  // check would refuse outright.
  const stride = 0.000034
  for (let i = 0; i < moving; i++) {
    coordinates.push([-122.42 + i * stride, 37.77])
    samples.push({ time: startedAt + i * 1000, accuracy: 5 })
  }
  const restLng = -122.42 + (moving - 1) * stride
  for (let i = 0; i < resting; i++) {
    // A slow wander of a couple of metres, the way a receiver actually drifts.
    // Jumping the full amplitude between consecutive fixes would be 30 mph and
    // the burst check would rightly refuse the whole track.
    coordinates.push([
      restLng + Math.sin(i / 9) * jitterDegrees,
      37.77 + Math.cos(i / 11) * jitterDegrees,
    ])
    samples.push({ time: startedAt + (moving + i) * 1000, accuracy: 5 })
  }
  return JSON.stringify({ type: 'LineString', coordinates, properties: { samples } })
}

describe('the distance an activity is saved with', () => {
  /*
   * The bug this pins.
   *
   * The stored distance is whatever this function reports — the store action
   * overrides the phone's own number with it for live GPS. It used to sum the
   * gap between every consecutive fix, which charges the athlete for the
   * receiver's wander while they stand still: one to nine phantom miles for
   * every hour stopped, so a fifty-mile ultra with three quarters of an hour
   * of aid stations came back three to seven miles long.
   */
  it('does not grow while the athlete is standing still', () => {
    const evaluate = (gpxData: string) => evaluateTrackIntegrity({
      gpxData,
      source: 'web_gps',
      activityType: 'Trail Run',
      completedAt: new Date(Date.UTC(2026, 7, 12, 12, 30, 0)).toISOString(),
      nowMs: Date.UTC(2026, 7, 12, 12, 30, 0),
    })

    const moving = evaluate(trackWithRest(600, 0)).distanceMiles!
    const thenResting = evaluate(trackWithRest(600, 600)).distanceMiles!

    expect(moving).toBeGreaterThan(0.9)
    // Ten minutes of standing, at one fix a second, costs about ten metres of
    // settling and then nothing. The rule it replaced charged one to nine
    // miles for the same hour.
    expect(thenResting - moving).toBeLessThan(0.01)
    expect(thenResting).toBeGreaterThanOrEqual(moving)
  })

  it('still measures the travel either side of a rest', () => {
    // The guard must not be so eager that a real run stops counting.
    const result = evaluateTrackIntegrity({
      gpxData: trackWithRest(600, 300),
      source: 'web_gps',
      activityType: 'Trail Run',
      completedAt: new Date(Date.UTC(2026, 7, 12, 12, 30, 0)).toISOString(),
      nowMs: Date.UTC(2026, 7, 12, 12, 30, 0),
    })

    // 599 strides of about three metres is roughly 1.1 miles. Anchoring
    // quantises that into fewer, longer steps; it must not halve it.
    expect(result.distanceMiles).toBeGreaterThan(0.9)
  })
})

describe('activity integrity', () => {
  it('derives metrics and verifies a recent device-quality GPS track', () => {
    const completedAt = new Date(Date.UTC(2026, 7, 12, 12, 4, 0)).toISOString()
    const result = evaluateTrackIntegrity({
      gpxData: track(),
      source: 'web_gps',
      activityType: 'Trail Run',
      completedAt,
      nowMs: Date.parse(completedAt),
    })

    expect(result.valid).toBe(true)
    expect(result.captureEligible).toBe(true)
    expect(result.status).toBe('verified')
    expect(result.distanceMiles).toBeGreaterThan(0.1)
    expect(result.durationSeconds).toBe(230)
  })

  it('applies the same integrity rules to native Craft GPS tracks', () => {
    const completedAt = new Date(Date.UTC(2026, 7, 12, 12, 4, 0)).toISOString()
    const result = evaluateTrackIntegrity({
      gpxData: track(),
      source: 'native_gps',
      activityType: 'Trail Run',
      completedAt,
      nowMs: Date.parse(completedAt),
    })

    expect(result.valid).toBe(true)
    expect(result.captureEligible).toBe(true)
    expect(result.status).toBe('verified')
  })

  it('saves a simulation as non-scoring even with complete telemetry', () => {
    const result = evaluateTrackIntegrity({
      gpxData: track(),
      source: 'simulation',
      activityType: 'Trail Run',
    })
    expect(result.valid).toBe(true)
    expect(result.captureEligible).toBe(false)
    expect(result.status).toBe('unverified')
  })

  it('refuses a timestamped teleport', () => {
    // From fix 10 on the track is in Colorado: a move that persists, not a
    // glitch the receiver recovered from.
    const raw = JSON.parse(track())
    for (let i = 10; i < raw.coordinates.length; i++)
      raw.coordinates[i] = [-100 + i * 0.0001, 40]
    const result = evaluateTrackIntegrity({
      gpxData: JSON.stringify(raw),
      source: 'web_gps',
      activityType: 'Trail Run',
    })
    // Refused for play, kept for the log: see activity-store-decision.test.ts.
    expect(result.valid).toBe(true)
    expect(result.captureEligible).toBe(false)
    expect(result.status).toBe('rejected')
  })

  it('keeps low-quality GPS in the log but out of territory play', () => {
    const result = evaluateTrackIntegrity({
      gpxData: track({ accuracy: null }),
      source: 'web_gps',
      activityType: 'Walk',
      completedAt: new Date().toISOString(),
    })
    expect(result.valid).toBe(true)
    expect(result.captureEligible).toBe(false)
    expect(result.reason).toContain('accuracy')
  })

  it('never makes manual activities capture eligible', () => {
    const result = evaluateTrackIntegrity({ source: 'manual', activityType: 'Hike' })
    expect(result.valid).toBe(true)
    expect(result.captureEligible).toBe(false)
  })
})
