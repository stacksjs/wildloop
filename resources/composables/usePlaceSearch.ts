import { state } from 'stx'

/**
 * Search towns and cities as someone types — "where are you going?".
 *
 * Answered by /api/geo/search, the GeoNames gazetteer on this server, so the
 * keystrokes stay here and there is no public geocoder to be rate-limited
 * by. Each caller gets its own state, so two search boxes on one page do not
 * finish each other's sentences.
 */

export interface PlaceResult {
  /** "San Diego, California, United States" */
  label: string
  /** "San Diego" */
  name: string
  /** "California, United States" */
  detail: string
  lat: number
  lng: number
}

interface GazetteerResult {
  text?: string
  center?: { lat?: number, lng?: number }
  properties?: { name?: string, region?: string | null, countryName?: string | null, country?: string }
}

export function toPlaceResult(raw: GazetteerResult): PlaceResult | null {
  const lat = Number(raw.center?.lat)
  const lng = Number(raw.center?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !raw.text)
    return null
  const name = raw.properties?.name || raw.text.split(',')[0]
  const detail = [raw.properties?.region, raw.properties?.countryName || raw.properties?.country].filter(Boolean).join(', ')
  return { label: raw.text, name, detail, lat, lng }
}

/** One lookup, for callers that are not a search box (a dropped pin). */
export async function nearestPlace(lat: number, lng: number): Promise<PlaceResult | null> {
  try {
    const res = await fetch(`/api/geo/reverse?lat=${lat}&lng=${lng}`)
    const body = await res.json()
    return Array.isArray(body.results) && body.results[0] ? toPlaceResult(body.results[0]) : null
  }
  catch {
    return null
  }
}

export function usePlaceSearch(opts: { limit?: number, debounceMs?: number } = {}) {
  const query = state('')
  const results = state<PlaceResult[]>([])
  const searching = state(false)
  /** The server has no gazetteer yet (`buddy geo:import` has not run). */
  const unavailable = state(false)
  const failed = state(false)

  let timer: ReturnType<typeof setTimeout> | null = null
  let latest = 0

  async function run(text: string): Promise<void> {
    const token = ++latest
    if (text.trim().length < 2) {
      results.set([])
      searching.set(false)
      return
    }
    searching.set(true)
    try {
      const res = await fetch(`/api/geo/search?q=${encodeURIComponent(text.trim())}&limit=${opts.limit ?? 6}`)
      const body = await res.json()
      if (token !== latest)
        return
      unavailable.set(body.available === false)
      failed.set(!res.ok)
      results.set((Array.isArray(body.results) ? body.results : []).map(toPlaceResult).filter(Boolean) as PlaceResult[])
    }
    catch {
      if (token === latest) {
        failed.set(true)
        results.set([])
      }
    }
    finally {
      if (token === latest)
        searching.set(false)
    }
  }

  /** Call on every input event; the request waits for a pause in typing. */
  function onInput(text: string): void {
    query.set(text)
    if (timer)
      clearTimeout(timer)
    timer = setTimeout(() => void run(text), opts.debounceMs ?? 220)
  }

  function clear(): void {
    if (timer)
      clearTimeout(timer)
    latest++
    query.set('')
    results.set([])
    searching.set(false)
  }

  return { query, results, searching, unavailable, failed, onInput, clear }
}
