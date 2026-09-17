/**
 * The single shape every trail source normalizes into.
 *
 * Three very different upstreams feed this table — OSM tags, a Forest Service
 * ArcGIS layer and a Park Service one — and they agree on almost nothing. This
 * interface is the contract that lets `ingest.ts` treat them identically: a
 * source's only job is to produce these, and the writer's only job is to
 * upsert them.
 *
 * Units are the ones the app displays, decided here rather than in the UI so
 * every row in the table is directly comparable: miles and feet.
 */

export type TrailSource = 'osm' | 'usfs' | 'nps'
export type TrailDifficulty = 'easy' | 'moderate' | 'hard'
export type TrailRouteType = 'loop' | 'out-and-back' | 'point-to-point' | 'network'

export interface NormalizedTrail {
  // Provenance
  source: TrailSource
  /** Upstream primary key, unique within `source`. */
  sourceId: string
  sourceUrl: string

  // Identity
  name: string
  /** Human-readable place, e.g. `Pike National Forest, CO`. */
  location: string
  description: string

  // Geography
  latitude: number
  longitude: number
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
  /** ISO 3166-1 alpha-2: `US`, `DE`, `AT`, `CH`. */
  country: string
  /** USPS code for US states, ISO 3166-2 elsewhere. Unique only within `country`. */
  state: string
  stateName: string
  managedBy: string

  // Route
  /** Miles. */
  distance: number
  /** Cumulative ascent in feet where known, else 0. */
  elevation: number
  /** Highest point in feet where known, else 0. */
  elevationHigh: number
  difficulty: TrailDifficulty
  routeType: TrailRouteType
  surface: string
  estimatedTime: string
  /** JSON `[[lat,lng],…]`, simplified for storage and map rendering. */
  geometry: string

  // Access
  allowedUses: string
  /**
   * Whether dogs are permitted, or null when the source does not say. Null is
   * the common case, and it must stay distinct from false: the trail page shows
   * a "No dogs" notice for false.
   */
  dogsAllowed: boolean | null
  wheelchairAccessible: boolean
  nationalTrail: boolean

  // Presentation
  image: string
  tags: string
}

/** What one shard of work produced, for the checkpoint row and the CLI. */
export interface SourceFetchResult {
  trails: NormalizedTrail[]
  /** Features seen upstream before normalization dropped any. */
  seen: number
}

/**
 * A unit of ingest work small enough to finish, retry and record on its own.
 *
 * OSM is tiled geographically (Overpass times out on anything larger); the
 * ArcGIS sources are paged by result offset. Both collapse to "a key and an
 * opaque cursor" so the checkpoint table does not need to know the difference.
 */
export interface Shard {
  source: TrailSource
  /** Stable identifier, unique within the source. Doubles as the cache key. */
  key: string
  /** Source-specific payload: a bbox for OSM, an offset for ArcGIS. */
  cursor: Record<string, number | string>
}

export interface TrailSourceAdapter {
  readonly source: TrailSource
  /** Enumerate every shard needed to cover the US. Must be deterministic. */
  shards: () => Promise<Shard[]> | Shard[]
  /** Fetch and normalize one shard. Throwing marks the shard failed and retryable. */
  fetch: (shard: Shard) => Promise<SourceFetchResult>
}
