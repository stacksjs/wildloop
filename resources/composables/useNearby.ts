import { state } from 'stx'

/**
 * Where the visitor is, for the purposes of "what is good near me".
 *
 * A trail catalog is intensely local. The homepage already had a "find near
 * me" button, but the answer died with the click: reload the page, or walk
 * over to /trails, and the catalog was national again. Somebody in Los Angeles
 * had to re-explain where they were on every screen, which is why the honest
 * default became "everything, everywhere" — a list nobody can act on.
 *
 * So the location is resolved once and remembered:
 *
 *   1. A remembered answer from a previous visit (localStorage). Instant, and
 *      it survives a reload, which is what makes the catalog feel local rather
 *      than feel like it keeps forgetting.
 *   2. The edge's guess from the request's IP (`/api/geo/here`). City-accurate,
 *      costs no permission prompt, and is good enough to open a page on.
 *   3. The browser's Geolocation API — precise, but only when the visitor asks
 *      for it. A prompt on first paint is the fastest way to be told no for
 *      the rest of the session.
 *
 * A precise fix always beats a remembered coarse one; a remembered precise one
 * is never silently replaced by the edge's guess.
 */

export type NearbySource = 'gps' | 'edge'

export interface NearbyPlace {
  lat: number
  lng: number
  /** What to call this place on screen. */
  label: string
  source: NearbySource
  /** Epoch ms. Used to expire a stale coarse fix. */
  resolvedAt: number
}

const STORAGE_KEY = 'wildloop_nearby'

/**
 * How long a remembered fix is trusted.
 *
 * A precise fix is kept for a day: people do not usually move far enough for
 * "trails near me" to mean somewhere else, and re-prompting is worse than a
 * slightly stale answer. The edge's guess expires sooner, because it changes
 * whenever the network does — a phone moving from wifi to cellular can appear
 * to jump cities.
 */
const MAX_AGE: Record<NearbySource, number> = {
  gps: 24 * 60 * 60 * 1000,
  edge: 60 * 60 * 1000,
}

/** The resolved place, or null while unknown. */
export const nearby = state<NearbyPlace | null>(null)
/** True while a permission prompt or lookup is outstanding. */
export const locating = state(false)
/** Set when the visitor asked to be located and the browser refused. */
export const nearbyError = state('')

let edgeLookup: Promise<NearbyPlace | null> | null = null

function isFresh(place: NearbyPlace): boolean {
  return Date.now() - place.resolvedAt < MAX_AGE[place.source]
}

function read(): NearbyPlace | null {
  if (typeof localStorage === 'undefined')
    return null

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return null

    const parsed = JSON.parse(raw) as Partial<NearbyPlace>
    if (typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number')
      return null
    if (parsed.source !== 'gps' && parsed.source !== 'edge')
      return null

    const place: NearbyPlace = {
      lat: parsed.lat,
      lng: parsed.lng,
      label: parsed.label || 'Your area',
      source: parsed.source,
      resolvedAt: typeof parsed.resolvedAt === 'number' ? parsed.resolvedAt : 0,
    }

    return isFresh(place) ? place : null
  }
  catch {
    // A private window, or somebody else's JSON under our key. Either way the
    // page works without it.
    return null
  }
}

function write(place: NearbyPlace | null): void {
  if (typeof localStorage === 'undefined')
    return

  try {
    if (place)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(place))
    else
      localStorage.removeItem(STORAGE_KEY)
  }
  catch {
    // Storage can be full or blocked. The signal below is still set, so the
    // location works for this page view and is simply not remembered.
  }
}

function apply(place: NearbyPlace): NearbyPlace {
  nearby.set(place)
  write(place)
  return place
}

/** Ask the server where this request appears to come from. Cached per page. */
async function fromEdge(): Promise<NearbyPlace | null> {
  edgeLookup ??= (async () => {
    try {
      const res = await fetch('/api/geo/here', { headers: { Accept: 'application/json' } })
      if (!res.ok)
        return null

      const body = await res.json() as { located?: boolean, lat?: number, lng?: number, label?: string }
      if (!body?.located || typeof body.lat !== 'number' || typeof body.lng !== 'number')
        return null

      return {
        lat: body.lat,
        lng: body.lng,
        label: body.label || 'Your area',
        source: 'edge' as const,
        resolvedAt: Date.now(),
      }
    }
    catch {
      return null
    }
  })()

  return edgeLookup
}

/**
 * The best location available without asking anyone for permission.
 *
 * Safe to call on mount: it never prompts. Returns null when nothing is known,
 * which callers must render as the national catalog rather than as an error —
 * a visitor behind a VPN is not a broken page.
 */
export async function resolveNearby(): Promise<NearbyPlace | null> {
  const remembered = read()
  if (remembered) {
    nearby.set(remembered)
    return remembered
  }

  const edge = await fromEdge()
  return edge ? apply(edge) : null
}

/**
 * Ask the browser for a precise position. Prompts, so only call this from a
 * control the visitor pressed.
 */
export function locatePrecisely(): Promise<NearbyPlace | null> {
  nearbyError.set('')

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    nearbyError.set('This browser cannot share your location.')
    return Promise.resolve(null)
  }

  locating.set(true)

  return new Promise<NearbyPlace | null>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        locating.set(false)
        resolve(apply({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          // No reverse geocode: naming the place would mean sending the
          // visitor's precise coordinates to a third party to be told
          // something the page does not need. "Your location" is both true
          // and the most it has to say.
          label: 'Your location',
          source: 'gps',
          resolvedAt: Date.now(),
        }))
      },
      (error) => {
        locating.set(false)
        nearbyError.set(
          error.code === error.PERMISSION_DENIED
            ? 'Location is blocked for this site. Search by city instead.'
            : 'Could not get your location. Search by city instead.',
        )
        resolve(null)
      },
      { enableHighAccuracy: false, maximumAge: 600000, timeout: 8000 },
    )
  })
}

/** Forget the location and go back to the whole catalog. */
export function clearNearby(): void {
  nearby.set(null)
  nearbyError.set('')
  write(null)
}

/** `{ lat, lng, radius }` for a catalog query, or `{}` when there is no fix. */
export function nearbyQuery(radius = 25): { lat?: number, lng?: number, radius?: number } {
  const place = nearby()
  return place ? { lat: place.lat, lng: place.lng, radius } : {}
}
