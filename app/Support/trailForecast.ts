/**
 * The week's weather at a trailhead.
 *
 * From MET Norway's Locationforecast (api.met.no), which covers the whole
 * world, is free for commercial use with attribution (CC BY 4.0), and asks
 * only for an identifying User-Agent and that clients respect its `Expires`
 * header. Open-Meteo was the obvious alternative and is free only for
 * non-commercial use.
 *
 * A trail page used to show a hardcoded "72°F, clear skies" for every trail
 * in every season. A forecast that cannot be fetched is therefore shown as
 * missing, never guessed at.
 */

/** MET asks for an identifying User-Agent with a way to reach whoever sent it. */
const USER_AGENT = 'Wildloop/1.0 (+https://wildloop.org; trail weather)'

export const FORECAST_ATTRIBUTION = 'Forecast from MET Norway'
export const FORECAST_ATTRIBUTION_URL = 'https://api.met.no/'

export interface ForecastDay {
  /** Local calendar date at the trailhead, `YYYY-MM-DD`. */
  date: string
  /** °F */
  high: number
  low: number
  /** Millimetres over the day. */
  precipitationMm: number
  /** Strongest wind forecast that day, mph. */
  windMph: number
  /** MET symbol, e.g. `partlycloudy_day`, without the day/night suffix. */
  symbol: string
  label: string
  /** Iconify class. */
  icon: string
}

export interface Forecast {
  current: { temperature: number, symbol: string, label: string, icon: string } | null
  days: ForecastDay[]
}

interface MetEntry {
  time: string
  data: {
    instant?: { details?: { air_temperature?: number, wind_speed?: number } }
    next_1_hours?: { summary?: { symbol_code?: string }, details?: { precipitation_amount?: number } }
    next_6_hours?: { summary?: { symbol_code?: string }, details?: { precipitation_amount?: number } }
    next_12_hours?: { summary?: { symbol_code?: string } }
  }
}

/**
 * MET symbol codes, grouped into what a hiker needs to know. Codes carry a
 * `_day` / `_night` / `_polartwilight` suffix, which is stripped first.
 */
const SYMBOLS: Array<{ match: RegExp, label: string, icon: string }> = [
  { match: /thunder/, label: 'Thunderstorms', icon: 'i-lucide-cloud-lightning' },
  { match: /snow/, label: 'Snow', icon: 'i-lucide-cloud-snow' },
  { match: /sleet/, label: 'Sleet', icon: 'i-lucide-cloud-hail' },
  { match: /heavyrain/, label: 'Heavy rain', icon: 'i-lucide-cloud-rain-wind' },
  { match: /rain/, label: 'Rain', icon: 'i-lucide-cloud-rain' },
  { match: /fog/, label: 'Fog', icon: 'i-lucide-cloud-fog' },
  { match: /^cloudy/, label: 'Cloudy', icon: 'i-lucide-cloud' },
  { match: /partlycloudy/, label: 'Partly cloudy', icon: 'i-lucide-cloud-sun' },
  { match: /fair/, label: 'Mostly sunny', icon: 'i-lucide-sun' },
  { match: /clearsky/, label: 'Clear', icon: 'i-lucide-sun' },
]

export function describeSymbol(code: string | undefined): { symbol: string, label: string, icon: string } {
  const symbol = String(code ?? '').replace(/_(day|night|polartwilight)$/, '')
  const found = SYMBOLS.find(entry => entry.match.test(symbol))
  return found ? { symbol, label: found.label, icon: found.icon } : { symbol, label: 'Unknown', icon: 'i-lucide-cloud' }
}

/** How bad a symbol is, so a day is described by its worst weather. */
function severity(symbol: string): number {
  const index = SYMBOLS.findIndex(entry => entry.match.test(symbol))
  return index === -1 ? SYMBOLS.length : SYMBOLS.length - index
}

const celsiusToF = (c: number) => Math.round(c * 9 / 5 + 32)
const msToMph = (ms: number) => Math.round(ms * 2.236936)

/**
 * The trailhead's offset from UTC, in hours, from its longitude. A day is
 * bucketed by where the trail is, not by the server's clock; solar time is at
 * most an hour or so off the legal time zone, which moves a reading between
 * days only around midnight, when nobody is choosing a day to hike.
 */
export function solarOffsetHours(lng: number): number {
  return Math.round(lng / 15)
}

/** Fold MET's hourly-then-six-hourly series into local days. */
export function dailyForecast(series: MetEntry[], lng: number, days = 7): Forecast {
  const offsetMs = solarOffsetHours(lng) * 3_600_000
  const byDate = new Map<string, { temps: number[], winds: number[], precipitation: number, worst: string, coveredUntil: number }>()

  for (const entry of series) {
    const at = Date.parse(entry.time)
    if (!Number.isFinite(at))
      continue
    const local = new Date(at + offsetMs)
    const date = local.toISOString().slice(0, 10)
    const day = byDate.get(date) ?? { temps: [], winds: [], precipitation: 0, worst: '', coveredUntil: 0 }

    const details = entry.data.instant?.details
    if (typeof details?.air_temperature === 'number')
      day.temps.push(details.air_temperature)
    if (typeof details?.wind_speed === 'number')
      day.winds.push(details.wind_speed)

    // Precipitation over whichever window is published, counted once: the
    // hourly entries carry next_1_hours, the later six-hourly ones only
    // next_6_hours, and an hourly entry also carries an overlapping
    // next_6_hours that would count the same rain six times.
    const window = entry.data.next_1_hours ?? entry.data.next_6_hours
    const hours = entry.data.next_1_hours ? 1 : 6
    if (window && at >= day.coveredUntil) {
      day.precipitation += window.details?.precipitation_amount ?? 0
      day.coveredUntil = at + hours * 3_600_000
    }

    // Described by daytime weather: a clear night does not make a stormy
    // afternoon a clear day.
    const hour = local.getUTCHours()
    const code = window?.summary?.symbol_code
    if (code && hour >= 7 && hour <= 19) {
      const { symbol } = describeSymbol(code)
      if (!day.worst || severity(symbol) > severity(day.worst))
        day.worst = symbol
    }

    byDate.set(date, day)
  }

  const out: ForecastDay[] = []
  for (const [date, day] of byDate) {
    // A day with too few readings (the tail of the series, or tonight only)
    // would report a "high" that is really one evening reading.
    if (day.temps.length < 2 || !day.worst)
      continue
    const { symbol, label, icon } = describeSymbol(day.worst)
    out.push({
      date,
      high: celsiusToF(Math.max(...day.temps)),
      low: celsiusToF(Math.min(...day.temps)),
      precipitationMm: Math.round(day.precipitation * 10) / 10,
      windMph: day.winds.length ? msToMph(Math.max(...day.winds)) : 0,
      symbol,
      label,
      icon,
    })
    if (out.length === days)
      break
  }

  const first = series[0]
  const firstTemp = first?.data.instant?.details?.air_temperature
  const firstCode = first?.data.next_1_hours?.summary?.symbol_code ?? first?.data.next_6_hours?.summary?.symbol_code
  const current = typeof firstTemp === 'number' && firstCode
    ? { temperature: celsiusToF(firstTemp), ...describeSymbol(firstCode) }
    : null

  return { current, days: out }
}

/** At most 4 decimals, as MET asks; 2 (~1 km) so neighbours share a cache entry. */
function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100
}

const cache = new Map<string, { expires: number, forecast: Forecast }>()
const MIN_CACHE_MS = 30 * 60_000
const MAX_CACHE_ENTRIES = 2000

/**
 * The forecast for a point, cached until MET says it changes (and at least
 * half an hour). Null when MET cannot be reached — shown as unavailable.
 */
export async function forecastFor(lat: number, lng: number, fetcher: typeof fetch = fetch): Promise<Forecast | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return null

  const la = roundCoordinate(lat)
  const lo = roundCoordinate(lng)
  const key = `${la},${lo}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now())
    return hit.forecast

  try {
    const res = await fetcher(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${la}&lon=${lo}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok)
      return hit?.forecast ?? null
    const body = await res.json() as { properties?: { timeseries?: MetEntry[] } }
    const forecast = dailyForecast(body.properties?.timeseries ?? [], lo)
    const expires = Math.max(Date.parse(res.headers.get('expires') ?? '') || 0, Date.now() + MIN_CACHE_MS)

    if (cache.size >= MAX_CACHE_ENTRIES)
      cache.delete(cache.keys().next().value!)
    cache.set(key, { expires, forecast })
    return forecast
  }
  catch {
    // A stale forecast beats none while MET is briefly unreachable.
    return hit?.forecast ?? null
  }
}
