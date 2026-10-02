export const MAX_ACTIVITY_FILE_BYTES = 25 * 1024 * 1024
export const MAX_ACTIVITY_TRACK_POINTS = 100_000

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31)
const FIT_RECORD_MESSAGE = 20

interface FitFieldDefinition {
  number: number
  size: number
  type: number
}

interface FitMessageDefinition {
  fields: FitFieldDefinition[]
  globalNumber: number
  littleEndian: boolean
}

export interface ImportedTrackSample {
  lat: number
  lng: number
  time: number | null
  altitude: number | null
  accuracy: number | null
  /** Beats per minute at this fix, when the file carried one. */
  heartRate: number | null
}

export interface ImportedActivityFile {
  name: string
  samples: ImportedTrackSample[]
  completedAt: string
  durationSeconds: number
  distanceMiles: number
  elevationGainFeet: number
  /** Averaged over the fixes that carried a reading, not over every fix. */
  heartRateAvg: number | null
  heartRateMax: number | null
}

/**
 * The window a heart rate has to fall in to be believed.
 *
 * A strap that has lost contact reports 0, and a few report 255; both appear
 * mid-file surrounded by real readings, so they have to be dropped per fix
 * rather than per file. The upper bound is deliberately above any human
 * maximum — the job here is to reject sensor noise, not to referee how hard
 * somebody was working.
 */
const MIN_PLAUSIBLE_BPM = 20
const MAX_PLAUSIBLE_BPM = 250

function numberBetween(value: unknown, min: number, max: number): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : null
}

function timeValue(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function distanceMetres(a: ImportedTrackSample, b: ImportedTrackSample): number {
  const radius = 6371000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return 2 * radius * Math.asin(Math.sqrt(x))
}

function summarize(name: string, samples: ImportedTrackSample[]): ImportedActivityFile {
  if (samples.length < 2)
    throw new Error('The file does not contain enough track points')
  let metres = 0
  let elevationMetres = 0
  for (let index = 1; index < samples.length; index++) {
    metres += distanceMetres(samples[index - 1], samples[index])
    const previous = samples[index - 1].altitude
    const current = samples[index].altitude
    if (previous !== null && current !== null && current - previous >= 1)
      elevationMetres += current - previous
  }
  const beats = samples
    .map(sample => sample.heartRate)
    .filter((bpm): bpm is number => bpm !== null)

  const times = samples.map(sample => sample.time).filter((time): time is number => time !== null)
  const first = times[0] ?? Date.now()
  const last = times[times.length - 1] ?? first
  return {
    name,
    samples,
    completedAt: new Date(last).toISOString(),
    durationSeconds: Math.max(1, Math.round((last - first) / 1000)),
    distanceMiles: metres / 1609.344,
    elevationGainFeet: Math.round(elevationMetres * 3.28084),
    /*
     * Null, not zero, when the file carried no heart rate — which is most
     * files, since only a watch paired with a strap or an optical sensor
     * writes one. Zero would read as a stopped heart (#1010).
     */
    heartRateAvg: beats.length > 0 ? Math.round(beats.reduce((sum, bpm) => sum + bpm, 0) / beats.length) : null,
    heartRateMax: beats.length > 0 ? Math.max(...beats) : null,
  }
}

function addSample(samples: ImportedTrackSample[], sample: ImportedTrackSample): void {
  if (samples.length >= MAX_ACTIVITY_TRACK_POINTS)
    throw new Error(`Activity files may contain at most ${MAX_ACTIVITY_TRACK_POINTS.toLocaleString()} track points`)
  samples.push(sample)
}

/**
 * The inner XML of an element, nested children included.
 *
 * `tag` below stops at the first `<`, which is right for a leaf but returns
 * nothing for a wrapper like TCX's `<HeartRateBpm><Value>152</Value></…>`.
 */
function block(source: string, name: string): string | null {
  const match = source.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'))
  return match?.[1] ?? null
}

function tag(block: string, name: string): string | null {
  const match = block.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]+)<\\/(?:\\w+:)?${name}>`, 'i'))
  return match?.[1]?.trim() ?? null
}

export function parseGpxActivity(text: string, fallbackName = 'GPX import'): ImportedActivityFile {
  const samples: ImportedTrackSample[] = []
  const pointPattern = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi
  for (const match of text.matchAll(pointPattern)) {
    const lat = numberBetween(match[1].match(/\blat=["']([^"']+)/i)?.[1], -90, 90)
    const lng = numberBetween(match[1].match(/\b(?:lon|lng)=["']([^"']+)/i)?.[1], -180, 180)
    if (lat === null || lng === null) continue
    addSample(samples, {
      lat,
      lng,
      time: timeValue(tag(match[2], 'time')),
      altitude: numberBetween(tag(match[2], 'ele'), -1000, 10000),
      accuracy: null,
      // Garmin, COROS and Suunto all write `<gpxtpx:hr>` inside the point's
      // `<extensions>`; `tag` is already namespace-tolerant.
      heartRate: numberBetween(tag(match[2], 'hr'), MIN_PLAUSIBLE_BPM, MAX_PLAUSIBLE_BPM),
    })
  }
  return summarize(tag(text, 'name') ?? fallbackName, samples)
}

export function parseTcxActivity(text: string, fallbackName = 'TCX import'): ImportedActivityFile {
  const samples: ImportedTrackSample[] = []
  const pointPattern = /<Trackpoint\b[^>]*>([\s\S]*?)<\/Trackpoint>/gi
  for (const match of text.matchAll(pointPattern)) {
    const lat = numberBetween(tag(match[1], 'LatitudeDegrees'), -90, 90)
    const lng = numberBetween(tag(match[1], 'LongitudeDegrees'), -180, 180)
    if (lat === null || lng === null) continue
    addSample(samples, {
      lat,
      lng,
      time: timeValue(tag(match[1], 'Time')),
      altitude: numberBetween(tag(match[1], 'AltitudeMeters'), -1000, 10000),
      accuracy: null,
      // Scoped to the HeartRateBpm block first: a Trackpoint carries several
      // other `<Value>` elements (cadence, watts), and reading the first one
      // in the point would pick up whichever happened to come first.
      heartRate: numberBetween(tag(block(match[1], 'HeartRateBpm') ?? '', 'Value'), MIN_PLAUSIBLE_BPM, MAX_PLAUSIBLE_BPM),
    })
  }
  return summarize(tag(text, 'Name') ?? fallbackName, samples)
}

export function parseFitActivity(bytes: ArrayBuffer, fallbackName = 'FIT import'): ImportedActivityFile {
  const data = new DataView(bytes)
  if (data.byteLength < 12) throw new Error('The FIT file is too small')
  const headerSize = data.getUint8(0)
  if (headerSize < 12 || headerSize > data.byteLength) throw new Error('The FIT file header is invalid')
  const signature = String.fromCharCode(...new Uint8Array(bytes, 8, 4))
  if (signature !== '.FIT') throw new Error('The file is not a FIT activity')

  const dataEnd = headerSize + data.getUint32(4, true)
  if (dataEnd > data.byteLength) throw new Error('The FIT file is truncated')

  const definitions = new Map<number, FitMessageDefinition>()
  const samples: ImportedTrackSample[] = []
  let offset = headerSize
  let lastTimestamp: number | null = null

  const requireBytes = (count: number) => {
    if (offset + count > dataEnd) throw new Error('The FIT file contains a truncated record')
  }
  const readField = (field: FitFieldDefinition, littleEndian: boolean): number | null => {
    requireBytes(field.size)
    const start = offset
    offset += field.size
    const type = field.type & 0x1F
    if (type === 0 || type === 2 || type === 10 || type === 13) {
      const value = data.getUint8(start)
      return value === (type === 10 ? 0 : 0xFF) ? null : value
    }
    if (type === 1) {
      const value = data.getInt8(start)
      return value === 0x7F ? null : value
    }
    if ((type === 3 || type === 4 || type === 11) && field.size >= 2) {
      const signed = type === 3
      const value = signed ? data.getInt16(start, littleEndian) : data.getUint16(start, littleEndian)
      const invalid = type === 11 ? 0 : signed ? 0x7FFF : 0xFFFF
      return value === invalid ? null : value
    }
    if ((type === 5 || type === 6 || type === 12) && field.size >= 4) {
      const signed = type === 5
      const value = signed ? data.getInt32(start, littleEndian) : data.getUint32(start, littleEndian)
      const invalid = type === 12 ? 0 : signed ? 0x7FFFFFFF : 0xFFFFFFFF
      return value === invalid ? null : value
    }
    return null
  }

  while (offset < dataEnd) {
    requireBytes(1)
    const recordHeader = data.getUint8(offset++)
    const compressed = (recordHeader & 0x80) !== 0
    const definition = !compressed && (recordHeader & 0x40) !== 0
    const localNumber = compressed ? (recordHeader >> 5) & 0x03 : recordHeader & 0x0F

    if (definition) {
      requireBytes(5)
      offset++ // reserved
      const littleEndian = data.getUint8(offset++) === 0
      const globalNumber = data.getUint16(offset, littleEndian)
      offset += 2
      const fieldCount = data.getUint8(offset++)
      const fields: FitFieldDefinition[] = []
      requireBytes(fieldCount * 3)
      for (let index = 0; index < fieldCount; index++) {
        fields.push({
          number: data.getUint8(offset++),
          size: data.getUint8(offset++),
          type: data.getUint8(offset++),
        })
      }
      if ((recordHeader & 0x20) !== 0) {
        requireBytes(1)
        const developerFieldCount = data.getUint8(offset++)
        requireBytes(developerFieldCount * 3)
        for (let index = 0; index < developerFieldCount; index++) {
          fields.push({ number: data.getUint8(offset++), size: data.getUint8(offset++), type: 13 })
        }
      }
      definitions.set(localNumber, { fields, globalNumber, littleEndian })
      continue
    }

    const message = definitions.get(localNumber)
    if (!message) throw new Error('The FIT file references an unknown message definition')
    const values = new Map<number, number>()
    for (const field of message.fields) {
      const value = readField(field, message.littleEndian)
      if (value !== null) values.set(field.number, value)
    }
    let timestamp = values.get(253) ?? null
    if (compressed && lastTimestamp !== null) {
      const timeOffset = recordHeader & 0x1F
      timestamp = (lastTimestamp & ~0x1F) + timeOffset
      if (timestamp <= lastTimestamp) timestamp += 0x20
    }
    if (timestamp !== null) lastTimestamp = timestamp
    if (message.globalNumber !== FIT_RECORD_MESSAGE) continue

    const latitude = values.get(0)
    const longitude = values.get(1)
    if (latitude === undefined || longitude === undefined) continue
    const altitudeValue = values.get(78) ?? values.get(2)
    addSample(samples, {
      lat: latitude * (180 / 2 ** 31),
      lng: longitude * (180 / 2 ** 31),
      time: timestamp === null ? null : FIT_EPOCH_MS + timestamp * 1000,
      altitude: altitudeValue === undefined ? null : altitudeValue / 5 - 500,
      accuracy: null,
      // Record message field 3 is heart_rate, already in bpm.
      heartRate: numberBetween(values.get(3), MIN_PLAUSIBLE_BPM, MAX_PLAUSIBLE_BPM),
    })
  }

  return summarize(fallbackName, samples)
}

export async function parseActivityFile(file: File): Promise<ImportedActivityFile> {
  if (file.size > MAX_ACTIVITY_FILE_BYTES)
    throw new Error('Activity files must be 25 MB or smaller')
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'fit') return parseFitActivity(await file.arrayBuffer(), file.name.replace(/\.fit$/i, ''))
  const text = await file.text()
  if (extension === 'gpx' || text.includes('<gpx')) return parseGpxActivity(text, file.name)
  if (extension === 'tcx' || text.includes('<TrainingCenterDatabase')) return parseTcxActivity(text, file.name)
  throw new Error('Choose a GPX, TCX, or FIT activity file')
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, character => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]!)
}

export function importedTrackGeoJson(samples: ImportedTrackSample[]): string {
  return JSON.stringify({
    type: 'LineString',
    coordinates: samples.map(sample => [sample.lng, sample.lat]),
    properties: { samples },
  })
}

export function trackToGpx(name: string, samples: ImportedTrackSample[]): string {
  const points = samples.map(sample => `      <trkpt lat="${sample.lat}" lon="${sample.lng}">${sample.altitude === null ? '' : `<ele>${sample.altitude}</ele>`}${sample.time === null ? '' : `<time>${new Date(sample.time).toISOString()}</time>`}</trkpt>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Wildloop" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escapeXml(name)}</name><trkseg>\n${points}\n</trkseg></trk></gpx>`
}

export function downloadGpxFile(name: string, route: Array<{ lat: number, lng: number }>): void {
  if (typeof document === 'undefined') return
  // No heart rate on a drawn route. `trackToGpx` writes none either, so an
  // imported file that carried one loses it on export — worth fixing if GPX
  // export ever becomes a migration path out, rather than a share link.
  const samples = route.map(point => ({ ...point, time: null, altitude: null, accuracy: null, heartRate: null }))
  const blob = new Blob([trackToGpx(name, samples)], { type: 'application/gpx+xml' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wildloop-activity'}.gpx`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
