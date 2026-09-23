import { describe, expect, it } from 'bun:test'
import {
  addDays,
  daysUntil,
  isCalendarDate,
  localDate,
  planDayLabel,
  planDirections,
  planReminderBody,
  planReminderDue,
  planTimeLabel,
  sortPlans,
  validateTripPlan,
} from '../../resources/functions/trip-plans'

const today = '2026-09-23'

describe('validateTripPlan', () => {
  const valid = {
    title: '  Torrey   Pines Loop ',
    latitude: '32.9209',
    longitude: -117.2528,
    planned_for: '2026-09-30',
    start_time: '07:30',
    timezone: 'America/Los_Angeles',
    activity_type: 'Trail Run',
    notes: 'Park at the south lot.\r\nBring water.',
    place_label: 'San Diego, California',
  }

  it('accepts and tidies a complete plan', () => {
    const { value, fields } = validateTripPlan(valid, { today })
    expect(fields).toEqual({})
    expect(value).toMatchObject({
      title: 'Torrey Pines Loop',
      latitude: 32.9209,
      longitude: -117.2528,
      planned_for: '2026-09-30',
      start_time: '07:30',
      timezone: 'America/Los_Angeles',
      activity_type: 'Trail Run',
      notes: 'Park at the south lot.\nBring water.',
    })
  })

  it('names each problem so the form can put it next to its field', () => {
    const { fields } = validateTripPlan({
      title: '   ',
      latitude: 0,
      longitude: 0,
      planned_for: '2026-02-30',
      start_time: '7:30pm',
      activity_type: 'Swim',
    }, { today })
    expect(Object.keys(fields).sort()).toEqual(['activity_type', 'location', 'planned_for', 'start_time', 'title'])
  })

  it('allows today, refuses yesterday and anything past two years out', () => {
    expect(validateTripPlan({ ...valid, planned_for: today }, { today }).fields).toEqual({})
    expect(validateTripPlan({ ...valid, planned_for: '2026-09-22' }, { today }).fields.planned_for).toMatch(/passed/)
    expect(validateTripPlan({ ...valid, planned_for: '2028-09-24' }, { today }).fields.planned_for).toMatch(/two years/)
  })

  it('checks only what an edit sends, and lets optional fields be cleared', () => {
    expect(validateTripPlan({ notes: 'Bring poles' }, { today, partial: true })).toEqual({ value: { notes: 'Bring poles' }, fields: {} })
    expect(validateTripPlan({ start_time: '', activity_type: null, trail_id: null }, { today, partial: true }).value)
      .toEqual({ start_time: null, activity_type: null, trail_id: null })
    // A timezone the runtime cannot use is dropped, not an error.
    expect(validateTripPlan({ timezone: 'Mars/Olympus_Mons' }, { today, partial: true }).value).toEqual({ timezone: null })
  })

  it('caps free text', () => {
    const { value } = validateTripPlan({ ...valid, title: 'x'.repeat(500), notes: 'y'.repeat(5000) }, { today })
    expect(value.title).toHaveLength(120)
    expect(value.notes).toHaveLength(1000)
  })
})

describe('dates', () => {
  it('knows real calendar days', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true)
    expect(isCalendarDate('2026-02-29')).toBe(false)
    expect(isCalendarDate('2026-9-3')).toBe(false)
  })

  it('reads the day in a timezone, not on the server', () => {
    const lateInCalifornia = new Date('2026-09-24T02:00:00Z') // 7 PM on the 23rd in LA
    expect(localDate('America/Los_Angeles', lateInCalifornia)).toBe('2026-09-23')
    expect(localDate('Asia/Tokyo', lateInCalifornia)).toBe('2026-09-24')
    expect(localDate('not/a zone', lateInCalifornia)).toBe('2026-09-24')
  })

  it('adds days across month ends and DST changes', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(daysUntil('2026-09-30', today)).toBe(7)
  })

  it('labels a day the way people say it', () => {
    expect(planDayLabel(today, today)).toBe('Today')
    expect(planDayLabel('2026-09-24', today)).toBe('Tomorrow')
    expect(planDayLabel('2026-09-30', today)).toBe('Wed, Sep 30')
    expect(planDayLabel('2027-01-02', today)).toBe('Sat, Jan 2, 2027')
    expect(planTimeLabel('07:05')).toBe('7:05 AM')
    expect(planTimeLabel('00:30')).toBe('12:30 AM')
    expect(planTimeLabel('13:00')).toBe('1:00 PM')
    expect(planTimeLabel(null)).toBe('')
  })
})

describe('sortPlans', () => {
  it('lists upcoming soonest first and past most recent first, keeping today upcoming', () => {
    const plans = [
      { id: 1, planned_for: '2026-09-30', start_time: null },
      { id: 2, planned_for: '2026-09-30', start_time: '07:00' },
      { id: 3, planned_for: today, start_time: '06:00' },
      { id: 4, planned_for: '2026-09-01', start_time: null },
      { id: 5, planned_for: '2026-09-20', start_time: null },
    ]
    const { upcoming, past } = sortPlans(plans, today)
    expect(upcoming.map(p => p.id)).toEqual([3, 2, 1])
    expect(past.map(p => p.id)).toEqual([5, 4])
  })
})

describe('planDirections', () => {
  it('hands off to Apple Maps and Google Maps by road', () => {
    expect(planDirections({ latitude: 32.9209, longitude: -117.2528, activity_type: 'Hike' })).toEqual({
      apple: 'https://maps.apple.com/?daddr=32.9209%2C-117.2528&dirflg=d',
      google: 'https://www.google.com/maps/dir/?api=1&destination=32.9209%2C-117.2528&travelmode=driving',
    })
  })

  it('has no links for a plan with no usable point', () => {
    expect(planDirections({ latitude: Number.NaN, longitude: 1, activity_type: null })).toBeNull()
  })
})

describe('planReminderDue', () => {
  const plan = { planned_for: '2026-09-30', timezone: 'America/Los_Angeles', reminded_at: null }

  it('from six the evening before, in the plan timezone', () => {
    expect(planReminderDue(plan, new Date('2026-09-29T23:59:00Z'))).toBe(false) // 4:59 PM in LA
    expect(planReminderDue(plan, new Date('2026-09-30T01:00:00Z'))).toBe(true) // 6 PM on the 29th in LA
    expect(planReminderDue(plan, new Date('2026-09-30T06:59:00Z'))).toBe(true) // 11:59 PM
    expect(planReminderDue(plan, new Date('2026-09-30T07:00:00Z'))).toBe(false) // the day itself
  })

  it('never twice, and never for a plan with no real date', () => {
    const evening = new Date('2026-09-30T02:00:00Z')
    expect(planReminderDue({ ...plan, reminded_at: '2026-09-30T01:00:00Z' }, evening)).toBe(false)
    expect(planReminderDue({ ...plan, planned_for: 'soon' }, evening)).toBe(false)
  })

  it('falls back to UTC when the plan has no timezone', () => {
    expect(planReminderDue({ ...plan, timezone: null }, new Date('2026-09-29T18:00:00Z'))).toBe(true)
  })

  it('says what, where and when', () => {
    expect(planReminderBody({ title: 'Torrey Pines Loop', place_label: 'San Diego, California', start_time: '07:30' }))
      .toBe('Tomorrow at 7:30 AM: Torrey Pines Loop near San Diego, California. Directions are ready in your plans.')
    expect(planReminderBody({ title: 'Cowles Mountain', place_label: null, start_time: null }))
      .toBe('Tomorrow: Cowles Mountain. Directions are ready in your plans.')
  })
})
