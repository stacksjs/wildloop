import type { FragmentCandidate } from './trailFragments'
import type { WholeTrail, WholeTrailMember } from './wholeTrail'
import { db } from '@stacksjs/orm'
import { decodeRouteParts } from '../../resources/functions/trail-geometry'
import { foldPieces } from './trailFragments'
import { wholeTrail } from './wholeTrail'
import { inWriteTransaction } from './writeTransaction'

/**
 * The database side of folding way fragments: read every row sharing a name,
 * ask `foldPieces()` which are pieces of which, and write the difference to
 * `trail_parts` (migration 0000000190).
 *
 * Shared by the ingest, which folds the names it has just written, and by
 * `trails:fold-fragments`, which walks every shared name in the catalog a
 * slice a night.
 *
 * A name is always decided whole, and on its own. Which row a piece folds
 * into depends on every row it might join, so deciding from part of a name —
 * a window around one row — or together with whatever else shares a batch
 * could answer differently from the next pass, and the two would take turns
 * undoing each other.
 *
 * Every statement goes through a `FoldStore`, the ORM's connection in
 * production, so the tests run these exact statements against the real
 * migrations on an in-memory SQLite. Lists of ids are bound as one JSON array
 * and read back with `json_each`, rather than spliced into the SQL.
 */

/** `db.sql` as a tagged template that resolves to rows. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>

export interface FoldStore {
  sql: SqlTag
  /** Runs `work` as one write transaction. */
  transaction: <T>(work: () => Promise<T>) => Promise<T>
}

const ormStore: FoldStore = {
  sql: async (strings, ...values) => ((await db.sql(strings, ...values).execute()) as any[]) ?? [],
  transaction: inWriteTransaction,
}

/**
 * Rows read for one name before it is left alone.
 *
 * A search for "Waldweg", the commonest path name in the German catalog,
 * matches 642 production rows, and an exact name is fewer than that; one
 * reads and decides in well under a second. This only stops a name a mapper
 * gave thousands of unrelated paths from holding up a night.
 */
export const MAX_NAME_ROWS = 5000

/**
 * The same bound for the ingest, which folds as it writes and so should never
 * spend long on it: a larger name is left to the nightly walk.
 */
export const INGEST_MAX_NAME_ROWS = 500

interface GroupRow {
  id: number
  name: string
  country: string | null
  source: string | null
  distance: number | null
  elevation: number | null
  elevation_checked_at: string | null
  difficulty: string | null
  review_count: number | null
  latitude: number | null
  longitude: number | null
  geometry: string | null
}

/** One name's rows, ready to be decided. */
export interface NameGroup {
  name: string
  candidates: FragmentCandidate[]
  /** Every row under the name, including ones whose line could not be read. */
  ids: number[]
  /** Each row as its whole trail length needs it (app/Support/wholeTrail.ts). */
  members: Map<number, WholeTrailMember>
  /** Where each row is. */
  places: Map<number, TrailPlace>
}

/** Where a kept row is, repeated beside its total for the catalog. */
export interface TrailPlace {
  country: string | null
  latitude: number | null
  longitude: number | null
}

const NOWHERE: TrailPlace = { country: null, latitude: null, longitude: null }

function placeOf(row: { country?: string | null, latitude?: number | null, longitude?: number | null }): TrailPlace {
  const latitude = row.latitude === null || row.latitude === undefined ? null : Number(row.latitude)
  const longitude = row.longitude === null || row.longitude === undefined ? null : Number(row.longitude)
  return {
    country: row.country ?? null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
  }
}

/** A row read for its length: its distance, ascent and line, and the grade a kept row has. */
interface LengthRow {
  id: number
  distance: number | null
  elevation: number | null
  elevation_checked_at: string | null
  difficulty?: string | null
  geometry: string | null
}

/** A row as `wholeTrail` reads it, from the line already decoded. */
function memberOf(row: LengthRow, parts: Array<Array<[number, number]>> = decodeRouteParts(row.geometry)): WholeTrailMember {
  const elevation = Number(row.elevation ?? 0) || 0
  return {
    id: Number(row.id),
    distance: Number(row.distance ?? 0) || 0,
    elevation,
    // An ascent the source gave counts as measured as much as one the
    // elevation backfill looked up.
    elevationMeasured: elevation > 0 || Boolean(row.elevation_checked_at),
    lines: parts.map(part => part.map(([lat, lng]) => ({ lat, lng }))),
    difficulty: row.difficulty ?? null,
  }
}

/** Positive integer ids, once each, as the JSON `json_each` reads. */
function idList(ids: Iterable<number>): string {
  return JSON.stringify([...new Set([...ids].map(Number).filter(id => Number.isInteger(id) && id > 0))])
}

/**
 * Every row with exactly this name, through `trails_name_index`.
 *
 * Exact, not case-folded. A case-insensitive match cannot use the index, and
 * "Red trail" beside "Red Trail" is rare enough that leaving those apart is
 * the cheap and conservative answer.
 */
export async function readNameGroup(name: string, store: FoldStore = ormStore): Promise<NameGroup> {
  const rows = await store.sql`
    SELECT id, name, country, source, distance, elevation, elevation_checked_at, difficulty, review_count, latitude, longitude, geometry
    FROM trails
    WHERE name = ${name}
  ` as GroupRow[]

  const ids = rows.map(row => Number(row.id))
  const photos = await photoCounts(ids, store)
  const members = new Map<number, WholeTrailMember>()
  const places = new Map<number, TrailPlace>()

  const candidates = rows.map((row) => {
    const parts = decodeRouteParts(row.geometry)
    members.set(Number(row.id), memberOf(row, parts))
    places.set(Number(row.id), placeOf(row))
    return {
      id: Number(row.id),
      name: String(row.name ?? ''),
      country: row.country,
      source: row.source,
      distance: Number(row.distance ?? 0),
      reviewCount: Number(row.review_count ?? 0),
      photos: photos.get(Number(row.id)) ?? 0,
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      // Only where a row starts and ends decides anything, so a line stored
      // in several parts is read end to end.
      geometry: parts.flat().map(([lat, lng]) => ({ lat, lng })),
    }
  })

  return { name, candidates, ids, members, places }
}

/** Visible community photos per trail. A missing table is no photos. */
async function photoCounts(ids: number[], store: FoldStore): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  if (ids.length === 0)
    return counts

  try {
    const rows = await store.sql`
      SELECT trail_id, COUNT(*) AS n FROM trail_photos
      WHERE trail_id IN (SELECT value FROM json_each(${idList(ids)})) AND status = 'visible'
      GROUP BY trail_id
    ` as Array<{ trail_id: number, n: number }>
    for (const row of rows)
      counts.set(Number(row.trail_id), Number(row.n))
  }
  catch {}
  return counts
}

export interface FoldWrite {
  /** Pieces newly folded, or moved to a different trail. */
  folded: number
  /** Rows listed again. */
  unfolded: number
}

/**
 * Write what a set of names decided, and nothing else.
 *
 * `ids` is every row under those names. A row among them that `folds` does
 * not name is listed, so a piece that stopped being one comes back; so does a
 * piece pointing at one of those rows from outside them, which happens when a
 * re-sync renames the trail it was folded into.
 *
 * One short transaction, after all the reading and deciding, so the write
 * lock is held for the writes alone. A row already as decided is not touched.
 */
export async function writeFolds(
  ids: number[],
  folds: Map<number, number>,
  at: string,
  options: {
    /** Each piece's country, kept beside it for the catalog's count (migration 0000000190). */
    countryOf?: Map<number, string | null>
    /** Where the nightly walk is up to, written with the batch it accounts for. */
    progress?: { afterName: string, passed: boolean }
    /**
     * The whole trail of every row among `ids` that keeps pieces
     * (`trail_totals`, migration 0000000200). Given, the totals of those rows
     * are made to match it: a row it leaves out has no pieces any more.
     */
    totals?: Map<number, WholeTrail>
    /** Where each of those rows is, kept beside its total. */
    places?: Map<number, TrailPlace>
  } = {},
  store: FoldStore = ormStore,
): Promise<FoldWrite> {
  const { countryOf, progress, totals, places } = options
  const list = idList(ids)

  return store.transaction(async () => {
    const result: FoldWrite = { folded: 0, unfolded: 0 }

    const current = await store.sql`
      SELECT trail_id, part_of, country FROM trail_parts
      WHERE trail_id IN (SELECT value FROM json_each(${list}))
         OR part_of IN (SELECT value FROM json_each(${list}))
    ` as Array<{ trail_id: number, part_of: number, country: string | null }>
    const now = new Map(current.map(row => [Number(row.trail_id), { partOf: Number(row.part_of), country: row.country ?? null }]))

    const listed = [...now.keys()].filter(id => !folds.has(id))
    if (listed.length > 0) {
      await store.sql`DELETE FROM trail_parts WHERE trail_id IN (SELECT value FROM json_each(${idList(listed)}))`
      result.unfolded = listed.length
    }

    for (const [piece, partOf] of folds) {
      const country = countryOf?.get(piece) ?? null
      const was = now.get(piece)
      if (was && was.partOf === partOf && was.country === country)
        continue
      await store.sql`
        INSERT INTO trail_parts (trail_id, part_of, country, folded_at) VALUES (${piece}, ${partOf}, ${country}, ${at})
        ON CONFLICT(trail_id) DO UPDATE SET part_of = excluded.part_of, country = excluded.country, folded_at = excluded.folded_at
      `
      result.folded++
    }

    if (totals)
      await writeTotals(list, ids, folds, now, totals, places ?? new Map(), at, store)

    // In the same transaction as the writes it accounts for, so a run
    // stopped between the two never skips a name or repeats one.
    if (progress) {
      await store.sql`
        INSERT INTO trail_fold_progress (id, after_name, passes, updated_at)
        VALUES (1, ${progress.passed ? '' : progress.afterName}, ${progress.passed ? 1 : 0}, ${at})
        ON CONFLICT(id) DO UPDATE SET
          after_name = excluded.after_name,
          passes = trail_fold_progress.passes + excluded.passes,
          updated_at = excluded.updated_at
      `
    }

    return result
  })
}

/**
 * Make `trail_totals` match what a set of names decided.
 *
 * Every row among `ids` either keeps pieces, and has the total `totals` gives
 * it, or has no total. A trail outside `ids` that one of these pieces used to
 * be part of has lost it, so its total is dropped, and `fillWholeTrails` works
 * it out again from the pieces it has left. A total already as decided is not
 * written.
 */
async function writeTotals(
  list: string,
  ids: number[],
  folds: Map<number, number>,
  before: Map<number, { partOf: number }>,
  totals: Map<number, WholeTrail>,
  places: Map<number, TrailPlace>,
  at: string,
  store: FoldStore,
): Promise<void> {
  const inside = new Set(ids.map(Number))
  const outside = new Set<number>()
  for (const [piece, was] of before) {
    if (!inside.has(was.partOf) && folds.get(piece) !== was.partOf)
      outside.add(was.partOf)
  }

  const current = await store.sql`
    SELECT trail_id, distance, elevation, pieces, difficulty, country, latitude, longitude FROM trail_totals
    WHERE trail_id IN (SELECT value FROM json_each(${list}))
  ` as Array<{ trail_id: number, distance: number, elevation: number | null, pieces: number, difficulty: string | null } & TrailPlace>
  const now = new Map(current.map(row => [Number(row.trail_id), row]))

  const gone = [...[...now.keys()].filter(id => !totals.has(id)), ...outside]
  if (gone.length > 0)
    await store.sql`DELETE FROM trail_totals WHERE trail_id IN (SELECT value FROM json_each(${idList(gone)}))`

  for (const [trailId, whole] of totals) {
    const place = places.get(trailId) ?? NOWHERE
    const was = now.get(trailId)
    if (was && Number(was.distance) === whole.distance && (was.elevation ?? null) === whole.elevation
      && Number(was.pieces) === whole.pieces && (was.difficulty ?? null) === whole.difficulty
      && (was.country ?? null) === place.country
      && (was.latitude ?? null) === place.latitude && (was.longitude ?? null) === place.longitude)
      continue
    await writeTotal(trailId, whole, place, at, store)
  }
}

async function writeTotal(trailId: number, whole: WholeTrail, place: TrailPlace, at: string, store: FoldStore): Promise<void> {
  await store.sql`
    INSERT INTO trail_totals (trail_id, distance, elevation, pieces, difficulty, country, latitude, longitude, computed_at)
    VALUES (${trailId}, ${whole.distance}, ${whole.elevation}, ${whole.pieces}, ${whole.difficulty}, ${place.country}, ${place.latitude}, ${place.longitude}, ${at})
    ON CONFLICT(trail_id) DO UPDATE SET
      distance = excluded.distance, elevation = excluded.elevation, pieces = excluded.pieces,
      difficulty = excluded.difficulty, country = excluded.country, latitude = excluded.latitude, longitude = excluded.longitude,
      computed_at = excluded.computed_at
  `
}

/**
 * The whole trail of each kept row in `folds`, from rows already read.
 *
 * A piece and the row it folds into always share a name, so the rows of the
 * names just decided hold every piece of every trail they keep.
 */
export function totalsOf(folds: Map<number, number>, members: Map<number, WholeTrailMember>): Map<number, WholeTrail> {
  const piecesOf = new Map<number, WholeTrailMember[]>()
  for (const [piece, partOf] of folds) {
    const member = members.get(piece)
    if (!member)
      continue
    const group = piecesOf.get(partOf)
    if (group)
      group.push(member)
    else piecesOf.set(partOf, [member])
  }

  const totals = new Map<number, WholeTrail>()
  for (const [partOf, pieces] of piecesOf) {
    const kept = members.get(partOf)
    if (kept)
      totals.set(partOf, wholeTrail(kept, pieces))
  }
  return totals
}

export interface FoldNamesOutcome extends FoldWrite {
  names: number
  rows: number
  /** Names left alone for having more rows than the bound. */
  skipped: number
  /** Every decision made, piece → the trail it is part of. */
  folds: Map<number, number>
  /** The whole trail of every row that keeps pieces. */
  totals: Map<number, WholeTrail>
}

export interface FoldNamesOptions {
  maxRows?: number
  dryRun?: boolean
  at?: string
  progress?: { afterName: string, passed: boolean }
}

/**
 * Decide and write a set of names.
 *
 * Reads them one at a time — each through the name index — decides each on
 * its own, and writes once. With `dryRun` it decides and writes nothing.
 */
export async function foldNames(names: string[], options: FoldNamesOptions = {}, store: FoldStore = ormStore): Promise<FoldNamesOutcome> {
  const maxRows = options.maxRows ?? MAX_NAME_ROWS
  const at = options.at ?? new Date().toISOString()
  const unique = [...new Set(names.map(name => String(name ?? '')).filter(name => name.trim() !== ''))]

  const folds = new Map<number, number>()
  const countryOf = new Map<number, string | null>()
  const totals = new Map<number, WholeTrail>()
  const places = new Map<number, TrailPlace>()
  const ids: number[] = []
  let skipped = 0

  for (const name of unique) {
    const group = await readNameGroup(name, store)
    if (group.ids.length > maxRows) {
      skipped++
      continue
    }
    // Each name on its own, never together with whatever else shares the
    // batch: "Mesa trail" beside "Mesa Trail" would otherwise be decided
    // together in one batch and apart in the next.
    const decided = foldPieces(group.candidates)
    for (const [piece, partOf] of decided)
      folds.set(piece, partOf)
    for (const candidate of group.candidates)
      countryOf.set(candidate.id, candidate.country ?? null)
    // Each kept row's whole length, from the lines just read for the
    // decision, so the totals are written with the pieces they add up.
    for (const [trailId, whole] of totalsOf(decided, group.members)) {
      totals.set(trailId, whole)
      places.set(trailId, group.places.get(trailId) ?? NOWHERE)
    }
    ids.push(...group.ids)
  }

  const written = options.dryRun
    ? { folded: 0, unfolded: 0 }
    : await writeFolds(ids, folds, at, { countryOf, progress: options.progress, totals, places }, store)

  return { ...written, names: unique.length, rows: ids.length, skipped, folds, totals }
}

/**
 * Fold the names the ingest just wrote. Never throws: a trail listed twice
 * for another night is a far better outcome than a shard that fails over it.
 */
export async function foldWrittenNames(names: string[], store: FoldStore = ormStore): Promise<void> {
  try {
    await foldNames(names, { maxRows: INGEST_MAX_NAME_ROWS }, store)
  }
  catch (error) {
    console.warn(`[ingest] folding fragments failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * List again every piece whose decision no longer holds on its face: the
 * piece or its trail is gone, the two no longer share a name — a re-sync
 * renamed one of them — or the piece has moved country, which the catalog's
 * count reads from here. The next pass over the name decides it afresh.
 *
 * Reads `trail_parts` and, for each piece, the two rows' names and the
 * piece's country. Pieces are short rows, so this is a quick read however
 * many there are.
 */
export async function releaseStaleFolds(store: FoldStore = ormStore): Promise<number> {
  return store.transaction(async () => {
    const stale = await store.sql`
      SELECT p.trail_id, p.part_of FROM trail_parts p
      LEFT JOIN trails t ON t.id = p.trail_id
      LEFT JOIN trails c ON c.id = p.part_of
      WHERE t.id IS NULL OR c.id IS NULL OR t.name IS NOT c.name OR p.country IS NOT t.country
    ` as Array<{ trail_id: number, part_of: number }>
    const ids = stale.map(row => Number(row.trail_id))
    if (ids.length > 0)
      await store.sql`DELETE FROM trail_parts WHERE trail_id IN (SELECT value FROM json_each(${idList(ids)}))`

    // A trail that lost a piece here has a total that counts it. Dropped
    // with the total of every trail left with no pieces at all — whose rows
    // went some other way, a deleted trail among them — and filled again
    // from what is left by `fillWholeTrails`.
    const losers = [...new Set(stale.map(row => Number(row.part_of)).filter(id => id > 0))]
    if (losers.length > 0)
      await store.sql`DELETE FROM trail_totals WHERE trail_id IN (SELECT value FROM json_each(${idList(losers)}))`
    await store.sql`DELETE FROM trail_totals WHERE trail_id NOT IN (SELECT part_of FROM trail_parts)`
    return ids.length
  })
}

/** Where the nightly walk is up to: the last name it decided, '' to start over. */
export async function foldProgress(store: FoldStore = ormStore): Promise<{ afterName: string, passes: number }> {
  const rows = await store.sql`SELECT after_name, passes FROM trail_fold_progress WHERE id = 1` as Array<{ after_name: string, passes: number }>
  return { afterName: String(rows[0]?.after_name ?? ''), passes: Number(rows[0]?.passes ?? 0) }
}

/**
 * The next names shared by more than one row, after `afterName` in name order.
 *
 * A walk along `trails_name_index`, which holds every name: grouping it reads
 * only the index, and the LIMIT stops the walk as soon as enough shared names
 * are found. A name on one row only cannot be a piece of anything.
 */
export async function nextSharedNames(afterName: string, limit: number, store: FoldStore = ormStore): Promise<string[]> {
  const rows = await store.sql`
    SELECT name FROM trails
    WHERE name > ${afterName}
    GROUP BY name
    HAVING COUNT(*) > 1
    ORDER BY name
    LIMIT ${limit}
  ` as Array<{ name: string }>
  return rows.map(row => String(row.name))
}

export interface FillOutcome {
  /** Trails whose whole length was worked out and written. */
  filled: number
  /** Whether every trail with pieces now has a total. */
  done: boolean
}

/**
 * Work out the whole length of trails that keep pieces and have no total yet.
 *
 * The walk writes a trail's total whenever it decides the trail's name, but a
 * pass over every shared name takes several nights, and a trail can lose its
 * total in between (`writeTotals`, `releaseStaleFolds`). This fills those,
 * every trail folded before `trail_totals` existed, and every total written
 * before it carried a grade (migration 0000000203), a batch at a time: the
 * kept rows in id order through `trail_parts_part_of_index`, each batch read
 * first and written in one short transaction. What it is up to needs no
 * record of its own, because a filled trail is no longer missing; a run
 * stopped anywhere carries on with the next one.
 *
 * Up to `limit` trails, 0 for all of them.
 */
export async function fillWholeTrails(
  options: { limit?: number, batch?: number, at?: string } = {},
  store: FoldStore = ormStore,
): Promise<FillOutcome> {
  const limit = Math.max(0, Number(options.limit ?? 0) || 0)
  const batch = Math.max(1, Number(options.batch ?? 200) || 200)
  const at = options.at ?? new Date().toISOString()

  let filled = 0
  let after = 0
  while (limit === 0 || filled < limit) {
    const take = limit > 0 ? Math.min(batch, limit - filled) : batch
    const missing = await store.sql`
      SELECT DISTINCT part_of FROM trail_parts
      WHERE part_of > ${after}
        AND NOT EXISTS (SELECT 1 FROM trail_totals WHERE trail_id = part_of AND difficulty IS NOT NULL)
      ORDER BY part_of
      LIMIT ${take}
    ` as Array<{ part_of: number }>
    const keptIds = missing.map(row => Number(row.part_of))
    if (keptIds.length === 0)
      return { filled, done: true }
    after = keptIds[keptIds.length - 1]

    const list = idList(keptIds)
    const kept = await store.sql`
      SELECT id, distance, elevation, elevation_checked_at, difficulty, geometry, country, latitude, longitude FROM trails
      WHERE id IN (SELECT value FROM json_each(${list}))
    ` as Array<LengthRow & TrailPlace>
    const pieces = await store.sql`
      SELECT p.part_of, t.id, t.distance, t.elevation, t.elevation_checked_at, t.geometry
      FROM trail_parts p JOIN trails t ON t.id = p.trail_id
      WHERE p.part_of IN (SELECT value FROM json_each(${list}))
    ` as Array<LengthRow & { part_of: number }>

    const piecesOf = new Map<number, WholeTrailMember[]>()
    for (const row of pieces) {
      const group = piecesOf.get(Number(row.part_of))
      if (group)
        group.push(memberOf(row))
      else piecesOf.set(Number(row.part_of), [memberOf(row)])
    }

    // A trail_parts row whose trail is gone has no kept row to total, and
    // is left to `releaseStaleFolds`.
    const written = kept
      .filter(row => piecesOf.has(Number(row.id)))
      .map(row => ({ id: Number(row.id), place: placeOf(row), whole: wholeTrail(memberOf(row), piecesOf.get(Number(row.id)) ?? []) }))

    await store.transaction(async () => {
      for (const { id, place, whole } of written)
        await writeTotal(id, whole, place, at, store)
    })
    filled += written.length

    if (keptIds.length < take)
      return { filled, done: true }
  }
  return { filled, done: false }
}
