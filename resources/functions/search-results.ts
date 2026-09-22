/**
 * The Search screen's results, grouped the way it shows them: places and
 * regions, trails, athletes, clubs, then events. Each group comes straight
 * from an existing endpoint (`/api/search/suggest`, `/api/users/search`,
 * `/api/clubs?q=`, `/api/events?q=`); this shapes them into the same row.
 */

export interface SearchRow {
  label: string
  detail: string
  href: string
  initial?: string
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

export interface SearchAnswers {
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

  const places = suggestions
    .filter(s => s.kind === 'region' || s.kind === 'place')
    .map(row)
    .filter((r): r is SearchRow => r !== null)
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
