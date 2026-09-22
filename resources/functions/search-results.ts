/**
 * The Search screen's results, grouped the way it shows them: places and
 * regions, trails, then athletes. The two answers come from different
 * endpoints (`/api/search/suggest` and `/api/users/search`); this shapes
 * both into the same row.
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

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

export function groupSearchResults(suggestions: Suggestion[], athletes: Athlete[]): SearchGroups {
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
    athletes: athletes
      .filter(a => typeof a.id === 'number' && a.name)
      .map(a => ({
        label: a.name as string,
        detail: `${plural(a.activityCount ?? 0, 'activity', 'activities')} · ${plural(a.followerCount ?? 0, 'follower')}`,
        href: `/athlete/${a.id}`,
        initial: (a.name as string).charAt(0).toUpperCase(),
      })),
  }
}
