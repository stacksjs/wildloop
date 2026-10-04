import type { FragmentCandidate } from './trailFragments'
import { db } from '@stacksjs/orm'
import { decodeRouteParts } from '../../resources/functions/trail-geometry'
import { foldPieces } from './trailFragments'
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
    SELECT id, name, country, source, distance, review_count, latitude, longitude, geometry
    FROM trails
    WHERE name = ${name}
  ` as GroupRow[]

  const ids = rows.map(row => Number(row.id))
  const photos = await photoCounts(ids, store)

  const candidates = rows.map(row => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    country: row.country,
    source: row.source,
    distance: Number(row.distance ?? 0),
    reviewCount: Number(row.review_count ?? 0),
    photos: photos.get(Number(row.id)) ?? 0,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    // Only where a row starts and ends decides anything, so a line stored in
    // several parts is read end to end.
    geometry: decodeRouteParts(row.geometry).flat().map(([lat, lng]) => ({ lat, lng })),
  }))

  return { name, candidates, ids }
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
  } = {},
  store: FoldStore = ormStore,
): Promise<FoldWrite> {
  const { countryOf, progress } = options
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

export interface FoldNamesOutcome extends FoldWrite {
  names: number
  rows: number
  /** Names left alone for having more rows than the bound. */
  skipped: number
  /** Every decision made, piece → the trail it is part of. */
  folds: Map<number, number>
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
    for (const [piece, partOf] of foldPieces(group.candidates))
      folds.set(piece, partOf)
    for (const candidate of group.candidates)
      countryOf.set(candidate.id, candidate.country ?? null)
    ids.push(...group.ids)
  }

  const written = options.dryRun
    ? { folded: 0, unfolded: 0 }
    : await writeFolds(ids, folds, at, { countryOf, progress: options.progress }, store)

  return { ...written, names: unique.length, rows: ids.length, skipped, folds }
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
      SELECT p.trail_id FROM trail_parts p
      LEFT JOIN trails t ON t.id = p.trail_id
      LEFT JOIN trails c ON c.id = p.part_of
      WHERE t.id IS NULL OR c.id IS NULL OR t.name IS NOT c.name OR p.country IS NOT t.country
    ` as Array<{ trail_id: number }>
    const ids = stale.map(row => Number(row.trail_id))
    if (ids.length > 0)
      await store.sql`DELETE FROM trail_parts WHERE trail_id IN (SELECT value FROM json_each(${idList(ids)}))`
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
