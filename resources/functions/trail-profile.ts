/** Elevation geometry shared by STX's browser and Craft native drawings. */
export interface TrailProfilePoint { mi: number, ft: number | null, lat: number, lng: number }

export function trailProfileRange(points: TrailProfilePoint[]) {
  const values = points.map(p => p.ft).filter((ft): ft is number => ft !== null && Number.isFinite(ft))
  return { low: values.length ? Math.min(...values) : 0, high: values.length ? Math.max(...values) : 0, miles: points.at(-1)?.mi ?? 0 }
}

/** Gaps stay gaps, rather than connecting across unknown elevations. */
export function trailProfilePath(points: TrailProfilePoint[]): string {
  const { low, high, miles } = trailProfileRange(points)
  const paths: string[] = []
  let segment: string[] = []
  for (const point of points) {
    if (point.ft === null || !Number.isFinite(point.ft)) {
      if (segment.length) paths.push(`M${segment.join(' L')}`)
      segment = []
      continue
    }
    const x = 8 + point.mi / (miles || 1) * 984
    const y = 92 - (point.ft - low) / (high - low || 1) * 76
    segment.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  if (segment.length) paths.push(`M${segment.join(' L')}`)
  return paths.join(' ')
}
