/**
 * The trail catalog, as both the website and the native screen read it.
 *
 * The web page has nine filters, a radius search, offline downloads and
 * reviewer faces; the native screen has a search box and a list. They diverge
 * on all of that and on none of the numbers: one path builder, one normalizer,
 * one answer for what a trail's line looks like.
 *
 * `trailsPath` builds its query with `encodeURIComponent` rather than
 * `URLSearchParams`. A native screen runs in JavaScriptCore with the language
 * intrinsics and what the runtime assigns — nothing assigns `URLSearchParams`,
 * so a shared module that reaches for it makes the screen issue no request at
 * all while passing every browser test (stacksjs/stx#2068's neighbour, and a
 * mistake already made once here in `leaderboardQuery`).
 *
 * @module functions/trails
 */

import type { LatLng, UiTrail } from '../assets/scripts/trail-data'
import { normalizeTrailsPayload } from '../assets/scripts/trail-data'
import { routeShapeFor } from './route-shape'
import { shareableCoordinate } from './shared-origin'
import { routeTypeLabel } from './trail-features'

export interface TrailsQuery {
  /** Free text: name, park, forest or region. */
  q?: string
  country?: string
  state?: string
  difficulty?: string
  routeType?: string
  sort?: string
  /** Miles. A length bucket from the web page's filter bar. */
  minDistance?: number
  maxDistance?: number
  /** Feet of ascent. */
  minElevation?: number
  maxElevation?: number
  /** Stars, 0-5. Only trails rated at least this highly. */
  minRating?: number
  dogsAllowed?: boolean
  accessible?: boolean
  nationalTrail?: boolean
  /** Centre of a "near me" search. Paired with `lng`; the API ignores one alone. */
  lat?: number
  lng?: number
  /** Miles around `lat`/`lng`. The API defaults this when omitted. */
  radius?: number
  limit?: number
  offset?: number
}

/** The rows a list screen shows, with each trail's line beside them. */
export interface TrailRows {
  rows: UiTrail[]
  /** Trail id to its main line, for the ones the catalog holds a line for. */
  routeById: Record<number, LatLng[]>
  total: number
  hasMore: boolean
}

/*
 * What the website has always asked for, kept as the default so moving its
 * query in here changed nothing about what it fetches. The native screen asks
 * for a smaller page explicitly.
 */
const DEFAULT_LIMIT = 60

/**
 * `/api/trails?…`, with only the parameters that carry a value.
 *
 * Every caller comes through here — the website's nine filters and radius
 * search as well as the native screen's search box — so the two cannot ask the
 * same question two ways. `all` is how the filter UI says "no filter", and the
 * API reads an absent parameter the same way, so it is dropped rather than
 * sent.
 */
export function trailsPath(query: TrailsQuery = {}): string {
  const parts: string[] = []
  const add = (key: string, value: string | number | boolean): void => {
    parts.push(`${key}=${encodeURIComponent(String(value))}`)
  }
  const addNumber = (key: string, value: unknown): void => {
    if (Number.isFinite(value))
      add(key, Number(value))
  }

  const q = (query.q ?? '').trim()
  if (q)
    add('q', q)
  if (query.country)
    add('country', query.country)
  if (query.state)
    add('state', query.state)
  if (query.difficulty && query.difficulty !== 'all')
    add('difficulty', query.difficulty)
  if (query.routeType && query.routeType !== 'all')
    add('routeType', query.routeType)
  if (query.sort)
    add('sort', query.sort)

  addNumber('minDistance', query.minDistance)
  addNumber('maxDistance', query.maxDistance)
  addNumber('minElevation', query.minElevation)
  addNumber('maxElevation', query.maxElevation)
  if (Number.isFinite(query.minRating) && Number(query.minRating) > 0)
    add('minRating', Number(query.minRating))

  if (query.dogsAllowed)
    add('dogsAllowed', 'true')
  if (query.accessible)
    add('accessible', 'true')
  if (query.nationalTrail)
    add('nationalTrail', 'true')

  /*
   * Rounded so a neighbourhood shares one cached answer at the edge. The
   * caller puts the precise distances back from the real point — see
   * `resources/functions/shared-origin.ts`.
   */
  if (Number.isFinite(query.lat) && Number.isFinite(query.lng)) {
    add('lat', shareableCoordinate(Number(query.lat)))
    add('lng', shareableCoordinate(Number(query.lng)))
    if (query.radius)
      add('radius', query.radius)
  }

  add('limit', Number.isFinite(query.limit) ? Number(query.limit) : DEFAULT_LIMIT)
  add('offset', Number.isFinite(query.offset) && Number(query.offset) > 0 ? Number(query.offset) : 0)

  return `/api/trails?${parts.join('&')}`
}

/** The payload of `trailsPath`, as rows. */
export function trailRowsFrom(payload: unknown): TrailRows {
  const { trails, geometryById } = normalizeTrailsPayload(payload)
  const meta = (payload as { meta?: Record<string, unknown> } | null)?.meta ?? {}
  const total = Number(meta.total)

  return {
    rows: trails,
    routeById: geometryById,
    total: Number.isFinite(total) && total > 0 ? total : trails.length,
    hasMore: meta.hasMore === true,
  }
}

/** Miles, as a card shows them: one decimal, and never a trailing `.0`. */
export function trailDistanceText(miles: unknown): string {
  const value = Number(miles)
  if (!Number.isFinite(value) || value <= 0)
    return ''
  const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
  return `${text} mi`
}

/** Feet of ascent, thousands separated. Empty when none is on record — which
 * is not the same as zero, and is why the grade may be an estimate. */
export function trailAscentText(feet: unknown): string {
  const value = Number(feet)
  if (!Number.isFinite(value) || value <= 0)
    return ''
  return `${Math.round(value).toLocaleString('en-US')} ft`
}

/**
 * Distance, ascent and route type on one line.
 *
 * The web card spreads these across three badges with icons, which is right
 * where there is room for icons. A phone row has one line, so the parts are
 * joined — the same numbers, read out rather than laid out.
 */
export function trailStatsLine(trail: Partial<UiTrail> | null | undefined): string {
  if (!trail)
    return ''
  const parts = [
    trailDistanceText(trail.distance),
    trailAscentText(trail.elevation),
    routeTypeLabel(trail.routeType),
  ].filter(part => part !== '')
  return parts.join(' · ')
}

/**
 * Where the trail is, as specifically as the row allows.
 *
 * `location` is already "Park, Region" for most rows; `managedBy` is the park
 * or forest that administers it and is the more useful half when both exist.
 * Never both, because on a phone the second one wraps.
 */
export function trailPlaceLine(trail: Partial<UiTrail> | null | undefined): string {
  const location = (trail?.location ?? '').trim()
  if (location)
    return location
  const managed = (trail?.managedBy ?? '').trim()
  if (managed)
    return managed
  return (trail?.stateName ?? '').trim()
}

/** The route box a native row draws, in the viewBox the screen declares. */
export const TRAIL_ROUTE_BOX = { width: 96, height: 64, pad: 8 } as const

/**
 * A trail's line as `points` for an SVG polyline, or '' when the catalog holds
 * no line for it.
 *
 * The native screen draws the route rather than a photo, for the same reason
 * the web card falls back to it: the line is the one thing on the row that is
 * actually this trail. It is bound as `:points`, which the native compiler
 * carries through as geometry — unlike `:geometry` on a `MapPolyline`, which is
 * dropped (stacksjs/stx#2073), and is why this screen draws the line instead of
 * putting it on a map.
 */
export function trailRoutePoints(line: LatLng[] | null | undefined): string {
  const shape = routeShapeFor(line, TRAIL_ROUTE_BOX.width, TRAIL_ROUTE_BOX.height, TRAIL_ROUTE_BOX.pad)
  return shape?.points ?? ''
}

/** The web page for one trail, which stays the website: it is a map. */
export function trailPath(id: number): string {
  return `/trail/${id}`
}
