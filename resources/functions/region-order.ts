/**
 * The order the Region list reads in.
 *
 * Biggest first is a fine answer for somebody with no location, and a useless
 * one for somebody in Santa Monica: California sits among a hundred regions
 * sorted by how many trails each has, below states on the other side of the
 * country. With a location — a GPS fix, a searched town, or the edge's guess
 * from the request's network — the nearest regions come first and each says
 * how far away it is.
 */

import { haversineDistance } from './geo'

export interface RegionRow {
  code: string
  name: string
  country: string
  count: number
  lat?: number | null
  lng?: number | null
}

export interface Origin {
  lat: number
  lng: number
}

export interface OrderedRegion extends RegionRow {
  /** Miles from the origin to the middle of the region's trails, when known. */
  miles: number | null
}

const METERS_PER_MILE = 1609.344

function hasCenter(row: RegionRow): row is RegionRow & { lat: number, lng: number } {
  return typeof row.lat === 'number' && Number.isFinite(row.lat)
    && typeof row.lng === 'number' && Number.isFinite(row.lng)
}

/**
 * Nearest first when there is an origin, biggest first otherwise. A region
 * with no known centre keeps its place after every region that has one, still
 * biggest first, so it is listed rather than dropped.
 */
export function orderRegions(rows: RegionRow[], origin: Origin | null | undefined): OrderedRegion[] {
  const valid = origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng) ? origin : null
  const withMiles = rows.map(row => ({
    ...row,
    miles: valid && hasCenter(row) ? haversineDistance(valid, { lat: row.lat, lng: row.lng }) / METERS_PER_MILE : null,
  }))

  return withMiles.sort((a, b) => {
    if (a.miles !== null && b.miles !== null)
      return a.miles - b.miles
    if (a.miles !== null)
      return -1
    if (b.miles !== null)
      return 1
    return b.count - a.count
  })
}

/**
 * "340 mi", "2,400 mi". The closest region reads as "Nearest" instead: its
 * trails' centre can be a hundred miles from somebody standing inside it, and
 * "96 mi" next to the state you are in reads as wrong.
 */
export function regionDistanceLabel(miles: number | null, isNearest = false): string {
  if (miles === null || !Number.isFinite(miles))
    return ''
  if (isNearest && miles < 150)
    return 'Nearest'
  return `${Math.round(miles).toLocaleString('en-US')} mi`
}
