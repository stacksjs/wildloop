/**
 * Evidence and tracker links, validated server-side.
 *
 * These lived in `resources/functions/route-records.ts`, which is a *shared*
 * module: the native records screen imports `formatElapsed`, `recordPace` and
 * the label tables from it, so the whole file is compiled into the native
 * bundle. These two functions parse with `new URL`, which the native runtime
 * does not define — JavaScriptCore has no `URL` and stx installs no shim — so
 * the day a screen called one it would have thrown at the call, not at the
 * import, with nothing before then to say so. `bun run gate:stx` had been
 * carrying it as a standing note.
 *
 * Moving them rather than rewriting them is deliberate. Only the two record
 * effort actions call these, and both run on the server, so there is no reason
 * for them to be shared. And the rewrite would mean hand-parsing a URL for a
 * check whose whole job is to refuse `javascript:` — a worse trade than
 * putting the code where the real `URL` exists.
 */

/**
 * Platforms that actually hold a recording.
 *
 * A link to a blog post about the run is a trip report, not a trace, and that
 * distinction is the whole point of asking for one.
 */
const TRACE_HOSTS = [
  'strava.com',
  'connect.garmin.com',
  'app.komoot.com',
  'komoot.com',
  'suunto.com',
  'coros.com',
  'trainingpeaks.com',
  'ridewithgps.com',
  'wildloop.app',
]

/**
 * Accept an evidence link only if it is an https URL on a platform that
 * actually holds the recording.
 */
export function normalizeEvidenceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim())
    return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  }
  catch {
    return null
  }
  if (parsed.protocol !== 'https:')
    return null
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
  if (!TRACE_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`)))
    return null
  return parsed.toString()
}

/**
 * A tracker link is read while an attempt is still out there, so it is held
 * to a lower bar than evidence — any https link works — but it is still
 * normalized so a typo cannot inject a `javascript:` URL into the board.
 */
export function normalizeTrackerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim())
    return null
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === 'https:' ? parsed.toString() : null
  }
  catch {
    return null
  }
}
