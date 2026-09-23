/**
 * Encoded polylines (Google's format, 5 decimal places ≈ 1 m): a path as a
 * short ASCII string, so a route's shape fits in a GET query — about five
 * bytes a point instead of twenty.
 *
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */

export type LatLngPair = [number, number]

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1
  let out = ''
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1F)) + 63)
    v >>= 5
  }
  return out + String.fromCharCode(v + 63)
}

export function encodePolyline(points: LatLngPair[], precision = 5): string {
  const factor = 10 ** precision
  let lastLat = 0
  let lastLng = 0
  let out = ''
  for (const [lat, lng] of points) {
    const la = Math.round(lat * factor)
    const ln = Math.round(lng * factor)
    out += encodeValue(la - lastLat) + encodeValue(ln - lastLng)
    lastLat = la
    lastLng = ln
  }
  return out
}

/** Decode; a malformed string stops at the last whole point instead of throwing. */
export function decodePolyline(encoded: string, precision = 5): LatLngPair[] {
  const factor = 10 ** precision
  const points: LatLngPair[] = []
  let index = 0
  let lat = 0
  let lng = 0
  const next = (): number | null => {
    let result = 0
    let shift = 0
    let byte: number
    do {
      if (index >= encoded.length)
        return null
      byte = encoded.charCodeAt(index++) - 63
      if (byte < 0 || shift > 30)
        return null
      result |= (byte & 0x1F) << shift
      shift += 5
    } while (byte >= 0x20)
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (index < encoded.length) {
    const dLat = next()
    const dLng = next()
    if (dLat === null || dLng === null)
      break
    lat += dLat
    lng += dLng
    points.push([lat / factor, lng / factor])
  }
  return points
}
