/**
 * A route drawn to fit a box, for the inline SVG route pictures on cards.
 *
 * `useRoutePreview` builds a square data-URI thumbnail, which is right for a
 * small chip and wrong for a banner: the square gets cropped by `object-cover`
 * and the line blows up to fill a 4:1 strip. This returns plain numbers
 * instead, fitted into whatever box the markup declares as its `viewBox`, with
 * the route's own proportions kept (longitude is scaled by the cosine of the
 * latitude, so an east-west ridge does not come out twice as wide as it is).
 *
 * The markup owns the colours, which is what lets the same line read in both
 * themes — a data URI has its palette baked in.
 */

type RoutePoint = [number, number] | { lat: number, lng: number }

export interface RouteShape {
  /** `x,y x,y …` for a `<polyline points>`. */
  points: string
  startX: number
  startY: number
  endX: number
  endY: number
  /** Ends within a few percent of where it started: a loop gets one marker. */
  loop: boolean
}

/** More than enough for a card; a national trail carries thousands. */
const MAX_POINTS = 120

function latLng(point: RoutePoint): [number, number] | null {
  if (Array.isArray(point))
    return Number.isFinite(point[0]) && Number.isFinite(point[1]) ? [point[0], point[1]] : null
  if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng))
    return [point.lat, point.lng]
  return null
}

function sample(coords: [number, number][]): [number, number][] {
  if (coords.length <= MAX_POINTS)
    return coords
  const step = (coords.length - 1) / (MAX_POINTS - 1)
  const out: [number, number][] = []
  for (let i = 0; i < MAX_POINTS; i++)
    out.push(coords[Math.round(i * step)])
  return out
}

/**
 * Fit a route into a `width` × `height` box, leaving `pad` on every side.
 * Null when there is no line to draw.
 */
export function routeShapeFor(input: RoutePoint[] | null | undefined, width = 100, height = 100, pad = 10): RouteShape | null {
  if (!Array.isArray(input) || input.length < 2)
    return null

  const coords = sample(input.map(latLng).filter((p): p is [number, number] => p !== null))
  if (coords.length < 2)
    return null

  const lats = coords.map(c => c[0])
  const lngs = coords.map(c => c[1])
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const squash = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1

  const spanX = (maxLng - minLng) * squash
  const spanY = maxLat - minLat
  const span = Math.max(spanX, spanY)
  if (!(span > 0))
    return null

  const innerW = width - pad * 2
  const innerH = height - pad * 2
  const scale = Math.min(innerW / (spanX || span), innerH / (spanY || span))
  // Centre the drawing in whichever axis it does not fill.
  const offsetX = pad + (innerW - spanX * scale) / 2
  const offsetY = pad + (innerH - spanY * scale) / 2

  const projected = coords.map(([lat, lng]) => [
    offsetX + (lng - minLng) * squash * scale,
    offsetY + (maxLat - lat) * scale,
  ] as const)

  const [startX, startY] = projected[0]
  const [endX, endY] = projected[projected.length - 1]
  const gap = Math.hypot(endX - startX, endY - startY)

  return {
    points: projected.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
    startX: Number(startX.toFixed(1)),
    startY: Number(startY.toFixed(1)),
    endX: Number(endX.toFixed(1)),
    endY: Number(endY.toFixed(1)),
    loop: gap < Math.max(innerW, innerH) * 0.04,
  }
}
