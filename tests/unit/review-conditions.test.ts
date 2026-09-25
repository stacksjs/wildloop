import { describe, expect, it } from 'bun:test'
import { conditionReportedAt, visitDateProblem } from '../../app/Support/reviewConditions'

/**
 * A review says what someone saw and when. There is one review per person per
 * trail, so a months-old review is the thing they edit to warn about today —
 * which is why the report time is kept apart from the review's own dates, and
 * why the visit date is checked before it is believed.
 */

const NOW = Date.parse('2026-09-24T12:00:00Z')
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10)

describe('visitDateProblem', () => {
  it('takes a calendar day on or before today', () => {
    expect(visitDateProblem('2026-09-24', NOW)).toBeNull()
    expect(visitDateProblem(day(1), NOW)).toBeNull()
    expect(visitDateProblem(day(900), NOW)).toBeNull()
  })

  it.each([
    'yesterday',
    '2026-9-4',
    '2026-09-24T12:00:00Z',
    '2026-02-31',
    '0000-00-00',
    '',
  ])('refuses %s', (value) => {
    expect(visitDateProblem(value, NOW)).toBe('malformed')
  })

  it.each([null, undefined, 42, {}])('refuses %p, which is not a date at all', (value) => {
    expect(visitDateProblem(value, NOW)).toBe('malformed')
  })

  it('refuses a date wrapped in a list, which a JSON body can carry', () => {
    expect(visitDateProblem(['2026-09-24'], NOW)).toBe('malformed')
  })

  // The one that matters: a future date outranks every real report, so it
  // could hold a hazard on the page for good, or clear one still there.
  it('refuses a date in the future', () => {
    expect(visitDateProblem('2026-09-26', NOW)).toBe('future')
    expect(visitDateProblem('2027-01-01', NOW)).toBe('future')
  })

  // The server checks in UTC; someone in Auckland is a day ahead of it.
  it('allows a day of grace for the time zones ahead of the server', () => {
    expect(visitDateProblem('2026-09-25', NOW)).toBeNull()
  })

  it('refuses a date before anything could have been reported', () => {
    expect(visitDateProblem('1969-07-20', NOW)).toBe('ancient')
  })
})

describe('conditionReportedAt', () => {
  const now = new Date(NOW).toISOString()

  it('reports a new review at the visit, else now', () => {
    expect(conditionReportedAt(null, 'flooded', day(3), now)).toBe(day(3))
    expect(conditionReportedAt(null, 'flooded', null, now)).toBe(now)
    expect(conditionReportedAt(null, null, null, now)).toBeNull()
  })

  // The regression. In June this person called the trail good; today they
  // find it flooded and edit the review they already have.
  it('dates a hazard added to an old review from today', () => {
    const june = { conditions: 'good', conditionsReportedAt: '2026-06-20T09:00:00.000Z' }
    expect(conditionReportedAt(june, 'flooded', null, now)).toBe(now)
  })

  it('keeps the original time when the condition has not changed', () => {
    const reported = '2026-09-22T09:00:00.000Z'
    expect(conditionReportedAt({ conditions: 'icy', conditionsReportedAt: reported }, 'icy', null, now)).toBe(reported)
  })

  it('renews it when they say they saw the same thing later', () => {
    const reported = '2026-09-18T09:00:00.000Z'
    expect(conditionReportedAt({ conditions: 'icy', conditionsReportedAt: reported }, 'icy', day(1), now)).toBe(day(1))
  })

  it('does not move it back to an earlier visit', () => {
    const reported = '2026-09-22T09:00:00.000Z'
    expect(conditionReportedAt({ conditions: 'icy', conditionsReportedAt: reported }, 'icy', day(30), now)).toBe(reported)
  })

  it('stamps a condition on a review written before the column existed', () => {
    expect(conditionReportedAt({ conditions: 'icy', conditionsReportedAt: null }, 'icy', null, now)).toBe(now)
  })

  it('forgets the report when the condition is taken off the review', () => {
    expect(conditionReportedAt({ conditions: 'closed', conditionsReportedAt: now }, null, null, now)).toBeNull()
  })
})
