import type { Coordinate } from '../../resources/functions/geo'
import type { TrailDifficulty } from '../Ingest/types'
import { db } from '@stacksjs/orm'
import { deriveDifficulty } from '../Ingest/normalize'

/**
 * How long a folded trail is, pieces included.
 *
 * `trails:fold-fragments` hides the pieces of a trail under the row it keeps
 * (`trail_parts`, #1002), and that row carries only its own length and line:
 * Mesa Trail in Boulder listed 1.14 miles. What the catalog shows, filters on,
 * sorts by and ranks on is the whole trail, so the fold works it out here and
 * keeps it in `trail_totals` (migration 0000000200). The kept row's own
 * distance and line stay as they are, because activity matching, records,
 * territory and segments all follow that line.
 *
 * The pieces of one trail are ways a mapper drew between junctions, joined end
 * to end, so their lengths add. What must not add is the same ground twice: a
 * way drawn twice, or a route relation beside the ways it is made of, where the
 * relation is the longest row and so the one kept. So each row counts only the
 * part of its line that no row counted before it lies along.
 */

/** A row of a folded trail, reduced to what its length needs. */
export interface WholeTrailMember {
  id: number
  /** Miles, as the row stores it. */
  distance: number
  /** Ascent in feet, as the row stores it. */
  elevation: number
  /** Whether the ascent was measured, rather than never looked up. */
  elevationMeasured: boolean
  /** The row line, one array per part. */
  lines: Coordinate[][]
  /** The grade the row stores. Only the kept row's is read. */
  difficulty?: string | null
}

/** The whole trail, as `trail_totals` keeps it. */
export interface WholeTrail {
  /** Miles. */
  distance: number
  /** Feet of ascent, or null when a row counted has none measured. */
  elevation: number | null
  /** How many pieces folded into the trail. */
  pieces: number
  /**
   * How hard the whole trail is (`wholeDifficulty`). Null only for a total
   * written before it was graded (migration 0000000203), which reads as the
   * kept row's own grade until the fold works it out again.
   */
  difficulty: TrailDifficulty | null
}

/**
 * How near a stretch of line must lie to one already counted to be the same
 * ground, in metres.
 *
 * Duplicated ways share their nodes and a relation is built from its member
 * ways, so the same ground lies within a metre or two. This only has to absorb
 * the five-decimal rounding the lines are stored at.
 */
export const SAME_GROUND_METERS = 12

/**
 * How long a stretch must lie along counted ground to be the same ground, in
 * metres. A junction or a crossing is near another line for about twice
 * `SAME_GROUND_METERS`, and this is longer than that.
 */
const SAME_STRETCH_METERS = 3 * SAME_GROUND_METERS

/** How finely a line is checked against the lines counted before it, in metres. */
const SAMPLE_METERS = 10

/** A share of a line below this is rounding, not a stretch of trail. */
const MIN_NEW_SHARE = 0.02

const METERS_PER_DEGREE = 111_320

/** Lines already counted, as points close enough together to measure against. */
class CountedGround {
  private readonly cells = new Map<string, Array<[number, number]>>()
  private readonly cos: number

  constructor(latitude: number) {
    this.cos = Math.max(0.01, Math.cos((latitude * Math.PI) / 180))
  }

  /** Metres east and north of the equator and meridian, flat at this latitude. */
  xy(point: Coordinate): [number, number] {
    return [point.lng * METERS_PER_DEGREE * this.cos, point.lat * METERS_PER_DEGREE]
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / SAME_GROUND_METERS)}:${Math.floor(y / SAME_GROUND_METERS)}`
  }

  add(line: Coordinate[]): void {
    // Points every few metres along the line, so a point anywhere on it is
    // within a couple of metres of one.
    const step = SAME_GROUND_METERS / 4
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = this.xy(line[i - 1])
      const [bx, by] = this.xy(line[i])
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
      for (let k = i === 1 ? 0 : 1; k <= n; k++)
        this.put(ax + (bx - ax) * k / n, ay + (by - ay) * k / n)
    }
  }

  private put(x: number, y: number): void {
    const key = this.key(x, y)
    const cell = this.cells.get(key)
    if (cell)
      cell.push([x, y])
    else this.cells.set(key, [[x, y]])
  }

  covers(x: number, y: number): boolean {
    const i = Math.floor(x / SAME_GROUND_METERS)
    const j = Math.floor(y / SAME_GROUND_METERS)
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const [px, py] of this.cells.get(`${i + di}:${j + dj}`) ?? []) {
          if (Math.hypot(px - x, py - y) <= SAME_GROUND_METERS)
            return true
        }
      }
    }
    return false
  }
}

/**
 * The share of these lines, by length, that lies along no line counted yet.
 *
 * Along, not merely near: a piece that starts where the last one ended, or
 * crosses it, passes within a few metres of it for a few metres, and that is
 * a junction rather than the same ground. So a stretch near counted ground
 * only counts as on it when it runs on for `SAME_STRETCH_METERS`, or is the
 * whole line. A line with no length has nothing new in it.
 */
function newShare(lines: Coordinate[][], counted: CountedGround): number {
  let total = 0
  let onCounted = 0
  for (const line of lines) {
    let lineLength = 0
    let run = 0
    let runs = 0
    const close = (whole: boolean) => {
      if (run > 0 && (whole || run >= SAME_STRETCH_METERS))
        runs += run
      run = 0
    }
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = counted.xy(line[i - 1])
      const [bx, by] = counted.xy(line[i])
      const length = Math.hypot(bx - ax, by - ay)
      const n = Math.max(1, Math.ceil(length / SAMPLE_METERS))
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n
        lineLength += length / n
        if (counted.covers(ax + (bx - ax) * t, ay + (by - ay) * t))
          run += length / n
        else close(false)
      }
    }
    close(run > 0 && run >= lineLength - 1e-9)
    total += lineLength
    onCounted += runs
  }
  return total > 0 ? Math.max(0, total - onCounted) / total : 0
}

/**
 * The whole trail a kept row and its pieces make.
 *
 * The kept row counts in full: its distance is the one the catalog showed
 * before, and the base everything else adds to. Each piece then adds its own
 * distance and ascent in the share of its line that is new ground, longest
 * piece first, so of two identical ways one counts. A piece with no line
 * cannot be checked and counts in full; the fold never makes one, because it
 * decides on lines.
 *
 * Ascent adds the same way, and only when every row that added length had its
 * ascent measured: a sum with holes in it would read as a measurement.
 */
export function wholeTrail(kept: WholeTrailMember, pieces: WholeTrailMember[]): WholeTrail {
  const start = kept.lines[0]?.[0] ?? pieces.find(piece => piece.lines[0]?.[0])?.lines[0]?.[0]
  const counted = new CountedGround(start?.lat ?? 0)
  for (const line of kept.lines)
    counted.add(line)

  let distance = Math.max(0, Number(kept.distance) || 0)
  let elevation = Math.max(0, Number(kept.elevation) || 0)
  let measured = kept.elevationMeasured

  const ordered = [...pieces].sort((a, b) => (Number(b.distance) || 0) - (Number(a.distance) || 0) || a.id - b.id)
  for (const piece of ordered) {
    const hasLine = piece.lines.some(line => line.length >= 2)
    const share = hasLine ? newShare(piece.lines, counted) : 1
    if (share < MIN_NEW_SHARE)
      continue
    distance += Math.max(0, Number(piece.distance) || 0) * share
    elevation += Math.max(0, Number(piece.elevation) || 0) * share
    measured &&= piece.elevationMeasured
    for (const line of piece.lines)
      counted.add(line)
  }

  const whole = Math.round(distance * 100) / 100
  return {
    distance: whole,
    elevation: measured ? Math.round(elevation) : null,
    pieces: pieces.length,
    difficulty: wholeDifficulty(kept, whole, elevation),
  }
}

const GRADES: readonly TrailDifficulty[] = ['easy', 'moderate', 'hard']

function isGrade(value: unknown): value is TrailDifficulty {
  return GRADES.includes(value as TrailDifficulty)
}

function harder(a: TrailDifficulty, b: TrailDifficulty): TrailDifficulty {
  return GRADES.indexOf(a) >= GRADES.indexOf(b) ? a : b
}

/**
 * How hard the whole trail is.
 *
 * The grade `deriveDifficulty` gives the whole length and ascent, the same
 * rule that graded every row at ingest and that `trails:regrade-difficulty`
 * applies, so a trail folded from pieces is graded as if it had been one row.
 * The ascent is what the measured rows add up to, counted as the length is:
 * where some rows are unmeasured that is less than the whole climb, so the
 * grade can only be too easy, never too hard, and a measured climb on the
 * kept row is never thrown away for the pieces that lack one.
 *
 * A source can grade a trail harder than its length and ascent say: a Forest
 * Service trail class sets a floor (app/Ingest/sources/usfs.ts). The kept
 * row's stored grade is that floor when its own length and ascent give an
 * easier one, and the whole trail never grades below it. Otherwise the
 * stored grade is the row's own length speaking, and the whole trail's
 * replaces it, so a short steep stub that folded into a long gentle trail
 * does not make the whole trail hard.
 */
export function wholeDifficulty(kept: WholeTrailMember, distance: number, ascent: number): TrailDifficulty {
  const whole = deriveDifficulty(Math.max(0, Number(distance) || 0), Math.max(0, Number(ascent) || 0)).difficulty
  const stored = kept.difficulty
  if (!isGrade(stored))
    return whole
  const own = deriveDifficulty(Math.max(0, Number(kept.distance) || 0), kept.elevationMeasured ? Math.max(0, Number(kept.elevation) || 0) : null).difficulty
  return GRADES.indexOf(stored) > GRADES.indexOf(own) ? harder(whole, stored) : whole
}

/**
 * The catalog filters on length and ascent, on the whole trail.
 *
 * A whole length is never shorter than the row's own, and a whole ascent is
 * only kept when measured and is then never less than the row's own. So a
 * trail is long enough when its row is, or when its whole is; and short
 * enough when its row is and its whole is not over. Each reads the row's own
 * column, which the length indexes cover, and `trail_totals` once through its
 * own index, never a whole length per row. Both take the bound twice.
 */
export const WHOLE_AT_LEAST_SQL = {
  distance: '(distance >= ? OR id IN (SELECT trail_id FROM trail_totals WHERE trail_totals.distance >= ?))',
  elevation: '(elevation >= ? OR id IN (SELECT trail_id FROM trail_totals WHERE trail_totals.elevation >= ?))',
} as const

export const WHOLE_AT_MOST_SQL = {
  distance: 'distance <= ? AND id NOT IN (SELECT trail_id FROM trail_totals WHERE trail_totals.distance > ?)',
  elevation: 'elevation <= ? AND id NOT IN (SELECT trail_id FROM trail_totals WHERE trail_totals.elevation > ?)',
} as const

/**
 * The catalog filters on difficulty on the whole trail too.
 *
 * A trail is graded by its total where it has a graded one, and by its row
 * otherwise. So it matches when its total has that grade, or when its row
 * has it and no total grades it differently. Both read `trail_totals` once,
 * never a grade per row. Takes the grade three times.
 */
export const WHOLE_DIFFICULTY_SQL = '(id IN (SELECT trail_id FROM trail_totals WHERE trail_totals.difficulty = ?) OR (difficulty = ? AND id NOT IN (SELECT trail_id FROM trail_totals WHERE trail_totals.difficulty <> ?)))'

/** Positive integer ids, once each, as the JSON `json_each` reads. */
function idList(ids: Iterable<number>): string {
  return JSON.stringify([...new Set([...ids].map(Number).filter(id => Number.isInteger(id) && id > 0))])
}

/**
 * The whole trail of each of these ids that has pieces.
 *
 * One primary-key lookup each. A failed read leaves each trail at its own
 * length, which is what the catalog showed before there were totals.
 */
export async function wholeTrails(trailIds: Iterable<number>): Promise<Map<number, WholeTrail>> {
  const found = new Map<number, WholeTrail>()
  const list = idList(trailIds)
  if (list === '[]')
    return found

  const rows = await db.sql`
    SELECT trail_id, distance, elevation, pieces, difficulty FROM trail_totals
    WHERE trail_id IN (SELECT value FROM json_each(${list}))
  `.execute().catch(() => []) as Array<{ trail_id: number, distance: number, elevation: number | null, pieces: number, difficulty: string | null }>

  for (const row of rows ?? []) {
    found.set(Number(row.trail_id), {
      distance: Number(row.distance),
      elevation: row.elevation === null || row.elevation === undefined ? null : Number(row.elevation),
      pieces: Number(row.pieces) || 0,
      difficulty: isGrade(row.difficulty) ? row.difficulty : null,
    })
  }
  return found
}

/**
 * A trail row as the catalog shows it: the whole trail length, ascent and
 * grade where it has pieces, and its own beside them.
 *
 * `distance`, `elevation` and `difficulty` are what every card, page and
 * filter reads, so they carry the whole trail. `ownDistance`, `ownElevation`
 * and `ownDifficulty` are the row, which its `geometry` measures. A row
 * without pieces comes back unchanged.
 */
export function withWholeTrail<T extends Record<string, any>>(row: T, whole: WholeTrail | undefined): T {
  if (!whole)
    return row
  return {
    ...row,
    distance: whole.distance,
    elevation: whole.elevation ?? row.elevation,
    difficulty: whole.difficulty ?? row.difficulty,
    ownDistance: row.distance,
    ownElevation: row.elevation,
    ownDifficulty: row.difficulty,
    pieces: whole.pieces,
  }
}

/** `withWholeTrail` over a list, read in one query. */
export async function withWholeTrails<T extends Record<string, any>>(rows: T[]): Promise<T[]> {
  if (rows.length === 0)
    return rows
  const totals = await wholeTrails(rows.map(row => Number(row.id)))
  return totals.size === 0 ? rows : rows.map(row => withWholeTrail(row, totals.get(Number(row.id))))
}
