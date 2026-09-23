import type { EventSummary, EventType } from '../assets/scripts/events-api'
import { derived, onDestroy, onMount, state } from 'stx'
import { createEvent, fetchEvents } from '../assets/scripts/events-api'
import { STANDARD_YARD_MILES, STANDARD_YARD_MINUTES } from '../functions/backyard'
import { locatePrecisely, locating, nearby, nearbyError, resolveNearby } from './useNearby'

/**
 * The events directory.
 *
 * Refreshed on a slow interval so a page left open on a laptop at the finish
 * still shows the right "still in" counts an hour later, without either the
 * viewer or a spectator having to reload.
 *
 * Closest first. An event is something you travel to, so the list is ordered
 * by distance from wherever `useNearby` thinks the visitor is — a remembered
 * fix, else the edge's guess from the IP, never a permission prompt on load.
 * Live events keep their own section at the top: a race happening now is
 * worth watching from anywhere, it is just sorted by distance within it.
 *
 * The distance work happens here in the browser rather than on the server,
 * so the visitor's position is never sent anywhere to get a local list. The
 * directory is small (hundreds of rows), and it is fetched whole.
 */

const REFRESH_MS = 30_000

/** Enough for the whole directory; the server caps a page at 200. */
const DIRECTORY_LIMIT = 200

/** Radius choices in miles. 0 is "Anywhere": sorted by distance, not cut off. */
export const EVENT_RADII = [25, 50, 100, 250, 0] as const

const EARTH_RADIUS_MILES = 3958.8

export interface EventOrigin {
  lat: number
  lng: number
}

export interface RankedEvent extends EventSummary {
  /** Miles from the visitor, or null when either end has no position. */
  distanceMiles: number | null
  /** "12 mi away", or '' when the distance is unknown. */
  distanceText: string
}

/** Great-circle distance in miles. */
export function milesBetween(a: EventOrigin, b: EventOrigin): number {
  const toRad = (deg: number) => deg * Math.PI / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** "Under 1 mi away", "12 mi away", "4,012 mi away"; '' when unknown. */
export function formatMilesAway(miles: number | null): string {
  if (miles === null || !Number.isFinite(miles))
    return ''
  if (miles < 1)
    return 'Under 1 mi away'
  return `${Math.round(miles).toLocaleString('en-US')} mi away`
}

function hasPoint(event: Pick<EventSummary, 'lat' | 'lng'>): boolean {
  return typeof event.lat === 'number' && typeof event.lng === 'number'
    && Number.isFinite(event.lat) && Number.isFinite(event.lng)
}

/** Live and upcoming are sorted by distance. Past results stay newest first. */
function sortsByDistance(status: string): boolean {
  return status === 'live' || status === 'scheduled'
}

export interface ArrangeOptions {
  origin?: EventOrigin | null
  /** Miles. 0, or no origin, means no cut-off. */
  radius?: number
  /** Matched against name, location and club, case-insensitively. */
  query?: string
}

/**
 * What the directory shows, in the order it shows it.
 *
 * Takes the server's order (live, then soonest upcoming, then most recent
 * results) and, when the visitor's position is known, re-sorts live and
 * upcoming events by distance. The sort is stable, so events the same
 * distance away — or with no position at all, which go last — keep the
 * server's soonest-first order. A radius drops events outside it, and events
 * with no position: nobody can say they are within 50 miles.
 */
export function arrangeEvents(events: EventSummary[], options: ArrangeOptions = {}): RankedEvent[] {
  const origin = options.origin && Number.isFinite(options.origin.lat) && Number.isFinite(options.origin.lng)
    ? options.origin
    : null
  const radius = origin && options.radius && options.radius > 0 ? options.radius : 0
  const query = (options.query ?? '').trim().toLowerCase()

  const ranked = events
    .map((event, index) => {
      const distanceMiles = origin && hasPoint(event)
        ? milesBetween(origin, { lat: event.lat as number, lng: event.lng as number })
        : null
      return { event: { ...event, distanceMiles, distanceText: formatMilesAway(distanceMiles) }, index }
    })
    .filter(({ event }) => {
      if (query && ![event.name, event.location, event.clubName]
        .some(field => typeof field === 'string' && field.toLowerCase().includes(query)))
        return false
      if (radius > 0)
        return event.distanceMiles !== null && event.distanceMiles <= radius
      return true
    })

  if (!origin)
    return ranked.map(({ event }) => event)

  const statusRank = (status: string) => (status === 'live' ? 0 : status === 'scheduled' ? 1 : 2)

  return ranked
    .sort((a, b) => {
      const byStatus = statusRank(a.event.status) - statusRank(b.event.status)
      if (byStatus !== 0)
        return byStatus
      if (sortsByDistance(a.event.status)) {
        const ad = a.event.distanceMiles ?? Number.POSITIVE_INFINITY
        const bd = b.event.distanceMiles ?? Number.POSITIVE_INFINITY
        if (ad !== bd)
          return ad - bd
      }
      return a.index - b.index
    })
    .map(({ event }) => event)
}

/** The default a host is offered: one standard yard, starting on the hour. */
function nextTopOfHour(): string {
  const start = new Date()
  start.setMinutes(0, 0, 0)
  start.setHours(start.getHours() + 1)
  return start.toISOString()
}

/** `2026-08-25T07:00` — the shape `<input type="datetime-local">` speaks. */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function useEvents() {
  const events = state<EventSummary[]>([])
  const loading = state(true)
  const loadError = state<string | null>(null)
  const typeFilter = state<EventType | 'all'>('all')
  const statusFilter = state<'all' | 'live' | 'scheduled' | 'finished'>('all')

  const createOpen = state(false)
  const submitting = state(false)
  const createError = state<string | null>(null)

  const fName = state('')
  const fType = state<EventType>('backyard')
  const fLocation = state('')
  const fDescription = state('')
  const fStart = state(toLocalInputValue(nextTopOfHour()))
  const fYardMinutes = state(String(STANDARD_YARD_MINUTES))
  const fLoopDistance = state(String(STANDARD_YARD_MILES))
  const fVisibility = state<'public' | 'club' | 'private'>('public')
  const fPinHere = state(false)

  // ── Where, and how far ─────────────────────────────────────────────────
  // The names below are what the page reads. None of them match anything
  // useNearby exports: a page local that collides with an imported binding
  // is renamed at bundle time while the markup keeps the old name.
  const searchText = state('')
  /** Miles as a string, because it round-trips through a `<select>`. '0' is Anywhere. */
  const radiusChoice = state('0')

  const nearKnown = derived(() => !!nearby())
  const nearLabel = derived(() => nearby()?.label ?? '')
  const nearIsPrecise = derived(() => nearby()?.source === 'gps')
  const nearBusy = derived(() => locating())
  const nearMessage = derived(() => nearbyError())

  const shownEvents = derived(() => {
    const place = nearby()
    return arrangeEvents(events(), {
      origin: place ? { lat: place.lat, lng: place.lng } : null,
      radius: Number.parseInt(radiusChoice(), 10) || 0,
      query: searchText(),
    })
  })

  let timer: ReturnType<typeof setInterval> | null = null

  async function load() {
    const result = await fetchEvents({ type: typeFilter(), status: statusFilter(), limit: DIRECTORY_LIMIT })
    if (result === null) {
      loadError.set('Could not reach the events service.')
      loading.set(false)
      return
    }
    loadError.set(null)
    events.set(result)
    loading.set(false)
  }

  function applyFilter(next: { type?: EventType | 'all', status?: 'all' | 'live' | 'scheduled' | 'finished' }) {
    if (next.type !== undefined)
      typeFilter.set(next.type)
    if (next.status !== undefined)
      statusFilter.set(next.status)
    loading.set(true)
    void load()
  }

  function setSearch(value: string) {
    searchText.set(value)
  }

  function setRadius(value: string) {
    radiusChoice.set(String(Number.parseInt(value, 10) || 0))
  }

  function clearLocationFilters() {
    searchText.set('')
    radiusChoice.set('0')
  }

  /** Swap the coarse guess for a real fix. Prompts, so only from a click. */
  async function refineNearPlace() {
    await locatePrecisely()
  }

  function openCreate() {
    fName.set('')
    fType.set('backyard')
    fLocation.set('')
    fDescription.set('')
    fStart.set(toLocalInputValue(nextTopOfHour()))
    fYardMinutes.set(String(STANDARD_YARD_MINUTES))
    fLoopDistance.set(String(STANDARD_YARD_MILES))
    fVisibility.set('public')
    fPinHere.set(false)
    createError.set(null)
    createOpen.set(true)
  }

  function closeCreate() {
    createOpen.set(false)
    createError.set(null)
  }

  async function submitCreate() {
    if (submitting())
      return

    const name = fName().trim()
    if (name.length < 3) {
      createError.set('Give the event a name (at least 3 characters).')
      return
    }

    // `datetime-local` hands back a wall-clock string with no zone. Parsing it
    // as local time is correct — the host typed the time at the start line —
    // and converting to ISO here is what makes every spectator's countdown
    // agree regardless of where they are watching from.
    const startMs = Date.parse(fStart())
    if (!Number.isFinite(startMs)) {
      createError.set('Pick a start time.')
      return
    }

    const yardMinutes = Number.parseInt(fYardMinutes(), 10)
    const loopDistance = Number.parseFloat(fLoopDistance())
    if (!Number.isInteger(yardMinutes) || yardMinutes < 5 || yardMinutes > 720) {
      createError.set('A yard is between 5 and 720 minutes.')
      return
    }
    if (!Number.isFinite(loopDistance) || loopDistance < 0.1) {
      createError.set('Set the loop distance in miles.')
      return
    }

    // Only when the host said the event is where they are. The visitor's own
    // position is otherwise never sent with anything.
    const here = fPinHere() ? nearby() : null

    submitting.set(true)
    createError.set(null)
    const result = await createEvent({
      name,
      event_type: fType(),
      start_time: new Date(startMs).toISOString(),
      yard_minutes: yardMinutes,
      loop_distance: loopDistance,
      visibility: fVisibility(),
      description: fDescription().trim() || null,
      location: fLocation().trim() || null,
      ...(here ? { lat: here.lat, lng: here.lng } : {}),
    })
    submitting.set(false)

    if (result?.success && result.event) {
      createOpen.set(false)
      await load()
      return
    }

    createError.set(
      result?.fields ? Object.values(result.fields)[0] as string : (result?.error ?? 'Could not create the event.'),
    )
  }

  onMount(() => {
    // Never prompts: a remembered fix or the edge's guess. The list renders in
    // server order meanwhile and re-sorts itself when a place arrives.
    void resolveNearby()
    void load()
    timer = setInterval(() => void load(), REFRESH_MS)
  })

  onDestroy(() => {
    if (timer)
      clearInterval(timer)
  })

  return {
    events,
    loading,
    loadError,
    typeFilter,
    statusFilter,
    applyFilter,
    reload: load,
    shownEvents,
    searchText,
    setSearch,
    radiusChoice,
    setRadius,
    clearLocationFilters,
    nearKnown,
    nearLabel,
    nearIsPrecise,
    nearBusy,
    nearMessage,
    refineNearPlace,
    createOpen,
    submitting,
    createError,
    fName,
    fType,
    fLocation,
    fDescription,
    fStart,
    fYardMinutes,
    fLoopDistance,
    fVisibility,
    fPinHere,
    openCreate,
    closeCreate,
    submitCreate,
  }
}
