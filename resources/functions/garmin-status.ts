/**
 * What the Garmin card on Settings says, decided from `/api/garmin/status`.
 *
 * Plain functions so the wording can be tested without a page. The card used
 * to show "Not available yet" and "Connected · Waiting for your first
 * activity" at once, to someone whose profile already had activities. Each
 * state here is exclusive, and the connected copy is about Garmin imports
 * specifically, never the account's activity as a whole.
 */

export type GarminCardState = 'unavailable' | 'disconnected' | 'connected'

export interface GarminStatusPayload {
  configured?: unknown
  connected?: unknown
  connectedAt?: unknown
  lastSyncAt?: unknown
  importedCount?: unknown
}

/**
 * Which one of the three states the card is in.
 *
 * Connected only counts when Garmin has approved the app: without Activity
 * API access nothing can arrive, so a stored connection would be a promise the
 * integration cannot keep.
 */
export function garminCardState(status: GarminStatusPayload | null | undefined): GarminCardState {
  if (!status?.configured)
    return 'unavailable'
  return status.connected ? 'connected' : 'disconnected'
}

function formatDay(value: unknown, locale?: string): string {
  if (typeof value !== 'string' || !value)
    return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "Connected since Sep 20, 2026", or plain "Connected" without a usable date. */
export function garminConnectedLabel(status: GarminStatusPayload | null | undefined, locale?: string): string {
  const since = formatDay(status?.connectedAt, locale)
  return since ? `Connected since ${since}` : 'Connected'
}

/**
 * The import line under a connected card.
 *
 * Counts Garmin imports only, and says so, because the account can hold
 * activities recorded in Wildloop or imported from a file.
 */
export function garminImportSummary(status: GarminStatusPayload | null | undefined, locale?: string): string {
  const count = Math.max(0, Math.floor(Number(status?.importedCount) || 0))
  if (count === 0)
    return 'No Garmin activities imported yet'

  const noun = count === 1 ? 'Garmin activity' : 'Garmin activities'
  const last = formatDay(status?.lastSyncAt, locale)
  return last
    ? `${count.toLocaleString(locale)} ${noun} imported · last on ${last}`
    : `${count.toLocaleString(locale)} ${noun} imported`
}
