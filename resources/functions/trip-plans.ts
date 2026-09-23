import type { NavigationLinks, NavigationMode } from 'ts-maps/services'
import { directionsLinks } from 'ts-maps/services'

/**
 * Planning a trip: a trail or any spot, on a calendar day.
 *
 * Shared by the API (validation, reminders) and the pages (labels, sorting,
 * directions), so what the server accepts and what the page shows cannot
 * drift apart. Nothing here touches the DOM: resources/functions is also the
 * server's auto-import barrel.
 */

export const PLAN_TITLE_MAX = 120
export const PLAN_PLACE_MAX = 200
export const PLAN_NOTES_MAX = 1000
/** Far enough for a race booked next year; beyond it is a typo. */
export const PLAN_MAX_DAYS_AHEAD = 730
/** Local hour, the evening before, when the reminder goes out. */
export const PLAN_REMINDER_HOUR = 18
export const PLAN_ACTIVITIES = ['Trail Run', 'Hike', 'Walk', 'Bike'] as const

export type PlanActivity = typeof PLAN_ACTIVITIES[number]

export interface TripPlan {
  id: number
  uuid?: string | null
  trail_id: number | null
  /** A route the person drew; the plan starts at its first point. */
  custom_route_id?: number | null
  title: string
  place_label: string | null
  latitude: number
  longitude: number
  /** YYYY-MM-DD */
  planned_for: string
  /** HH:MM, 24-hour, or null for "some time that day". */
  start_time: string | null
  timezone: string | null
  activity_type: PlanActivity | null
  notes: string | null
  reminded_at?: string | null
  created_at?: string | null
}

export type TripPlanInput = Partial<Record<keyof TripPlan, unknown>>

export type TripPlanFields = Omit<TripPlan, 'id' | 'uuid' | 'reminded_at' | 'created_at'>

export interface TripPlanValidation {
  value: Partial<TripPlanFields>
  fields: Record<string, string>
}

/** A real calendar day in YYYY-MM-DD form (no February 30th). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** HH:MM on a 24-hour clock. */
export function isClockTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/** An IANA zone this runtime can format dates in. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64)
    return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  }
  catch {
    return false
  }
}

/** The calendar day it is in `timeZone` (UTC when unknown). */
export function localDate(timeZone: string | null | undefined, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: isTimeZone(timeZone) ? timeZone : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** The hour of the day it is in `timeZone` (UTC when unknown), 0–23. */
export function localHour(timeZone: string | null | undefined, now: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: isTimeZone(timeZone) ? timeZone : 'UTC',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now)
  return Number(hour) % 24
}

/** `date` moved by whole days. Calendar arithmetic, so DST cannot shift it. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string')
    return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

function cleanNotes(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  // Line breaks are kept: notes are where "park at the south lot" goes.
  const text = value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim()
  return text ? text.slice(0, PLAN_NOTES_MAX) : null
}

function coordinate(value: unknown, limit: number): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit ? n : null
}

/**
 * Check a plan being created, or the fields of one being edited (`partial`).
 *
 * `today` is the calendar day where the person is. A plan for yesterday is
 * refused; one for today is allowed — "this afternoon" is a plan.
 */
export function validateTripPlan(input: TripPlanInput, opts: { today: string, partial?: boolean }): TripPlanValidation {
  const value: Partial<TripPlanFields> = {}
  const fields: Record<string, string> = {}
  const has = (key: keyof TripPlan) => !opts.partial || input[key] !== undefined

  if (has('title')) {
    const title = cleanText(input.title, PLAN_TITLE_MAX)
    if (title)
      value.title = title
    else
      fields.title = 'Give the plan a name'
  }

  if (has('latitude') || has('longitude')) {
    const lat = coordinate(input.latitude, 90)
    const lng = coordinate(input.longitude, 180)
    if (lat === null || lng === null || (lat === 0 && lng === 0)) {
      fields.location = 'Pick a trail or a spot on the map'
    }
    else {
      value.latitude = lat
      value.longitude = lng
    }
  }

  if (has('planned_for')) {
    const date = input.planned_for
    if (!isCalendarDate(date))
      fields.planned_for = 'Choose a date'
    else if (date < opts.today)
      fields.planned_for = 'That date has already passed'
    else if (date > addDays(opts.today, PLAN_MAX_DAYS_AHEAD))
      fields.planned_for = 'Plans can be made up to two years ahead'
    else
      value.planned_for = date
  }

  if (input.start_time !== undefined) {
    if (input.start_time === null || input.start_time === '')
      value.start_time = null
    else if (isClockTime(input.start_time))
      value.start_time = input.start_time
    else
      fields.start_time = 'Use a time like 07:30'
  }

  if (input.trail_id !== undefined) {
    const id = Number(input.trail_id)
    if (input.trail_id === null || input.trail_id === '')
      value.trail_id = null
    else if (Number.isInteger(id) && id > 0)
      value.trail_id = id
    else
      fields.trail_id = 'Unknown trail'
  }

  if (input.custom_route_id !== undefined) {
    const id = Number(input.custom_route_id)
    if (input.custom_route_id === null || input.custom_route_id === '')
      value.custom_route_id = null
    else if (Number.isInteger(id) && id > 0)
      value.custom_route_id = id
    else
      fields.custom_route_id = 'Unknown route'
  }

  if (input.place_label !== undefined)
    value.place_label = cleanText(input.place_label, PLAN_PLACE_MAX)

  if (input.timezone !== undefined)
    value.timezone = isTimeZone(input.timezone) ? input.timezone : null

  if (input.activity_type !== undefined) {
    if (input.activity_type === null || input.activity_type === '')
      value.activity_type = null
    else if ((PLAN_ACTIVITIES as readonly unknown[]).includes(input.activity_type))
      value.activity_type = input.activity_type as PlanActivity
    else
      fields.activity_type = 'Choose run, hike, walk or ride'
  }

  if (input.notes !== undefined)
    value.notes = cleanNotes(input.notes)

  return { value, fields }
}

/** "Today", "Tomorrow", "Sat, Sep 26", or with the year when it is not this one. */
export function planDayLabel(date: string, today: string): string {
  if (!isCalendarDate(date))
    return ''
  if (date === today)
    return 'Today'
  if (date === addDays(today, 1))
    return 'Tomorrow'
  if (date === addDays(today, -1))
    return 'Yesterday'
  const sameYear = date.slice(0, 4) === today.slice(0, 4)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(new Date(`${date}T00:00:00Z`))
}

/** "7:30 AM" from "07:30". */
export function planTimeLabel(time: string | null | undefined): string {
  if (!isClockTime(time))
    return ''
  const [h, m] = time.split(':').map(Number)
  const hour = h % 12 || 12
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** Days from `today` until the plan: 0 today, negative once it is past. */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

/**
 * Upcoming soonest-first (a timed plan before an untimed one on the same
 * day), past most-recent-first. A plan for today stays upcoming all day.
 */
export function sortPlans<T extends Pick<TripPlan, 'planned_for' | 'start_time' | 'id'>>(plans: T[], today: string): { upcoming: T[], past: T[] } {
  const key = (p: T) => `${p.planned_for} ${p.start_time ?? '99:99'} ${String(p.id).padStart(12, '0')}`
  const upcoming = plans.filter(p => p.planned_for >= today).sort((a, b) => key(a).localeCompare(key(b)))
  const past = plans.filter(p => p.planned_for < today).sort((a, b) => key(b).localeCompare(key(a)))
  return { upcoming, past }
}

/** The mode a plan's activity implies for getting there — always by road. */
export function planTravelMode(_plan: Pick<TripPlan, 'activity_type'>): NavigationMode {
  // The trip TO a trailhead is a drive whatever happens once there; a
  // walking route to a trail 40 miles away helps nobody.
  return 'driving'
}

/** Apple Maps and Google Maps links to the plan's point, or null if it has none. */
export function planDirections(plan: Pick<TripPlan, 'latitude' | 'longitude' | 'activity_type'>): NavigationLinks | null {
  try {
    return directionsLinks({ lat: Number(plan.latitude), lng: Number(plan.longitude) }, { mode: planTravelMode(plan) })
  }
  catch {
    return null
  }
}

/**
 * Is the day-before reminder owed now?
 *
 * From PLAN_REMINDER_HOUR the evening before, in the timezone the plan was
 * made in, until the day itself begins. A plan made later that evening is
 * reminded on the next run. A plan made for today, or one the job missed
 * until the morning of, gets none: a reminder after the fact is noise.
 */
export function planReminderDue(plan: Pick<TripPlan, 'planned_for' | 'timezone' | 'reminded_at'>, now: Date = new Date()): boolean {
  if (plan.reminded_at || !isCalendarDate(plan.planned_for))
    return false
  const today = localDate(plan.timezone, now)
  return plan.planned_for === addDays(today, 1) && localHour(plan.timezone, now) >= PLAN_REMINDER_HOUR
}

/** The reminder's text: what, where and when. */
export function planReminderBody(plan: Pick<TripPlan, 'title' | 'place_label' | 'start_time'>): string {
  const at = planTimeLabel(plan.start_time)
  const where = plan.place_label ? ` near ${plan.place_label}` : ''
  return `Tomorrow${at ? ` at ${at}` : ''}: ${plan.title}${where}. Directions are ready in your plans.`
}
