/**
 * The Search screen's results, grouped the way it shows them: places and
 * regions, trails, athletes, clubs, then events. Each group comes straight
 * from an existing endpoint (`/api/geo/search`, `/api/search/suggest`,
 * `/api/users/search`, `/api/clubs?q=`, `/api/events?q=`); this shapes them
 * into the same row.
 */

import { avatarUrl } from './avatars'

export interface SearchRow {
  label: string
  detail: string
  href: string
  initial?: string
  /** An athlete's photo, when they have one; `initial` stands in otherwise. */
  photo?: string
}

export interface SearchGroups {
  places: SearchRow[]
  trails: SearchRow[]
  athletes: SearchRow[]
  clubs: SearchRow[]
  events: SearchRow[]
}

interface Suggestion {
  kind?: string
  label?: string
  detail?: string
  href?: string
}

interface Athlete {
  id?: number
  name?: string
  avatar?: string | null
  activityCount?: number
  followerCount?: number
}

interface Club {
  id?: number
  name?: string
  location?: string | null
  memberCount?: number
}

interface Event {
  id?: number
  name?: string
  location?: string | null
  status?: string
  startTime?: string
}

/** A town from /api/geo/search (the ts-maps gazetteer's result shape). */
interface Town {
  text?: string
  center?: { lat?: number, lng?: number }
  properties?: { name?: string, region?: string | null, countryName?: string | null, country?: string }
}

export interface SearchAnswers {
  /** Towns and cities anywhere, so a trip can start from any of them. */
  towns?: Town[]
  suggestions?: Suggestion[]
  athletes?: Athlete[]
  clubs?: Club[]
  events?: Event[]
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function joined(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' · ')
}

function eventWhen(event: Event): string {
  if (event.status === 'live')
    return 'Live now'
  if (event.status === 'finished')
    return 'Finished'
  if (event.status === 'cancelled')
    return 'Cancelled'
  const date = new Date(event.startTime ?? '')
  return Number.isNaN(date.getTime())
    ? 'Date to be confirmed'
    : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function groupSearchResults(answers: SearchAnswers): SearchGroups {
  const suggestions = answers.suggestions ?? []
  const row = (s: Suggestion): SearchRow | null =>
    s.label && s.href ? { label: s.label, detail: s.detail ?? '', href: s.href } : null

  // Towns first: somebody typing "San Diego" is asking where to go there,
  // and the catalog's own places are parks and forests inside some town.
  const towns = (answers.towns ?? [])
    .map((t): SearchRow | null => {
      const lat = Number(t.center?.lat)
      const lng = Number(t.center?.lng)
      const name = t.properties?.name || t.text?.split(',')[0]
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng))
        return null
      const params = new URLSearchParams({ near: name, lat: String(lat), lng: String(lng) })
      return {
        label: name,
        detail: joined([t.properties?.region, t.properties?.countryName || t.properties?.country].filter(Boolean).join(', '), 'Trails nearby'),
        href: `/trails?${params.toString()}`,
      }
    })
    .filter((r): r is SearchRow => r !== null)
  const places = [
    ...towns,
    ...suggestions
      .filter(s => s.kind === 'region' || s.kind === 'place')
      .map(row)
      .filter((r): r is SearchRow => r !== null),
  ]
  const trails = suggestions
    .filter(s => s.kind === 'trail')
    .map(row)
    .filter((r): r is SearchRow => r !== null)

  return {
    places,
    trails,
    athletes: (answers.athletes ?? [])
      .filter(a => typeof a.id === 'number' && a.name)
      .map(a => ({
        label: a.name as string,
        detail: `${plural(a.activityCount ?? 0, 'activity', 'activities')} · ${plural(a.followerCount ?? 0, 'follower')}`,
        href: `/athlete/${a.id}`,
        initial: (a.name as string).charAt(0).toUpperCase(),
        ...(avatarUrl(a.avatar ?? null) ? { photo: avatarUrl(a.avatar ?? null) } : {}),
      })),
    clubs: (answers.clubs ?? [])
      .filter(c => typeof c.id === 'number' && c.name)
      .map(c => ({
        label: c.name as string,
        detail: joined(c.location, plural(c.memberCount ?? 0, 'member')),
        href: `/club/${c.id}`,
      })),
    events: (answers.events ?? [])
      .filter(e => typeof e.id === 'number' && e.name)
      .map(e => ({
        label: e.name as string,
        detail: joined(eventWhen(e), e.location),
        href: `/event/${e.id}`,
      })),
  }
}
