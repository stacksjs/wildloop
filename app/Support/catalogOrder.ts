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
