import type { RoutePair as LatLng } from './trail-geometry'
import { primaryRoutePart } from './trail-geometry'

const RADIANS = Math.PI / 180

/** The selected trail stays legible on terrain, street and satellite maps. */
export const trailRouteStyle = { line: '#91e86b', casing: '#365b2d' } as const

/** Catalog coordinates can be a trail's center; navigation uses its recorded start. */
export function trailheadPosition(geometry: unknown, fallback?: { lat: number, lng: number } | null): { lat: number, lng: number } | null {
  const first = primaryRoutePart(geometry)[0]
  if (first) return { lat: first[0], lng: first[1] }
  if (fallback && Number.isFinite(fallback.lat) && Math.abs(fallback.lat) <= 90 && Number.isFinite(fallback.lng) && Math.abs(fallback.lng) <= 180)
    return { lat: fallback.lat, lng: fallback.lng }
  return null
}

export function trailSegmentMiles(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * RADIANS
  const dLng = (b[1] - a[1]) * RADIANS
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RADIANS) * Math.cos(b[0] * RADIANS) * Math.sin(dLng / 2) ** 2
  return 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Even spacing along the actual line, never across gaps between parts. */
export function trailDirectionSigns(parts: LatLng[][], limit = 14): Array<{ point: LatLng, bearing: number }> {
  const total = parts.reduce((sum, part) => sum + part.slice(1).reduce((n, p, i) => n + trailSegmentMiles(part[i], p), 0), 0)
  if (total <= 0 || limit < 1)
    return []
  const spacing = total / (limit + 1)
  const signs: Array<{ point: LatLng, bearing: number }> = []
  let travelled = 0
  let next = spacing
  for (const part of parts) {
    for (let i = 1; i < part.length; i++) {
      const a = part[i - 1]
      const b = part[i]
      const length = trailSegmentMiles(a, b)
      while (length > 0 && next <= travelled + length && signs.length < limit) {
        const ratio = (next - travelled) / length
        const delta = (b[1] - a[1]) * RADIANS
        const y = Math.sin(delta) * Math.cos(b[0] * RADIANS)
        const x = Math.cos(a[0] * RADIANS) * Math.sin(b[0] * RADIANS) - Math.sin(a[0] * RADIANS) * Math.cos(b[0] * RADIANS) * Math.cos(delta)
        signs.push({ point: [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio], bearing: Math.atan2(y, x) / RADIANS })
        next += spacing
      }
      travelled += length
    }
  }
  return signs
}

/** Leave room between direction badges when routes shrink or cross on screen. */
export function trailDirectionVisibility(points: Array<{ x: number, y: number }>, clearance = 64): boolean[] {
  const visible: Array<{ x: number, y: number }> = []
  return points.map(point => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
      || visible.some(other => Math.hypot(point.x - other.x, point.y - other.y) < clearance))
      return false
    visible.push(point)
    return true
  })
}

const SURFACES: Record<string, { label: string, color: string, icon: string }> = {
  dirt: { label: 'Natural', color: '#b58a58', icon: 'i-lucide-footprints' },
  earth: { label: 'Natural', color: '#b58a58', icon: 'i-lucide-footprints' },
  ground: { label: 'Natural', color: '#b58a58', icon: 'i-lucide-footprints' },
  unpaved: { label: 'Unpaved', color: '#b58a58', icon: 'i-lucide-footprints' },
  gravel: { label: 'Gravel', color: '#8d917f', icon: 'i-lucide-mountain' },
  rock: { label: 'Rock', color: '#85877a', icon: 'i-lucide-mountain' },
  sand: { label: 'Sand', color: '#ceb77d', icon: 'i-lucide-footprints' },
  paved: { label: 'Paved', color: '#586252', icon: 'i-lucide-route' },
  asphalt: { label: 'Paved', color: '#586252', icon: 'i-lucide-route' },
  concrete: { label: 'Paved', color: '#586252', icon: 'i-lucide-route' },
  wood: { label: 'Wood', color: '#876463', icon: 'i-lucide-trees' },
  boardwalk: { label: 'Wood', color: '#876463', icon: 'i-lucide-trees' },
  grass: { label: 'Grass', color: '#779665', icon: 'i-lucide-sprout' },
}

/** Catalog surfaces have no measured fractions. Never turn a list into percentages. */
export function trailSurfaceTypes(surface: string | null | undefined): Array<{ label: string, color: string, icon: string }> {
  const found = new Map<string, { label: string, color: string, icon: string }>()
  for (const raw of String(surface ?? '').split(/[;,/]/)) {
    const key = raw.trim().toLowerCase()
    if (!key)
      continue
    const entry = SURFACES[key] ?? { label: key.replace(/[_-]/g, ' ').replace(/^./, c => c.toUpperCase()), color: '#8d917f', icon: 'i-lucide-footprints' }
    found.set(entry.label, entry)
  }
  return [...found.values()]
}

export function trailGpx(name: string, parts: LatLng[][]): string {
  const escaped = name.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Wildloop" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escaped}</name>${parts.filter(p => p.length > 1).map(part => `<trkseg>${part.map(([lat, lng]) => `<trkpt lat="${lat}" lon="${lng}"/>`).join('')}</trkseg>`).join('')}</trk></gpx>`
}
