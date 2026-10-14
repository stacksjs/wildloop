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
      /*
       * `encodeURIComponent`, not `URLSearchParams`: the native search screen
       * imports this module, and nothing assigns `URLSearchParams` in
       * JavaScriptCore — a shared module that reaches for it makes the screen
       * fail silently. The only visible difference is a space, which this
       * writes as `%20` where the old builder wrote `+`; the router reads
       * both as a space, checked against the running page.
       */
      const near = `near=${encodeURIComponent(name)}&lat=${encodeURIComponent(String(lat))}&lng=${encodeURIComponent(String(lng))}`
      return {
        label: name,
        detail: joined([t.properties?.region, t.properties?.countryName || t.properties?.country].filter(Boolean).join(', '), 'Trails nearby'),
        href: `/trails?${near}`,
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

/*
 * Below: what a screen needs around `groupSearchResults`, added when `/search`
 * was promoted to a native screen. The grouping above was already shared; the
 * five requests that feed it were spelled out in the web page's own script.
 */

/** Two characters: one letter matches most of the catalog and answers nothing. */
export const MIN_SEARCH_LENGTH = 2

export function isSearchable(text: unknown): boolean {
  return String(text ?? '').trim().length >= MIN_SEARCH_LENGTH
}

export const SEARCH_SECTIONS = [
  { key: 'places', title: 'Places' },
  { key: 'trails', title: 'Trails' },
  { key: 'athletes', title: 'Athletes' },
  { key: 'clubs', title: 'Clubs' },
  { key: 'events', title: 'Events' },
] as const

export type SearchSectionKey = typeof SEARCH_SECTIONS[number]['key']

/**
 * The five answers one search is made of.
 *
 * There is no search index behind this screen: each group is a plain endpoint,
 * asked in parallel. Built with `encodeURIComponent` because the native screen
 * imports this module and JavaScriptCore has no `URLSearchParams`.
 */
export function searchPaths(query: string): Record<'towns' | 'suggestions' | 'athletes' | 'clubs' | 'events', string> {
  const q = encodeURIComponent(String(query ?? '').trim())
  return {
    towns: `/api/geo/search?q=${q}&limit=3`,
    suggestions: `/api/search/suggest?q=${q}`,
    athletes: `/api/users/search?q=${q}&limit=5`,
    clubs: `/api/clubs?q=${q}&limit=4`,
    events: `/api/events?q=${q}&limit=4`,
  }
}

/** The groups that found something, in the order the page shows them. */
export function searchSections(groups: SearchGroups | null | undefined): Array<{ key: string, title: string, rows: SearchRow[] }> {
  if (!groups)
    return []
  return SEARCH_SECTIONS
    .map(section => ({ key: section.key, title: section.title, rows: groups[section.key] ?? [] }))
    .filter(section => section.rows.length > 0)
}

export function nothingFoundText(query: string): string {
  return `Nothing matches “${String(query ?? '').trim()}” yet.`
}

export function allTrailsText(query: string): string {
  return `See all trails matching “${String(query ?? '').trim()}”`
}

export function allTrailsPath(query: string): string {
  return `/trails?q=${encodeURIComponent(String(query ?? '').trim())}`
}

/**
 * Where to go when nothing has been typed yet.
 *
 * `screen` names a native screen where one exists, so the app stays native
 * instead of opening a web view onto a page it already draws itself. The two
 * without one need a map or a location fix, which is why they are still the
 * website.
 */
export const SEARCH_QUICK_LINKS: Array<{ label: string, detail: string, href: string, screen?: string }> = [
  { label: 'Trails near me', detail: 'Popular within a drive', href: '/trails?near=me' },
  { label: 'Find athletes', detail: 'Follow people you run with', href: '/athletes', screen: 'Athletes' },
  { label: 'Clubs', detail: 'Groups and their runs', href: '/clubs', screen: 'Clubs' },
  { label: 'Events', detail: 'Races and backyard ultras', href: '/events', screen: 'Events' },
  { label: 'Territory map', detail: 'Who holds the ground', href: '/territories' },
  { label: 'Records', detail: 'Fastest known times', href: '/records', screen: 'Records' },
]
