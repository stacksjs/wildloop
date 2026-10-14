/**
 * The club directory, as both the website and the native screen read it.
 *
 * The web page has a create form, a grid, a "no crew near you yet" prompt and
 * distance sorting from a resolved location; the native screen has chips and a
 * list. They diverge on all of that and on none of the facts: what a club is
 * called, how many people are in it, what kind of door it has, and what it did
 * this week.
 *
 * Membership is the part worth sharing rather than restating. `isMember` has
 * two spellings in the wild — the listing sends the boolean, older payloads
 * sent a roster — and a screen that reads only one of them offers to join a
 * club somebody is already in.
 *
 * @module functions/clubs
 */

export const CLUB_TYPES = ['Running', 'Hiking', 'Territory Game'] as const

export type ClubType = typeof CLUB_TYPES[number]

/** The chips, in the order the web page shows them. */
export const CLUB_FILTERS = ['all', 'mine', ...CLUB_TYPES] as const

export type ClubFilter = typeof CLUB_FILTERS[number]

export const CLUB_FILTER_LABELS: Record<ClubFilter, string> = {
  'all': 'All clubs',
  'mine': 'My clubs',
  'Running': 'Running',
  'Hiking': 'Hiking',
  'Territory Game': 'Territory',
}

export type JoinPolicy = 'open' | 'request' | 'invite_only'

export interface ClubRow {
  id: number
  name: string
  description: string
  location: string
  type: string
  isPrivate: boolean
  joinPolicy: JoinPolicy
  memberCount: number
  isMember: boolean
  /** Miles covered by the members' activities in the last seven days. */
  weeklyDistance: number
  activitiesThisWeek: number
}

function text(value: unknown): string {
  return value == null ? '' : String(value)
}

function count(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

function policy(value: unknown): JoinPolicy {
  return value === 'request' || value === 'invite_only' ? value : 'open'
}

/** The directory. Public: private clubs are only listed to their members. */
export function clubsPath(): string {
  return '/api/clubs'
}

/** The club's own page, which the native screen hands off to. */
export function clubPath(id: number): string {
  return `/club/${id}`
}

/**
 * Joining and leaving are the same endpoint: the server holds the membership
 * and decides which way it goes, and answers with `joined`. A screen that
 * guesses the direction is a button that can disagree with the server about
 * what just happened.
 */
export function clubJoinRequest(id: number): { path: string, method: 'POST' } {
  return { path: `/api/clubs/${id}/join`, method: 'POST' }
}

/**
 * Whether the viewer is in this club.
 *
 * The listing sends `isMember` and withholds the roster on purpose. Older
 * payloads sent `members`, so both are read — and with neither, the answer is
 * no rather than a crash.
 */
export function isClubMember(club: unknown, viewerId: number | null = null): boolean {
  const row = club as { isMember?: unknown, members?: unknown } | null
  if (typeof row?.isMember === 'boolean')
    return row.isMember
  if (Array.isArray(row?.members) && viewerId != null)
    return row.members.map(Number).includes(viewerId)
  return false
}

export function clubRowsFrom(payload: unknown): ClubRow[] {
  const source = payload as { clubs?: unknown } | unknown[] | null
  const list = Array.isArray(source)
    ? source
    : Array.isArray((source as { clubs?: unknown })?.clubs)
      ? (source as { clubs: unknown[] }).clubs
      : []

  const rows: ClubRow[] = []
  for (const entry of list) {
    const row = entry as Record<string, unknown>
    const id = Number(row?.id)
    if (!Number.isFinite(id))
      continue

    rows.push({
      id,
      name: text(row.name) || 'Unnamed club',
      description: text(row.description),
      location: text(row.location),
      type: text(row.type),
      isPrivate: row.isPrivate === true,
      joinPolicy: policy(row.joinPolicy),
      memberCount: count(row.memberCount),
      isMember: isClubMember(row),
      weeklyDistance: count(row.weeklyDistance),
      activitiesThisWeek: count(row.activitiesThisWeek),
    })
  }
  return rows
}

export function matchesClubFilter(club: ClubRow, filter: ClubFilter): boolean {
  if (filter === 'all')
    return true
  if (filter === 'mine')
    return club.isMember
  return club.type === filter
}

export function filterClubs(rows: ClubRow[], filter: ClubFilter): ClubRow[] {
  return rows.filter(club => matchesClubFilter(club, filter))
}

/** `12 members`, and `1 member` without the limp plural. */
export function clubMemberText(memberCount: unknown): string {
  const members = count(memberCount)
  return members === 1 ? '1 member' : `${members.toLocaleString('en-US')} members`
}

/** Where it is and what it does, on one line. */
export function clubPlaceLine(club: Partial<ClubRow> | null | undefined): string {
  return [text(club?.location), text(club?.type)].filter(part => part !== '').join(' · ')
}

/**
 * What kind of door the club has, where that is not already obvious from the
 * button beside it. An open public club says nothing, because "Join" has
 * already said it.
 */
export function clubDoorLabel(club: Partial<ClubRow> | null | undefined): string {
  if (club?.joinPolicy === 'invite_only')
    return 'Invite only'
  if (club?.joinPolicy === 'request')
    return 'Ask to join'
  if (club?.isPrivate)
    return 'Members only'
  return ''
}

/**
 * The club's last seven days, aggregated from its members' activities.
 *
 * A club with nothing in it says so. The web page shows two zeroes in a metric
 * row, which on a phone row would read as a broken number rather than a quiet
 * week.
 */
export function clubWeekLine(club: Partial<ClubRow> | null | undefined): string {
  const miles = count(club?.weeklyDistance)
  const activities = count(club?.activitiesThisWeek)
  if (miles === 0 && activities === 0)
    return 'Quiet week'

  const parts: string[] = []
  if (miles > 0)
    parts.push(`${miles.toLocaleString('en-US')} mi`)
  if (activities > 0)
    parts.push(activities === 1 ? '1 activity' : `${activities.toLocaleString('en-US')} activities`)
  return `${parts.join(' · ')} this week`
}

/**
 * What the join control should say.
 *
 * An invite-only club the viewer is not in cannot be joined from a list at
 * all — the web page shows "View" and sends them to the club's page, which is
 * where an invite would be waiting.
 */
export function clubActionLabel(club: Partial<ClubRow> | null | undefined): 'Leave' | 'Join' | 'Ask to join' | 'View' {
  if (club?.isMember)
    return 'Leave'
  if (club?.joinPolicy === 'invite_only')
    return 'View'
  if (club?.joinPolicy === 'request')
    return 'Ask to join'
  return 'Join'
}
