import { describe, expect, it } from 'bun:test'
import { parseGpxActivity, parseTcxActivity } from '../../resources/functions/activity-files'

/**
 * Reading heart rate out of a file somebody exported from another watch.
 *
 * This is the cheapest of the three sources in #1010 and the one that helps
 * most: it needs no permission, no device support and no native work, and it
 * is the path for anybody bringing their history across from Strava or Garmin.
 *
 * The fixtures below are the real shapes. GPX puts the reading in a
 * namespaced extension on each point, TCX wraps it in an element that holds
 * another element, and both appear alongside fields that look similar enough
 * to grab by accident.
 */

function gpx(points: string): string {
  return `<?xml version="1.0"?>
<gpx version="1.1" creator="Garmin Connect"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><name>Morning Run</name><trkseg>
${points}
  </trkseg></trk>
</gpx>`
}

/** A GPX point as Garmin actually writes it. */
function gpxPoint(lat: number, lng: number, bpm: number | null): string {
  const hr = bpm === null
    ? ''
    : `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${bpm}</gpxtpx:hr><gpxtpx:cad>88</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions>`
  return `    <trkpt lat="${lat}" lon="${lng}"><ele>12</ele><time>2026-09-01T07:0${Math.round(lat % 6)}:00Z</time>${hr}</trkpt>`
}

function tcx(points: string): string {
  return `<?xml version="1.0"?>
<TrainingCenterDatabase><Activities><Activity Sport="Running">
  <Lap><Track>
${points}
  </Track></Lap>
</Activity></Activities></TrainingCenterDatabase>`
}

/**
 * A TCX point, including the trap: `Cadence` and the extension `Watts` are
 * also wrapped `<Value>` elements, and in real exports they sit beside the
 * heart rate in whichever order the device felt like.
 */
function tcxPoint(lat: number, lng: number, bpm: number | null): string {
  const hr = bpm === null ? '' : `<HeartRateBpm><Value>${bpm}</Value></HeartRateBpm>`
  return `    <Trackpoint>
      <Time>2026-09-01T07:0${Math.round(lat % 6)}:00Z</Time>
      <Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lng}</LongitudeDegrees></Position>
      <AltitudeMeters>12</AltitudeMeters>
      <Extensions><TPX><Watts><Value>240</Value></Watts></TPX></Extensions>
      ${hr}
    </Trackpoint>`
}

describe('heart rate out of a GPX file', () => {
  it('reads the namespaced extension Garmin writes', () => {
    const parsed = parseGpxActivity(gpx([
      gpxPoint(37.80, -122.40, 140),
      gpxPoint(37.81, -122.41, 150),
      gpxPoint(37.82, -122.42, 160),
    ].join('\n')))

    expect(parsed.heartRateAvg).toBe(150)
    expect(parsed.heartRateMax).toBe(160)
  })

  /*
   * Most GPX files have no heart rate at all — only a watch paired with a
   * strap or an optical sensor writes one. Null, never zero: zero is a
   * stopped heart, and it would average into every file that did have one.
   */
  it('reports null, not zero, for a file without any', () => {
    const parsed = parseGpxActivity(gpx([
      gpxPoint(37.80, -122.40, null),
      gpxPoint(37.81, -122.41, null),
    ].join('\n')))

    expect(parsed.heartRateAvg).toBeNull()
    expect(parsed.heartRateMax).toBeNull()
  })

  /*
   * A strap that loses contact mid-run reports 0 for a stretch and then
   * recovers, so the bad readings sit surrounded by good ones and have to be
   * dropped per fix. Averaging them in would drag a real 150 down to 100.
   */
  it('drops a dropout without dragging the average down', () => {
    const parsed = parseGpxActivity(gpx([
      gpxPoint(37.80, -122.40, 150),
      gpxPoint(37.81, -122.41, 0),
      gpxPoint(37.82, -122.42, 0),
      gpxPoint(37.83, -122.43, 150),
    ].join('\n')))

    expect(parsed.heartRateAvg).toBe(150)
    expect(parsed.heartRateMax).toBe(150)
  })

  it('averages only the fixes that carried a reading', () => {
    const parsed = parseGpxActivity(gpx([
      gpxPoint(37.80, -122.40, 100),
      gpxPoint(37.81, -122.41, null),
      gpxPoint(37.82, -122.42, null),
      gpxPoint(37.83, -122.43, 200),
    ].join('\n')))

    // 150, not 75 — the two silent fixes are absent, not zero.
    expect(parsed.heartRateAvg).toBe(150)
  })

  it('refuses a reading no heart produces', () => {
    const parsed = parseGpxActivity(gpx([
      gpxPoint(37.80, -122.40, 255),
      gpxPoint(37.81, -122.41, 145),
      gpxPoint(37.82, -122.42, 155),
    ].join('\n')))

    expect(parsed.heartRateMax).toBe(155)
  })
})

describe('heart rate out of a TCX file', () => {
  it('reads the value nested inside HeartRateBpm', () => {
    const parsed = parseTcxActivity(tcx([
      tcxPoint(37.80, -122.40, 130),
      tcxPoint(37.81, -122.41, 150),
    ].join('\n')))

    expect(parsed.heartRateAvg).toBe(140)
    expect(parsed.heartRateMax).toBe(150)
  })

  /*
   * The reason the parser scopes to the HeartRateBpm block before reading
   * `<Value>`: a Trackpoint carries other wrapped values — power here, often
   * cadence too — and taking the first `<Value>` in the point would read 240
   * watts as a heart rate, which is both wrong and plausible-looking.
   */
  it('does not mistake the power reading for a heart rate', () => {
    const parsed = parseTcxActivity(tcx(tcxPoint(37.80, -122.40, 130) + '\n' + tcxPoint(37.81, -122.41, 132)))
    expect(parsed.heartRateMax).toBe(132)
    expect(parsed.heartRateMax).not.toBe(240)
  })

  it('reports null for a TCX with no heart rate', () => {
    const parsed = parseTcxActivity(tcx([
      tcxPoint(37.80, -122.40, null),
      tcxPoint(37.81, -122.41, null),
    ].join('\n')))

    expect(parsed.heartRateAvg).toBeNull()
    expect(parsed.heartRateMax).toBeNull()
  })
})

describe('the rest of the import is unchanged', () => {
  it('still parses position, time and elevation alongside the new field', () => {
    const parsed = parseGpxActivity(gpx([
      gpxPoint(37.80, -122.40, 140),
      gpxPoint(37.81, -122.41, 150),
    ].join('\n')))

    expect(parsed.name).toBe('Morning Run')
    expect(parsed.samples).toHaveLength(2)
    expect(parsed.samples[0].lat).toBeCloseTo(37.80, 5)
    expect(parsed.samples[0].heartRate).toBe(140)
    expect(parsed.distanceMiles).toBeGreaterThan(0)
  })
})
