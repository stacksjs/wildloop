import { describe, expect, it } from 'bun:test'
import { detectAnomalies, trackFingerprint } from '../../resources/functions/activity-anomaly'
import { checkAgainstHistory } from '../../resources/functions/activity-history'
import { evaluateTrackIntegrity, withoutFixes } from '../../resources/functions/activity-integrity'
import {
  activityKind,
  maxSustainableSpeed,
  worstSustainedWindow,
} from '../../resources/functions/activity-physics'

/**
 * Anti-cheat has two jobs and they pull against each other: refusing what a
 * body cannot do, and not refusing what an unusual athlete can. The second is
 * the one that matters more, because the honest athlete wrongly refused is
 * real, is angry, and is right — so the legitimate cases are tested as hard as
 * the fraudulent ones.
 */

const START = Date.parse('2026-03-01T08:00:00Z')

interface SampleOptions {
  /** Metres per second. */
  speed?: number
  count?: number
  /** Seconds between samples. */
  interval?: number
  accuracy?: number | null
  /** Vary accuracy and pacing the way a receiver does. */
  jitter?: boolean
  altitude?: number | null
  bearingDrift?: boolean
}

/**
 * A track built to look like a recording: irregular sampling, drifting
 * accuracy, a pace that wanders. Every fabricated case below starts from this
 * and breaks one thing, so a failure names the thing that was broken.
 */
function track(options: SampleOptions = {}): string {
  const speed = options.speed ?? 3.2
  const count = options.count ?? 60
  const interval = options.interval ?? 1
  const jitter = options.jitter !== false

  const coordinates: number[][] = []
  const samples: Array<Record<string, unknown>> = []

  let lat = 34.02
  let lng = -118.47
  let time = START
  // A deterministic wobble, so a failure reproduces.
  let seed = 7
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }

  for (let i = 0; i < count; i++) {
    coordinates.push([lng, lat])
    samples.push({
      time,
      accuracy: options.accuracy === undefined
        ? (jitter ? 6 + random() * 6 : 8)
        : options.accuracy,
      altitude: options.altitude === undefined ? 40 + random() * 4 : options.altitude,
    })

    const step = interval * (jitter ? 0.9 + random() * 0.2 : 1)
    const pace = speed * (jitter ? 0.9 + random() * 0.2 : 1)
    const metres = pace * step
    // Curve the path, so a real track is not mistaken for a drawn one.
    const heading = options.bearingDrift === false ? 0 : Math.sin(i / 9) * 0.6
    lat += (metres * Math.cos(heading)) / 111320
    lng += (metres * Math.sin(heading)) / (111320 * Math.cos((lat * Math.PI) / 180))
    time += step * 1000
  }

  return JSON.stringify({
    type: 'LineString',
    coordinates,
    properties: { samples },
  })
}

/** A track made of sections, each at its own speed. Built, not patched. */
function sectioned(sections: Array<{ speed: number, seconds: number }>): string {
  const coordinates: number[][] = []
  const samples: Array<Record<string, unknown>> = []
  let lat = 34.02
  const lng = -118.47
  let time = START
  let seed = 11
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }

  for (const section of sections) {
    for (let i = 0; i < section.seconds; i++) {
      coordinates.push([lng, lat])
      samples.push({ time, accuracy: 6 + random() * 6, altitude: 40 + random() * 4 })
      lat += section.speed / 111320
      time += 1000
    }
  }

  return JSON.stringify({ type: 'LineString', coordinates, properties: { samples } })
}

function evaluate(gpxData: string, activityType = 'Run') {
  return evaluateTrackIntegrity({
    gpxData,
    source: 'web_gps',
    activityType,
    completedAt: new Date(START + 3_600_000).toISOString(),
    nowMs: START + 3_700_000,
  })
}

describe('sustained pace', () => {
  it('accepts a fast but human run', () => {
    // 4.5 m/s is a 3:42/km pace held for ten minutes. Quick, and real.
    const result = evaluate(track({ speed: 4.5, count: 600 }))
    expect(result.captureEligible).toBe(true)
    expect(result.status).toBe('verified')
  })

  it('accepts an elite marathon pace', () => {
    // The world record is about 5.7 m/s. Nobody legitimate should be refused
    // for running well.
    const result = evaluate(track({ speed: 5.7, count: 900 }))
    expect(result.captureEligible).toBe(true)
  })

  it('refuses a car held under the old per-sample cap', () => {
    // 11 m/s passed every check before: under the 12 m/s cap, monotonic,
    // accurate, plenty of samples. It is also 40 km/h for twenty minutes.
    const result = evaluate(track({ speed: 11, count: 1200 }))
    expect(result.captureEligible).toBe(false)
    expect(result.status).toBe('rejected')
    expect(result.reason).toContain('faster than a run sustains')
  })

  it('refuses a car ride hidden inside a longer activity', () => {
    // A whole-activity average would not notice this: ten minutes at 11 m/s
    // between two half-hours of running averages out to an ordinary run, and
    // 11 m/s is under every per-sample cap.
    const result = evaluate(sectioned([
      { speed: 3, seconds: 1800 },
      { speed: 11, seconds: 600 },
      { speed: 3, seconds: 1800 },
    ]))

    expect(result.captureEligible).toBe(false)
    expect(result.reason).toContain('sustains')
  })

  it('holds cyclists to a cyclist curve', () => {
    // 10 m/s is 36 km/h — an ordinary club ride, and nothing a runner does.
    expect(evaluate(track({ speed: 10, count: 900 }), 'Bike').captureEligible).toBe(true)
    expect(evaluate(track({ speed: 10, count: 900 }), 'Run').captureEligible).toBe(false)
  })

  it('allows a short burst that no average could sustain', () => {
    // Ten seconds at 9 m/s inside an ordinary run: faster than any sustained
    // limit, and something people actually do at the end of a session.
    const result = evaluate(sectioned([
      { speed: 3.2, seconds: 600 },
      { speed: 9, seconds: 10 },
      { speed: 3.2, seconds: 600 },
    ]))
    expect(result.captureEligible).toBe(true)
  })
})

describe('maxSustainableSpeed', () => {
  it('falls as the effort gets longer', () => {
    const sprint = maxSustainableSpeed('run', 30)
    const hour = maxSustainableSpeed('run', 3600)
    const day = maxSustainableSpeed('run', 86400)
    expect(sprint).toBeGreaterThan(hour)
    expect(hour).toBeGreaterThan(day)
  })

  it('sits above every world record it is anchored to', () => {
    // A limit below a real performance would refuse the athlete who set it.
    expect(maxSustainableSpeed('run', 7300)).toBeGreaterThan(5.9)
    expect(maxSustainableSpeed('bike', 3600)).toBeGreaterThan(16.5)
    expect(maxSustainableSpeed('walk', 7200)).toBeGreaterThan(3.9)
  })

  it('reads the activity type the way athletes write it', () => {
    expect(activityKind('Trail Run')).toBe('run')
    expect(activityKind('Gravel Ride')).toBe('bike')
    expect(activityKind('Mountain Biking')).toBe('bike')
    expect(activityKind('Evening Walk')).toBe('walk')
    expect(activityKind('Kayaking')).toBe('other')
  })
})

describe('worstSustainedWindow', () => {
  it('finds the fast stretch rather than the average', () => {
    const slow = Array.from({ length: 60 }, () => ({ distance: 3, seconds: 1, speed: 3, climb: null }))
    const fast = Array.from({ length: 60 }, () => ({ distance: 20, seconds: 1, speed: 20, climb: null }))
    const worst = worstSustainedWindow([...slow, ...fast, ...slow], 30)

    expect(worst).not.toBeNull()
    expect(worst!.speed).toBeGreaterThan(15)
  })

  it('ignores windows shorter than asked for', () => {
    const segments = Array.from({ length: 5 }, () => ({ distance: 50, seconds: 1, speed: 50, climb: null }))
    expect(worstSustainedWindow(segments, 300)).toBeNull()
  })
})

/** Shift every fix from `from` onward, which is a move that persists rather than a glitch. */
function shifted(raw: string, from: number, metresNorth: number): string {
  const parsed = JSON.parse(raw)
  for (let i = from; i < parsed.coordinates.length; i++)
    parsed.coordinates[i] = [parsed.coordinates[i][0], parsed.coordinates[i][1] + metresNorth / 111320]
  return JSON.stringify(parsed)
}

describe('physical impossibility', () => {
  it('refuses a jump the track never comes back from', () => {
    // Everything from fix 30 on is 500 m further: no error radius explains
    // it, and the track does not return, so it is not a glitch either.
    const result = evaluate(shifted(track({ speed: 3, count: 60 }), 30, 500))
    expect(result.status).toBe('rejected')
  })

  it('accepts a receiver re-locking a few tens of metres over', () => {
    // A persistent 60 m shift — a phone leaving an urban canyon — is reachable
    // in the seconds around it once each fix's own error is allowed for.
    // Cars are caught by sustained pace, not by one step.
    const result = evaluate(shifted(track({ speed: 3, count: 200 }), 100, 60))
    expect(result.status).not.toBe('rejected')
  })

  it('refuses a climb no trail affords', () => {
    const parsed = JSON.parse(track({ speed: 3, count: 60 }))
    // 360 m up in a second, and staying up there.
    for (let i = 31; i < parsed.properties.samples.length; i++)
      parsed.properties.samples[i].altitude = 400
    const result = evaluate(JSON.stringify(parsed))
    expect(result.status).toBe('rejected')
    expect(result.reason).toContain('altitude')
  })

  it('accepts a steep but real descent', () => {
    // Two and a half metres of drop per second is a very steep trail, and
    // legitimate — the limit is there for lifts and fabrication.
    const parsed = JSON.parse(track({ speed: 2.5, count: 400 }))
    parsed.properties.samples.forEach((sample: any, index: number) => {
      sample.altitude = 1200 - index * 2.5
    })
    expect(evaluate(JSON.stringify(parsed)).captureEligible).toBe(true)
  })
})

/*
 * Real receivers, real runs.
 *
 * Every fix is a guess with a radius. These are the ways honest tracks used to
 * be refused outright — and lost from the athlete's log, since a refused track
 * is a 422 — because the checks compared raw positions as if they were exact.
 */
describe('a real receiver', () => {
  /** A jog where each fix lands somewhere inside its own reported radius. */
  function noisy(count: number, accuracy: number, seed = 3): string {
    const parsed = JSON.parse(track({ speed: 3, count, accuracy }))
    let state = seed
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 4294967296 - 0.5
    }
    parsed.coordinates = parsed.coordinates.map(([lng, lat]: number[]) => [
      lng + (random() * 2 * accuracy) / (111320 * Math.cos((lat * Math.PI) / 180)),
      lat + (random() * 2 * accuracy) / 111320,
    ])
    parsed.properties.samples.forEach((sample: any) => {
      sample.altitude = 40 + random() * 2 * accuracy * 1.5
    })
    return JSON.stringify(parsed)
  }

  it('scores a jog under trees, where every fix is fifteen metres out', () => {
    const result = evaluate(noisy(300, 15))
    expect(result.status).not.toBe('rejected')
    expect(result.captureEligible).toBe(true)
  })

  it('drops one fix thrown off by a cliff, and keeps the run', () => {
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    // Reflected signal: one fix 400 m east, confident about it, then back.
    parsed.coordinates[60] = [parsed.coordinates[60][0] + 400 / 92000, parsed.coordinates[60][1]]
    const result = evaluate(JSON.stringify(parsed))

    expect(result.status).toBe('verified')
    expect(result.captureEligible).toBe(true)
    expect(result.droppedFixes).toEqual([60])
    expect(result.samples).toHaveLength(199)
  })

  it('drops a short excursion of several fixes', () => {
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    for (const i of [70, 71, 72])
      parsed.coordinates[i] = [parsed.coordinates[i][0], parsed.coordinates[i][1] + 250 / 111320]
    const result = evaluate(JSON.stringify(parsed))
    expect(result.captureEligible).toBe(true)
    expect(result.droppedFixes).toEqual([70, 71, 72])
  })

  it('drops a first fix from before the receiver settled', () => {
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    parsed.coordinates[0] = [parsed.coordinates[0][0], parsed.coordinates[0][1] - 900 / 111320]
    const result = evaluate(JSON.stringify(parsed))
    expect(result.captureEligible).toBe(true)
    expect(result.droppedFixes).toEqual([0])
  })

  it('drops the last fixes, gone wrong as the phone went into a pocket', () => {
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    parsed.coordinates[199] = [parsed.coordinates[199][0], parsed.coordinates[199][1] + 700 / 111320]
    const result = evaluate(JSON.stringify(parsed))
    expect(result.captureEligible).toBe(true)
    expect(result.droppedFixes).toEqual([199])
  })

  it('drops an altitude blip without refusing the run', () => {
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    parsed.properties.samples[50].altitude = 420
    const result = evaluate(JSON.stringify(parsed))
    expect(result.captureEligible).toBe(true)
    expect(result.droppedFixes).toEqual([50])
  })

  it('merges a fix delivered twice', () => {
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    parsed.coordinates.splice(40, 0, parsed.coordinates[40])
    parsed.properties.samples.splice(40, 0, { ...parsed.properties.samples[40] })
    const result = evaluate(JSON.stringify(parsed))
    expect(result.captureEligible).toBe(true)
    expect(result.droppedFixes).toEqual([41])
  })

  it('still refuses two places at the same moment', () => {
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    parsed.coordinates.splice(40, 0, [parsed.coordinates[40][0], parsed.coordinates[40][1] + 500 / 111320])
    parsed.properties.samples.splice(40, 0, { ...parsed.properties.samples[40] })
    expect(evaluate(JSON.stringify(parsed)).status).toBe('rejected')
  })

  it('keeps a run with too many glitches in the log, out of the game', () => {
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    // Every eighth fix thrown off: 25 of 200.
    for (let i = 4; i < 200; i += 8)
      parsed.coordinates[i] = [parsed.coordinates[i][0], parsed.coordinates[i][1] + 300 / 111320]
    const result = evaluate(JSON.stringify(parsed))
    expect(result.valid).toBe(true)
    expect(result.captureEligible).toBe(false)
    expect(result.reason).toContain('unsteady')
  })

  it('still refuses a car hidden as a stream of glitches', () => {
    // A glitch has to come back. Driving off does not.
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    for (let i = 100; i < 200; i++)
      parsed.coordinates[i] = [parsed.coordinates[i][0], parsed.coordinates[i][1] + (i - 99) * 30 / 111320]
    expect(evaluate(JSON.stringify(parsed)).status).toBe('rejected')
  })
})

describe('the stored track', () => {
  it('leaves the dropped fixes out, in the shape it came in', () => {
    const raw = JSON.stringify({
      type: 'LineString',
      coordinates: [[0, 0], [1, 1], [2, 2], [3, 3]],
      properties: { samples: [{ t: 0 }, { t: 1 }, { t: 2 }, { t: 3 }], source: 'web_gps' },
    })
    const stored = JSON.parse(withoutFixes(raw, [1, 3]))
    expect(stored.coordinates).toEqual([[0, 0], [2, 2]])
    expect(stored.properties.samples).toEqual([{ t: 0 }, { t: 2 }])
    expect(stored.properties.source).toBe('web_gps')
  })

  it('is the submitted track when nothing was dropped', () => {
    const raw = track({ count: 30 })
    expect(withoutFixes(raw, [])).toBe(raw)
  })

  it('never lets a "glitch" spike reach the territory line', () => {
    // The obvious way to abuse dropping glitches: a confident fix far out to
    // pull a loop around more ground. It is dropped from the stored track,
    // which is all the territory engine reads.
    const parsed = JSON.parse(track({ speed: 3, count: 200 }))
    const spike = [parsed.coordinates[60][0] + 0.01, parsed.coordinates[60][1]]
    parsed.coordinates[60] = spike
    const raw = JSON.stringify(parsed)
    const stored = JSON.parse(withoutFixes(raw, evaluate(raw).droppedFixes))
    expect(stored.coordinates).not.toContainEqual(spike)
    expect(stored.coordinates).toHaveLength(199)
  })
})

describe('anomaly signals', () => {
  it('leaves an ordinary recording unremarkable', () => {
    const result = evaluate(track({ count: 200 }))
    expect(result.anomalyScore).toBeLessThan(0.3)
  })

  it('notices a track that never varies', () => {
    // Perfectly even sampling, constant pace, one accuracy value: the marks of
    // a loop that generated it rather than a receiver that recorded it.
    const result = evaluate(track({ count: 200, jitter: false, accuracy: 5, altitude: 100 }))

    expect(result.anomalyScore).toBeGreaterThan(0.5)
    const codes = result.anomalySignals.map(signal => signal.code)
    expect(codes).toContain('uniform_sample_interval')
    expect(codes).toContain('constant_accuracy')
  })

  it('does not refuse a track merely for looking synthetic', () => {
    // The whole point of the distinction: statistics flag, physics refuses.
    const result = evaluate(track({ count: 200, jitter: false, accuracy: 5 }))
    expect(result.captureEligible).toBe(true)
    expect(result.status).toBe('verified')
  })

  it('notices a route drawn between waypoints', () => {
    const report = detectAnomalies({
      samples: Array.from({ length: 60 }, (_, i) => ({
        lat: 34.02 + i * 0.0002,
        lng: -118.47,
        time: START + i * 1000,
        accuracy: 5 + (i % 7),
        altitude: 40,
      })),
      speeds: Array.from({ length: 59 }, () => 3 + Math.random() * 0.5),
      intervals: Array.from({ length: 59 }, () => 1 + Math.random() * 0.2),
    })
    expect(report.signals.map(s => s.code)).toContain('unnaturally_straight')
  })

  it('notices a track with no accuracy at all', () => {
    const result = evaluate(track({ count: 60, accuracy: null }))
    expect(result.anomalySignals.map(s => s.code)).toContain('no_accuracy_reported')
  })
})

describe('track fingerprints', () => {
  it('matches the same trace submitted twice', () => {
    const samples = [
      { lat: 34.02, lng: -118.47 },
      { lat: 34.021, lng: -118.471 },
      { lat: 34.022, lng: -118.472 },
    ]
    expect(trackFingerprint(samples)).toBe(trackFingerprint([...samples]))
  })

  it('does not match two genuine runs of the same route', () => {
    // No two traces agree to five decimal places at every sample.
    const a = [
      { lat: 34.020001, lng: -118.470001 },
      { lat: 34.021002, lng: -118.471003 },
      { lat: 34.022001, lng: -118.472002 },
    ]
    const b = [
      { lat: 34.020009, lng: -118.470012 },
      { lat: 34.021021, lng: -118.471033 },
      { lat: 34.022014, lng: -118.472025 },
    ]
    expect(trackFingerprint(a)).not.toBe(trackFingerprint(b))
  })

  it('survives re-encoding at a different precision', () => {
    const a = [{ lat: 34.02, lng: -118.47 }, { lat: 34.021, lng: -118.471 }]
    const b = [{ lat: 34.0200000001, lng: -118.4700000001 }, { lat: 34.0210000002, lng: -118.4710000004 }]
    expect(trackFingerprint(a)).toBe(trackFingerprint(b))
  })

  it('has nothing to fingerprint in a one-point track', () => {
    expect(trackFingerprint([{ lat: 1, lng: 2 }])).toBeNull()
  })
})

describe('checks against history', () => {
  const candidate = {
    startedAt: Date.parse('2026-03-01T08:00:00Z'),
    completedAt: Date.parse('2026-03-01T09:00:00Z'),
    startLat: 34.02,
    startLng: -118.47,
    endLat: 34.03,
    endLng: -118.46,
    fingerprint: 'abc',
  }

  function neighbour(overrides: Partial<Parameters<typeof checkAgainstHistory>[1][number]> = {}) {
    return {
      id: 99,
      startedAt: Date.parse('2026-03-01T12:00:00Z'),
      completedAt: Date.parse('2026-03-01T13:00:00Z'),
      startLat: 34.02,
      startLng: -118.47,
      endLat: 34.03,
      endLng: -118.46,
      fingerprint: 'xyz',
      captureEligible: true,
      ...overrides,
    }
  }

  it('passes an ordinary second run later the same day', () => {
    expect(checkAgainstHistory(candidate, [neighbour()])).toEqual([])
  })

  it('catches the same trace submitted twice', () => {
    const findings = checkAgainstHistory(candidate, [neighbour({ fingerprint: 'abc' })])
    expect(findings[0].code).toBe('duplicate_track')
    expect(findings[0].disqualifying).toBe(true)
  })

  it('catches being in two places at once', () => {
    const findings = checkAgainstHistory(candidate, [neighbour({
      startedAt: Date.parse('2026-03-01T08:30:00Z'),
      completedAt: Date.parse('2026-03-01T09:30:00Z'),
    })])
    expect(findings[0].code).toBe('overlapping_activity')
    expect(findings[0].disqualifying).toBe(true)
  })

  it('treats an overlap with a non-scoring activity as forgivable', () => {
    // A watch and a phone recording the same outing overlap honestly. Only one
    // can score, and if the other never did there is nothing to refuse.
    const findings = checkAgainstHistory(candidate, [neighbour({
      startedAt: Date.parse('2026-03-01T08:30:00Z'),
      completedAt: Date.parse('2026-03-01T09:30:00Z'),
      captureEligible: false,
    })])
    expect(findings[0].code).toBe('overlapping_activity')
    expect(findings[0].disqualifying).toBe(false)
  })

  it('flags a journey nobody could have made', () => {
    // Los Angeles to Tokyo in the eleven minutes between two activities.
    const findings = checkAgainstHistory(candidate, [neighbour({
      startedAt: Date.parse('2026-03-01T09:11:00Z'),
      completedAt: Date.parse('2026-03-01T10:00:00Z'),
      startLat: 35.68,
      startLng: 139.69,
      endLat: 35.69,
      endLng: 139.70,
    })])
    expect(findings[0].code).toBe('impossible_transit')
    // Flagged rather than refused: a wrong clock is more likely than a fraud,
    // and a person can tell the difference where a rule cannot.
    expect(findings[0].disqualifying).toBe(false)
  })

  it('allows a flight between two runs', () => {
    // Eleven hours is enough to get from Los Angeles to Tokyo.
    const findings = checkAgainstHistory(candidate, [neighbour({
      startedAt: Date.parse('2026-03-01T20:00:00Z'),
      completedAt: Date.parse('2026-03-01T21:00:00Z'),
      startLat: 35.68,
      startLng: 139.69,
      endLat: 35.69,
      endLng: 139.70,
    })])
    expect(findings).toEqual([])
  })

  it('needs the neighbour\'s duration to see an overlap', () => {
    // Regression: activities store a display duration ("45:00"), not seconds.
    // Reading a column that does not exist left every neighbour looking
    // instantaneous — its window collapsed to a point and the overlap check
    // could never fire, silently.
    const completed = Date.parse('2026-03-01T09:00:00Z')

    const collapsed = checkAgainstHistory(candidate, [neighbour({
      startedAt: completed,
      completedAt: completed,
    })])
    expect(collapsed).toEqual([])

    const withDuration = checkAgainstHistory(candidate, [neighbour({
      startedAt: completed - 45 * 60 * 1000,
      completedAt: completed,
    })])
    expect(withDuration[0].code).toBe('overlapping_activity')
  })

  it('says nothing when there is nothing to compare', () => {
    expect(checkAgainstHistory(candidate, [])).toEqual([])
    expect(checkAgainstHistory({ ...candidate, startedAt: null, completedAt: null }, [neighbour()])).toEqual([])
  })
})
