/*
 * The band a trail's length puts it in, lowest first.
 *
 * The catalog is imported from OpenStreetMap, where a "way" is whatever a
 * mapper drew between two junctions — so most rows are not trails anybody
 * would set out to walk. A representative slice of production is 57% under
 * four tenths of a mile and has a median length of 0.32 miles.
 *
 * That is why the list used to open on the longest routes: it was the only
 * ordering that kept quarter-mile path stubs off the first screen. It bought
 * that at the cost of opening on thousand-mile thru-hikes instead, which is
 * the opposite extreme of the same mistake.
 *
 * Banding asks the question directly. A day hike comes first, then things
 * that are plausibly a walk or an expedition, then fragments and epics
 * together at the back.
 *
 * `browse_band` is a generated column, defined in migration 0000000175,
 * rather than a CASE in the ORDER BY: ordering half a million rows by an
 * expression cannot use an index, and the ORM query builder offers no raw
 * ordering anyway. Nothing writes it — it is a function of distance, so
 * imports get it for free.
 */

/**
 * The order the trail catalog opens on, when nobody has said where they are.
 *
 * Day hikes first (`browse_band`, a generated column of distance, migration
 * 0000000175), then ratings and reviews, which order nothing while the
 * catalog has none and take over the day it does, then national trails, then
 * the longer walk within a band, and id last so two pages of one list never
 * disagree about which trail is 60th.
 *
 * Shared by `TrailIndexAction`, which sorts by it, and the test that holds
 * `trails_browse_order_index` and `trails_country_browse_order_index`
 * (migration 0000000199) to it: the first page is only quick while an index
 * holds exactly these columns in exactly these directions.
 */
export const FEATURED_ORDER: ReadonlyArray<readonly [string, 'asc' | 'desc']> = [
  ['browse_band', 'asc'],
  ['rating', 'desc'],
  ['review_count', 'desc'],
  ['national_trail', 'desc'],
  // Within a day-hike length, the longer walk is the bigger day out. Below
  // the band this would surface epics, which is why it comes after the
  // banding rather than instead of it.
  ['distance', 'desc'],
  // Stable: two pages of the same list must not disagree about which trail
  // is 60th, or paging repeats and skips rows. The rowid every index ends
  // on, so it costs the index nothing.
  ['id', 'asc'],
]

/**
 * Top rated, when nobody has said where they are.
 *
 * Rating, then how many reviews it stands on, and once the ratings run out
 * the same day-hike-first length order as `FEATURED_ORDER`, rather than
 * whatever order the table happens to be in, which is what it is today at
 * 0% rated. id last, as above.
 *
 * Held to `trails_rating_order_index` and `trails_country_rating_order_index`
 * (migration 0000000202) by the same test as the featured order.
 */
export const RATING_ORDER: ReadonlyArray<readonly [string, 'asc' | 'desc']> = [
  ['rating', 'desc'],
  ['review_count', 'desc'],
  ['browse_band', 'asc'],
  ['distance', 'desc'],
  ['id', 'asc'],
]

/**
 * Popular, when nobody has said where they are.
 *
 * Without a location there is no "near" to break ties with, so it is reviews,
 * then rating, then the same day-hike-first order as the default. Nearby,
 * popular also weighs views and activities, which no column of `trails`
 * holds, and is ranked in `trailRanking.ts` from the rows in the box instead.
 *
 * Held to `trails_popular_order_index` and `trails_country_popular_order_index`
 * (migration 0000000202).
 */
export const POPULAR_ORDER: ReadonlyArray<readonly [string, 'asc' | 'desc']> = [
  ['review_count', 'desc'],
  ['rating', 'desc'],
  ['browse_band', 'asc'],
  ['distance', 'desc'],
  ['id', 'asc'],
]

/**
 * A to Z. `trails_name_index` walks it everywhere and
 * `trails_country_name_index` (migration 0000000202) for one country. id
 * last, so the many trails that share a name page in one order.
 */
export const NAME_ORDER: ReadonlyArray<readonly [string, 'asc' | 'desc']> = [
  ['name', 'asc'],
  ['id', 'asc'],
]
