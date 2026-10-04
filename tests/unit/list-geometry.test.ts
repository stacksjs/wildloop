import { describe, expect, it } from 'bun:test'
import { LIST_TOLERANCE_DEGREES, listGeometry } from '../../app/Support/listGeometry'
import { decodeRouteParts } from '../../resources/functions/trail-geometry'

/**
 * A trail's line in a list response is thinned, and must stay usable for
 * everything the client does with it — including navigation and offline
 * downloads, which reuse the list's line without fetching the trail again.
 */

/** Shortest distance, in degrees, from a point to the segment a-b. */
function offLine(p: [number, number], a: [number, number], b: [number, number]): number {
  const [px, py] = p
  const [ax, ay] = a
  const [bx, by] = b
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** A wandering line: a straight stretch, then switchbacks. */
const line: [number, number][] = [
  ...Array.from({ length: 40 }, (_, i) => [34 + i * 0.0001, -118.5] as [number, number]),
  ...Array.from({ length: 40 }, (_, i) => [34.004 + (i % 2) * 0.0008, -118.5 + i * 0.0002] as [number, number]),
]

describe('a trail line in a list', () => {
  it('drops the points a straight stretch does not need', () => {
    const thinned = decodeRouteParts(listGeometry(JSON.stringify(line)))[0]
    expect(thinned.length).toBeLessThan(line.length)
    // Stored at five decimals, so compared to five.
    expect(thinned[0][0]).toBeCloseTo(line[0][0], 5)
    expect(thinned.at(-1)?.[0]).toBeCloseTo(line.at(-1)![0], 5)
    expect(thinned.at(-1)?.[1]).toBeCloseTo(line.at(-1)![1], 5)
  })

  it('moves no point further from the line than a phone\'s own GPS error', () => {
    const thinned = decodeRouteParts(listGeometry(JSON.stringify(line)))[0]
    for (const point of line) {
      const nearest = Math.min(...thinned.slice(1).map((end, i) => offLine(point, thinned[i], end)))
      // Plus the five-decimal rounding of the stored format.
      expect(nearest).toBeLessThanOrEqual(LIST_TOLERANCE_DEGREES + 1e-5)
    }
  })

  it('keeps a trail in several pieces in several pieces', () => {
    const parts = [line.slice(0, 30), line.slice(45)]
    expect(decodeRouteParts(listGeometry(JSON.stringify(parts)))).toHaveLength(2)
  })

  it('passes through what it cannot read', () => {
    expect(listGeometry(null)).toBeNull()
    expect(listGeometry('')).toBe('')
    expect(listGeometry('not geometry')).toBe('not geometry')
  })
})
