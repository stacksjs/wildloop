/**
 * When a review's condition report was made, as opposed to when the review
 * was written.
 *
 * One review per person per trail (#972), so somebody who walked a trail
 * months ago and finds it flooded today edits the review they already have.
 * The row's `created_at` still says months ago, and the trail page reads its
 * condition reports from the reviews — so the flooding was filed as months
 * old news and no warning was shown. `conditions_reported_at` is the missing
 * fact: when the condition currently on the review was seen.
 *
 * Pure, so the rule can be tested without a database.
 */

/** A visit date, as the API takes it: a calendar day, no time. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Nothing on a trail was reviewed here before this. */
const EARLIEST_VISIT = Date.parse('1970-01-01T00:00:00Z')

/**
 * A day of grace on top of "today".
 *
 * The server checks in UTC and the person reporting may be as far ahead as
 * UTC+14, so their own today can be tomorrow here. Rejecting that would tell
 * someone in Auckland that the day they walked the trail has not happened.
 */
const AHEAD_MS = 24 * 60 * 60 * 1000

export type VisitDateProblem = 'malformed' | 'future' | 'ancient'

/**
 * Check a submitted visit date.
 *
 * A date in the future is not a typo to be forgiven: it is the one input that
 * makes a report look newer than every real one, so it could keep a hazard on
 * the page forever, or clear one that is still there.
 */
export function visitDateProblem(value: unknown, now: number = Date.now()): VisitDateProblem | null {
  if (typeof value !== 'string' || !CALENDAR_DAY.test(value))
    return 'malformed'
  const time = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(time))
    return 'malformed'
  // Date.parse accepts 2026-02-31 and rolls it into March: a date that says
  // one day and means another is malformed, whatever the parser makes of it.
  if (new Date(time).toISOString().slice(0, 10) !== value)
    return 'malformed'
  if (time > now + AHEAD_MS)
    return 'future'
  if (time < EARLIEST_VISIT)
    return 'ancient'
  return null
}

export const VISIT_DATE_MESSAGE = 'must be a calendar date (YYYY-MM-DD) on or before today'

interface ExistingReport {
  conditions: string | null
  conditionsReportedAt: string | null
}

/**
 * When to say the condition now on a review was seen.
 *
 * The visit date sent with the write wins: that is the day the person says
 * they were there. Without one, a condition the review did not carry before
 * was seen now — that is the edited-old-review case. A condition that has not
 * changed keeps the time it was first reported, so re-saving a review to fix
 * a typo cannot make a stale hazard look current; only a later visit date for
 * the same condition renews it.
 */
export function conditionReportedAt(
  existing: ExistingReport | null,
  conditions: string | null,
  visitDate: string | null,
  now: string,
): string | null {
  if (!conditions)
    return null

  const observed = visitDate ?? now
  if (!existing || existing.conditions !== conditions || !existing.conditionsReportedAt)
    return observed

  const renewed = visitDate !== null && Date.parse(observed) > Date.parse(existing.conditionsReportedAt)
  return renewed ? observed : existing.conditionsReportedAt
}
