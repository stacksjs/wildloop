/**
 * Estimated-time formatting for trails.
 *
 * A trail's estimate is stored as a display string (`45m`, `5h 30m`), which is
 * fine up to a day hike and useless beyond it: the North Country Trail came
 * out as `~388h 18m`, a number nobody can read as "about two weeks of walking".
 * So the scale changes with the magnitude — minutes, then hours, then days —
 * the same way a distance switches from feet to miles.
 *
 * Parsing lives here too, because the catalog already holds hour strings
 * written by earlier ingests. Formatting a stored value and formatting a fresh
 * estimate therefore go through the same function and cannot disagree.
 */

/** Minutes in the units the estimate is built from. */
const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 24 * 60

/**
 * `minutes` → the shortest string that still says how long this takes.
 *
 *   38        → `38m`
 *   330       → `5h 30m`
 *   1_500     → `1d 1h`
 *   23_298    → `16d 4h`
 *
 * Days round to whole hours: "16d 4h 18m" is precision the estimate does not
 * have, since it comes from a distance-and-ascent rule of thumb.
 */
export function formatTrailTime(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))

  if (total < MINUTES_PER_HOUR)
    return `${Math.max(1, total)}m`

  if (total < MINUTES_PER_DAY) {
    const hours = Math.floor(total / MINUTES_PER_HOUR)
    const rest = total % MINUTES_PER_HOUR
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  }

  const days = Math.floor(total / MINUTES_PER_DAY)
  const hours = Math.round((total % MINUTES_PER_DAY) / MINUTES_PER_HOUR)

  // 23h rounds up to a whole day rather than reading as `3d 24h`.
  if (hours >= 24)
    return `${days + 1}d`

  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}

/**
 * Read an estimate string back to minutes. Accepts every shape this module
 * emits (`45m`, `5h`, `5h 30m`, `16d`, `16d 4h`) plus the bare `388h 18m` the
 * older ingests wrote. Returns null when nothing parses, so a caller can tell
 * "no estimate" from "zero minutes".
 */
export function parseTrailTime(raw: string | null | undefined): number | null {
  if (!raw)
    return null

  const matches = raw.matchAll(/(\d+(?:\.\d+)?)\s*([dhm])/gi)
  let minutes = 0
  let matched = false

  for (const match of matches) {
    const value = Number(match[1])
    if (!Number.isFinite(value))
      continue
    matched = true
    const unit = match[2]!.toLowerCase()
    minutes += unit === 'd' ? value * MINUTES_PER_DAY : unit === 'h' ? value * MINUTES_PER_HOUR : value
  }

  return matched ? minutes : null
}

/**
 * Re-format an estimate that is already stored. A catalog row written before
 * the day scale existed still reads correctly on the page, without a migration
 * that would have to re-derive every trail's estimate from its geometry.
 */
export function displayTrailTime(raw: string | null | undefined): string {
  const minutes = parseTrailTime(raw)
  return minutes === null ? '' : formatTrailTime(minutes)
}
