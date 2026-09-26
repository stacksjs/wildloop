import { describe, expect, it } from 'bun:test'
import { dailyForecast, describeSymbol, forecastFor, solarOffsetHours } from '../../app/Support/trailForecast'
import fixture from '../fixtures/met-locationforecast-rock-ridge.json'

const series = (fixture as any).properties.timeseries

describe('dailyForecast', () => {
  const { current, days } = dailyForecast(series, -118.78)

  it('folds MET\'s series into seven local days', () => {
    expect(days).toHaveLength(7)
    const dates = days.map(day => day.date)
    expect(new Set(dates).size).toBe(7)
    expect([...dates].sort()).toEqual(dates)
  })

  it('reports sane highs and lows in °F', () => {
    for (const day of days) {
      expect(day.high).toBeGreaterThanOrEqual(day.low)
      expect(day.low).toBeGreaterThan(-40)
      expect(day.high).toBeLessThan(130)
      expect(day.precipitationMm).toBeGreaterThanOrEqual(0)
      expect(day.icon).toStartWith('i-lucide-')
    }
  })

  it('reads the current conditions from the first entry', () => {
    const first = series[0].data.instant.details.air_temperature
    expect(current?.temperature).toBe(Math.round(first * 9 / 5 + 32))
  })

  it('does not count overlapping six-hour windows six times', () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 8, 26, hour)).toISOString()
    const entry = (hour: number, rain: number) => ({
      time: at(hour),
      data: {
        instant: { details: { air_temperature: 10 + hour, wind_speed: 2 } },
        next_1_hours: { summary: { symbol_code: 'rain' }, details: { precipitation_amount: rain } },
        next_6_hours: { summary: { symbol_code: 'rain' }, details: { precipitation_amount: 6 } },
      },
    })
    const [day] = dailyForecast([entry(10, 1), entry(11, 1), entry(12, 1)], 0).days
    expect(day.precipitationMm).toBe(3)
    expect(day.label).toBe('Rain')
  })

  it('describes a day by its worst daytime weather', () => {
    const at = (hour: number, code: string) => ({
      time: new Date(Date.UTC(2026, 8, 26, hour)).toISOString(),
      data: { instant: { details: { air_temperature: 15 } }, next_1_hours: { summary: { symbol_code: code }, details: {} } },
    })
    const [day] = dailyForecast([at(2, 'heavyrainandthunder_night'), at(9, 'clearsky_day'), at(15, 'rainshowers_day'), at(18, 'fair_day')], 0).days
    // Rain in the afternoon, not the storm at 2am.
    expect(day.label).toBe('Rain')
  })
})

describe('describeSymbol', () => {
  it('strips the time-of-day suffix and groups codes', () => {
    expect(describeSymbol('partlycloudy_night')).toMatchObject({ symbol: 'partlycloudy', label: 'Partly cloudy' })
    expect(describeSymbol('heavyrainshowersandthunder_day').label).toBe('Thunderstorms')
    expect(describeSymbol('lightsnow').label).toBe('Snow')
    expect(describeSymbol(undefined).label).toBe('Unknown')
  })
})

describe('forecastFor', () => {
  it('asks MET once per spot and serves the cache after', async () => {
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const first = await forecastFor(12.3456, 45.6789, fetcher)
    const second = await forecastFor(12.3461, 45.6792, fetcher)
    expect(first?.days.length).toBeGreaterThan(0)
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  it('answers null rather than inventing weather when MET is unreachable', async () => {
    const failing = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await forecastFor(-33.1, 151.2, failing)).toBeNull()
    expect(await forecastFor(Number.NaN, 0, failing)).toBeNull()
  })
})

describe('solarOffsetHours', () => {
  it('follows longitude', () => {
    expect(solarOffsetHours(-118.78)).toBe(-8)
    expect(solarOffsetHours(11.3)).toBe(1)
  })
})
