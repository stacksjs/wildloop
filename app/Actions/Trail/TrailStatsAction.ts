/**
 * Coverage summary for the trail catalog.
 *
 * The catalog is built by a long-running national ingest, so "how much of the
 * country is in here?" is a question both the user and the operator ask. The
 * numbers come from indexed `GROUP BY`s rather than from a config constant,
 * which means the page tells the truth while the ingest is still running
 * instead of advertising a total that has not landed yet.
 *
 * Cached in-process: the counts change on the order of minutes as shards
 * complete, and every catalog page view would otherwise aggregate the whole
 * table.
 */

const CACHE_TTL_MS = 60_000

interface CoverageStats {
  total: number
  countries: Array<{ code: string, count: number }>
  /**
   * `lat`/`lng` is the middle of the region's trails, not of its borders:
   * what the Region list sorts by when it knows where the visitor is, so the
   * regions nearest them come first rather than the biggest.
   */
  states: Array<{ code: string, name: string, country: string, count: number, lat: number | null, lng: number | null }>
  sources: Array<{ source: string, count: number }>
}

let cache: { at: number, value: CoverageStats } | null = null

/** Three places is about 100 m — plenty for ordering regions by distance. */
function roundCoordinate(value: unknown): number | null {
  const number = Number(value)
  return value === null || value === undefined || !Number.isFinite(number) ? null : Math.round(number * 1000) / 1000
}

export default new Action({
  name: 'Trail Stats',
  description: 'Trail catalog coverage by state and source',
  method: 'GET',

  async handle() {
    try {
      if (cache && Date.now() - cache.at < CACHE_TTL_MS)
        return response.json({ success: true, ...cache.value })

      // Grouped by country as well as region: region codes are only unique
      // within a country, so `BE` alone is both Berlin and canton Bern.
      const stateRows = await db.sql`
        SELECT state AS code, state_name AS name, country, COUNT(*) AS count,
          AVG(latitude) AS lat, AVG(longitude) AS lng
        FROM trails
        WHERE state IS NOT NULL AND state != ''
        GROUP BY country, state, state_name
        ORDER BY count DESC
      `.execute() as Array<{ code: string, name: string, country: string, count: number, lat: number | null, lng: number | null }>

      const countryRows = await db.sql`
        SELECT country AS code, COUNT(*) AS count
        FROM trails
        WHERE country IS NOT NULL AND country != ''
        GROUP BY country
        ORDER BY count DESC
      `.execute() as Array<{ code: string, count: number }>

      const sourceRows = await db.sql`
        SELECT source, COUNT(*) AS count
        FROM trails
        GROUP BY source
        ORDER BY count DESC
      `.execute() as Array<{ source: string, count: number }>

      const states = (stateRows ?? []).map(row => ({
        code: row.code,
        name: row.name || row.code,
        country: row.country || 'US',
        count: Number(row.count),
        lat: roundCoordinate(row.lat),
        lng: roundCoordinate(row.lng),
      }))

      const value: CoverageStats = {
        total: states.reduce((sum, row) => sum + row.count, 0),
        countries: (countryRows ?? []).map(row => ({ code: row.code, count: Number(row.count) })),
        states,
        sources: (sourceRows ?? []).map(row => ({ source: row.source, count: Number(row.count) })),
      }

      cache = { at: Date.now(), value }

      return response.json({ success: true, ...value })
    }
    catch (error) {
      console.error('[trails] stats failed:', error)
      return response.json({ success: false, total: 0, countries: [], states: [], sources: [] }, 500)
    }
  },
})
