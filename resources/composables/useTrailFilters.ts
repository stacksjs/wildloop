/**
 * The filter set the trail catalog is browsed with.
 *
 * Kept as plain data and pure functions rather than signals: the page owns the
 * state, and what lives here is the part worth testing — which buckets exist,
 * what each one means in miles and feet, and how a filter set becomes a
 * catalog query. Every filter resolves to a server-side predicate, because the
 * page holds sixty rows of a table with hundreds of thousands in it and
 * filtering what happens to be on screen would answer a different question.
 */

import type { TrailQuery } from './useTrailCatalog'

/** A named range. An open end means "no bound in that direction". */
export interface FilterBucket {
  id: string
  label: string
  min?: number
  max?: number
}

/** Miles. The break points are where a walk turns into a day and then a trip. */
export const LENGTH_BUCKETS: FilterBucket[] = [
  { id: 'any', label: 'Any length' },
  { id: 'under-2', label: 'Under 2 mi', max: 2 },
  { id: '2-5', label: '2 – 5 mi', min: 2, max: 5 },
  { id: '5-10', label: '5 – 10 mi', min: 5, max: 10 },
  { id: '10-30', label: '10 – 30 mi', min: 10, max: 30 },
  { id: 'over-30', label: 'Over 30 mi', min: 30 },
]

/** Feet of ascent. */
export const ELEVATION_BUCKETS: FilterBucket[] = [
  { id: 'any', label: 'Any elevation gain' },
  { id: 'under-500', label: 'Under 500 ft', max: 500 },
  { id: '500-1000', label: '500 – 1,000 ft', min: 500, max: 1000 },
  { id: '1000-2500', label: '1,000 – 2,500 ft', min: 1000, max: 2500 },
  { id: 'over-2500', label: 'Over 2,500 ft', min: 2500 },
]

export const DIFFICULTY_OPTIONS = [
  { id: 'all', label: 'Any difficulty' },
  { id: 'easy', label: 'Easy' },
  { id: 'moderate', label: 'Moderate' },
  { id: 'hard', label: 'Hard' },
] as const

export const ROUTE_TYPE_OPTIONS = [
  { id: 'all', label: 'Any route' },
  { id: 'loop', label: 'Loop' },
  { id: 'out-and-back', label: 'Out & back' },
  { id: 'point-to-point', label: 'Point to point' },
] as const

export const RATING_OPTIONS = [
  { id: 0, label: 'Any rating' },
  { id: 3, label: '3.0+' },
  { id: 4, label: '4.0+' },
  { id: 4.5, label: '4.5+' },
] as const

export const SORT_OPTIONS = [
  { id: 'featured', label: 'Best match' },
  { id: 'rating', label: 'Top rated' },
  { id: 'longest', label: 'Longest' },
  { id: 'distance', label: 'Shortest' },
  { id: 'name', label: 'Name (A–Z)' },
] as const

export interface TrailFilters {
  difficulty: string
  /** A `LENGTH_BUCKETS` id. */
  length: string
  /** An `ELEVATION_BUCKETS` id. */
  elevation: string
  routeType: string
  /** Minimum star rating. 0 means no bound. */
  rating: number
  dogsAllowed: boolean
  accessible: boolean
  nationalTrail: boolean
}

export function emptyFilters(): TrailFilters {
  return {
    difficulty: 'all',
    length: 'any',
    elevation: 'any',
    routeType: 'all',
    rating: 0,
    dogsAllowed: false,
    accessible: false,
    nationalTrail: false,
  }
}

export function findBucket(buckets: FilterBucket[], id: string): FilterBucket | null {
  return buckets.find(bucket => bucket.id === id) ?? null
}

/**
 * What a filter chip reads as: the chosen value, or the control's own name
 * while nothing is chosen. A chip that always reads "Length" gives no way to
 * see what the list is currently filtered by without opening it.
 */
export function bucketChipLabel(buckets: FilterBucket[], id: string, fallback: string): string {
  const bucket = findBucket(buckets, id)
  return !bucket || bucket.id === 'any' ? fallback : bucket.label
}

/** How many filters are doing something, for the badge on the "Filters" chip. */
export function activeFilterCount(filters: TrailFilters): number {
  let count = 0
  if (filters.difficulty !== 'all')
    count++
  if (filters.length !== 'any')
    count++
  if (filters.elevation !== 'any')
    count++
  if (filters.routeType !== 'all')
    count++
  if (filters.rating > 0)
    count++
  if (filters.dogsAllowed)
    count++
  if (filters.accessible)
    count++
  if (filters.nationalTrail)
    count++
  return count
}

export function hasActiveFilters(filters: TrailFilters): boolean {
  return activeFilterCount(filters) > 0
}

/**
 * A filter set as catalog query parameters.
 *
 * Only what is set is emitted: an "any" bucket contributes no bound at all,
 * rather than a `0`-to-`Infinity` pair the API would have to interpret.
 */
export function filtersToQuery(filters: TrailFilters): Partial<TrailQuery> {
  const query: Partial<TrailQuery> = {}

  if (filters.difficulty && filters.difficulty !== 'all')
    query.difficulty = filters.difficulty
  if (filters.routeType && filters.routeType !== 'all')
    query.routeType = filters.routeType

  const length = findBucket(LENGTH_BUCKETS, filters.length)
  if (length?.min !== undefined)
    query.minDistance = length.min
  if (length?.max !== undefined)
    query.maxDistance = length.max

  const elevation = findBucket(ELEVATION_BUCKETS, filters.elevation)
  if (elevation?.min !== undefined)
    query.minElevation = elevation.min
  if (elevation?.max !== undefined)
    query.maxElevation = elevation.max

  if (filters.rating > 0)
    query.minRating = filters.rating
  if (filters.dogsAllowed)
    query.dogsAllowed = true
  if (filters.accessible)
    query.accessible = true
  if (filters.nationalTrail)
    query.nationalTrail = true

  return query
}

/**
 * Read a filter set out of a URL's query string, so a shared link opens the
 * list somebody was actually looking at. Unknown values fall back to "any"
 * rather than filtering to nothing.
 */
export function filtersFromQuery(query: Record<string, unknown>): TrailFilters {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const filters = emptyFilters()

  const difficulty = text(query.difficulty)
  if (DIFFICULTY_OPTIONS.some(option => option.id === difficulty))
    filters.difficulty = difficulty

  const routeType = text(query.routeType) || text(query.route_type)
  if (ROUTE_TYPE_OPTIONS.some(option => option.id === routeType))
    filters.routeType = routeType

  const length = text(query.length)
  if (findBucket(LENGTH_BUCKETS, length))
    filters.length = length

  const elevation = text(query.elevation)
  if (findBucket(ELEVATION_BUCKETS, elevation))
    filters.elevation = elevation

  const rating = Number(query.rating)
  if (RATING_OPTIONS.some(option => option.id === rating))
    filters.rating = rating

  filters.dogsAllowed = text(query.dogs) === 'true'
  filters.accessible = text(query.accessible) === 'true'
  filters.nationalTrail = text(query.nationalTrail) === 'true'

  return filters
}
