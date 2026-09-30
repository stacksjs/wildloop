import { describe, expect, it } from 'bun:test'
import { elevationProfile, PROFILE_POINTS } from '../../resources/functions/elevation-profile'

/**
 * The line an activity page draws of altitude against distance.
 *
 * The cases that matter are the ones where a chart still renders and quietly
 * misleads: a profile that stops short of the summit, one plotted against
 * sample number so a rest stretches the axis, or one lagging to the right of
 * the hill it describes.
 */

const METRES_PER_DEGREE_LAT = 111_320

/** A track heading north, `metresApart` between fixes, at the given altitudes (metres). */
function track(altitudesM: Array<number | null>, metresApart = 20) {
  return altitudesM.map((altitude, i) => ({
    lat: 37.77 + (i * metresApart) / METRES_PER_DEGREE_LAT,
    lng: -122.42,
    altitude,
  }))
}

describe('elevationProfile', () => {
  it('draws nothing when there is no altitude to draw', () => {
    // A manual entry, or a device that never reported altitude. A flat line
    // says less than no chart at all.
    expect(elevationProfile(track([null, null, null, null]))).toBeNull()
    expect(elevationProfile([])).toBeNull()
  })

  it('draws nothing from a single fix', () => {
    expect(elevationProfile(track([100]))).toBeNull()
  })

  it('follows a climb', () => {
    const profile = elevationProfile(track(Array.from({ length: 300 }, (_, i) => 100 + i)))!
    expect(profile.points.length).toBeGreaterThan(2)
    expect(profile.points[0].ft).toBeLessThan(profile.points[profile.points.length - 1].ft)
    expect(profile.maxFt).toBeGreaterThan(profile.minFt)
  })

  /*
   * The end of the line is the summit, or the finish, and it is the point
   * people look at. Downsampling by a fixed stride drops it whenever the
   * sample count is not a multiple of the stride.
   */
  it('always keeps the last fix, whatever the stride', () => {
    // 1,001 samples against 200 points is a stride of 6, so the naive last
    // index taken would be 996 and the final five fixes would vanish.
    const climbing = Array.from({ length: 1001 }, (_, i) => 100 + i * 0.5)
    const profile = elevationProfile(track(climbing))!

    const last = profile.points[profile.points.length - 1]
    expect(last.mi).toBeCloseTo(profile.miles, 2)
    // The climb only rises, so the highest point is the final one — which is
    // exactly the point a fixed stride drops.
    expect(last.ft).toBe(profile.maxFt)
  })

  it('keeps the profile inside the point budget', () => {
    const profile = elevationProfile(track(Array.from({ length: 36_000 }, (_, i) => 100 + Math.sin(i / 900) * 200)))!
    // A ten-hour recording, downsampled. One over is the kept final fix.
    expect(profile.points.length).toBeLessThanOrEqual(PROFILE_POINTS + 1)
  })

  /*
   * Plotted against ground covered, not against fixes taken.
   *
   * Standing at an aid station produces hundreds of fixes in one place. On a
   * sample-number axis that rest becomes a wide flat band and the descent
   * either side is squashed into nothing.
   */
  it('plots against distance, so standing still takes no width', () => {
    const moving = Array.from({ length: 100 }, (_, i) => 100 + i)
    const resting = Array.from({ length: 400 }, () => 200)
    const samples = [
      ...track(moving),
      // Four hundred fixes that go nowhere: same position, same altitude.
      ...Array.from({ length: resting.length }, () => ({
        lat: 37.77 + (99 * 20) / METRES_PER_DEGREE_LAT,
        lng: -122.42,
        altitude: 200,
      })),
    ]

    const profile = elevationProfile(samples)!
    // The rest adds four fifths of the fixes and none of the miles.
    expect(profile.miles).toBeCloseTo(elevationProfile(track(moving))!.miles, 2)
  })

  it('starts at zero miles and never goes backwards', () => {
    const profile = elevationProfile(track(Array.from({ length: 200 }, (_, i) => 50 + (i % 40))))!
    expect(profile.points[0].mi).toBe(0)
    for (let i = 1; i < profile.points.length; i++)
      expect(profile.points[i].mi).toBeGreaterThanOrEqual(profile.points[i - 1].mi)
  })

  /*
   * Smoothed in both directions on purpose.
   *
   * A one-pass filter lags, which slides the whole profile to the right — the
   * chart then shows the climb starting after it did, against a distance axis
   * that is correct. Running the filter back over the result cancels it.
   */
  it('puts a hill where the hill actually is', () => {
    // Flat, a sharp peak in the middle, flat again.
    const flat = Array.from({ length: 200 }, () => 100)
    const up = Array.from({ length: 100 }, (_, i) => 100 + i * 3)
    const down = Array.from({ length: 100 }, (_, i) => 400 - i * 3)
    const profile = elevationProfile([...track([...flat, ...up, ...down, ...flat])])!

    const peak = profile.points.reduce((best, p) => (p.ft > best.ft ? p : best))
    const summitMi = profile.miles * (300 / 600)
    // Within a tenth of a mile of the true summit, not lagging behind it.
    expect(Math.abs(peak.mi - summitMi)).toBeLessThan(0.1)
  })

  it('ignores a fix with no position rather than drawing a jump to nowhere', () => {
    const samples = [
      { lat: 37.77, lng: -122.42, altitude: 100 },
      { lat: Number.NaN, lng: Number.NaN, altitude: 150 },
      { lat: 37.7705, lng: -122.42, altitude: 110 },
    ]
    const profile = elevationProfile(samples)!
    expect(profile.points).toHaveLength(2)
    expect(profile.miles).toBeLessThan(0.1)
  })

  /*
   * The axis and the page header have to agree.
   *
   * The activity's distance is measured from anchors rather than by summing
   * every fix, which is about 9% shorter over a long day. A profile that
   * summed instead would sit under a header saying 50 miles with its own axis
   * ending at 54.
   */
  it('measures its axis the same way the activity measures its distance', async () => {
    const { totalMiles } = await import('../../resources/functions/recording-distance')
    const samples = track(Array.from({ length: 900 }, (_, i) => 100 + i * 0.4), 12)

    const profile = elevationProfile(samples)!
    const official = totalMiles(samples.map(s => ({ lat: s.lat, lng: s.lng, accuracy: null })))

    expect(profile.miles).toBeCloseTo(official, 2)
  })

  it('reports the range the axis has to cover', () => {
    const profile = elevationProfile(track([100, 120, 90, 300, 110, 95]))!
    expect(profile.minFt).toBeLessThanOrEqual(profile.maxFt)
    for (const point of profile.points) {
      expect(point.ft).toBeGreaterThanOrEqual(profile.minFt)
      expect(point.ft).toBeLessThanOrEqual(profile.maxFt)
    }
  })
})
