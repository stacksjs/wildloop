/**
 * How much of the catalog carries the data somebody opens a trail page to read.
 *
 * #1002 measured this once, by hand, against the live API: 400 trails at
 * offsets 0, 60k, 200k and 400k. The measurement cannot be repeated, for two
 * reasons that have nothing to do with the catalog getting better or worse.
 *
 * The default ordering changed when the browse band landed, so offset 0 no
 * longer selects the same trails. And paging past roughly offset 60,000 now
 * answers 520 (#1008), so two of the four sample points cannot be fetched at
 * all. A later run produced a difficulty split of 321 hard against the
 * baseline's 69 — not because trails got harder, but because the two samples
 * were of different trails.
 *
 * So the sample here is taken by id, evenly across the whole id space, read
 * from the database rather than through the API. Ids do not move when the
 * ordering changes, the query does not get slower the further in it reaches,
 * and two runs a month apart are measuring the same thing.
 */

export interface CoverageRow {
  elevation?: number | null
  rating?: number | null
  review_count?: number | null
  image?: string | null
  dogs_allowed?: unknown
  surface?: string | null
  difficulty?: string | null
  [key: string]: unknown
}

export interface CoverageReport {
  sampled: number
  /** Field name to how many of the sampled rows carry it. */
  fields: Record<string, number>
  /** Grade to count, over the same sample. */
  difficulty: Record<string, number>
}

/**
 * The id boundaries of an even sample across the whole table.
 *
 * Evenly by id rather than randomly, so two runs sample the same rows and a
 * difference between them is a difference in the catalog. Ids are sparse —
 * trails get deleted, and the ingest leaves gaps — so these are the starting
 * points of `buckets` windows, not the ids themselves.
 */
export function sampleWindows(minId: number, maxId: number, buckets: number): number[] {
  if (!Number.isFinite(minId) || !Number.isFinite(maxId) || maxId < minId || buckets < 1)
    return []

  const span = maxId - minId
  if (span === 0)
    return [minId]

  const step = span / buckets
  return Array.from({ length: buckets }, (_, i) => Math.floor(minId + i * step))
}

/** Whether a photo is a real photograph of somewhere rather than stock filler. */
export function isRealPhoto(image: unknown, isStock: (url: string) => boolean): boolean {
  const url = String(image ?? '').trim()
  return url !== '' && !isStock(url)
}

/**
 * Count what the sampled rows carry.
 *
 * Every field is counted as present or absent on the same rule the product
 * uses: a zero elevation is absent, because the column is NOT NULL and zero is
 * what it holds for "nobody measured" (#1004).
 */
export function coverageOf(rows: CoverageRow[], isStock: (url: string) => boolean): CoverageReport {
  const fields: Record<string, number> = {
    elevation: 0,
    rating: 0,
    reviews: 0,
    realPhoto: 0,
    stockPhoto: 0,
    noPhoto: 0,
    dogsPolicy: 0,
    surface: 0,
  }
  const difficulty: Record<string, number> = {}

  for (const row of rows) {
    if (Number(row.elevation ?? 0) > 0)
      fields.elevation += 1
    if (Number(row.rating ?? 0) > 0)
      fields.rating += 1
    if (Number(row.review_count ?? 0) > 0)
      fields.reviews += 1

    const image = String(row.image ?? '').trim()
    if (isRealPhoto(image, isStock))
      fields.realPhoto += 1
    else if (image)
      fields.stockPhoto += 1
    else fields.noPhoto += 1

    if (row.dogs_allowed !== null && row.dogs_allowed !== undefined && row.dogs_allowed !== '')
      fields.dogsPolicy += 1
    if (String(row.surface ?? '').trim())
      fields.surface += 1

    const grade = String(row.difficulty ?? 'ungraded')
    difficulty[grade] = (difficulty[grade] ?? 0) + 1
  }

  return { sampled: rows.length, fields, difficulty }
}

/** `14.4%`, or `—` for an empty sample rather than a division by zero. */
export function percent(count: number, total: number): string {
  if (total <= 0)
    return '—'
  return `${((count / total) * 100).toFixed(1)}%`
}
