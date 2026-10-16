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

// ── One club's own page ──────────────────────────────────────────────────────

/**
 * The reading half of `/club/:id`, added when it was promoted to a native
 * screen. The list screen already shares the door label, the member count and
 * the week line; this adds the detail payload, the roles and the invites.
 */

/**
 * One club, on the API.
 *
 * Distinct from `clubPath`, which is the *web page* (`/club/2`) that the list
 * screen used to hand off to. Building the invites path on that one produced
 * `/club/2/invites`, which is not an endpoint — the name reads like an API
 * path and is not one.
 */
export function clubApiPath(id: number): string {
  return `/api/clubs/${encodeURIComponent(String(id))}`
}

/** `/api/clubs/{id}` answers `{ success, club }`, not a bare club. */
export function clubDetailFrom(payload: unknown): any | null {
  const envelope = payload as any
  const club = envelope?.club ?? null
  return club && club.id != null ? club : null
}

export function clubInvitesPath(id: number): string {
  return `${clubApiPath(id)}/invites`
}

/** Redeeming is club-agnostic: the code says which club it is for. */
export function clubRedeemPath(): string {
  return '/api/clubs/invites/accept'
}

export function clubDeleteRequest(id: number): { path: string, method: 'DELETE' } {
  return { path: clubApiPath(id), method: 'DELETE' }
}

export type ClubRole = 'owner' | 'admin' | 'member'

/** The viewer's role in this club, or null when they are not in it. */
export function clubRoleOf(club: any, viewerId: number | null | undefined): ClubRole | null {
  if (!club || viewerId == null || viewerId <= 0)
    return null
  const members = Array.isArray(club.members) ? club.members : []
  const mine = members.find((member: any) => Number(member?.userId) === viewerId)
  const role = String(mine?.role ?? '')
  return role === 'owner' || role === 'admin' || role === 'member' ? role : null
}

/**
 * Who may invite: an owner or an admin.
 *
 * Read off the membership roster rather than guessed from `isMember`, because
 * a plain member seeing an invite form would be offered something the API
 * refuses.
 */
export function canInviteToClub(club: any, viewerId: number | null | undefined): boolean {
  const role = clubRoleOf(club, viewerId)
  return role === 'owner' || role === 'admin'
}

/** Only the creator may delete a club, and never by role alone. */
export function canDeleteClub(club: any, viewerId: number | null | undefined): boolean {
  return Boolean(club && viewerId != null && viewerId > 0 && Number(club.creatorId) === viewerId)
}

/**
 * Whether an invite code is worth sending to the server.
 *
 * Eight characters is what the web page holds out for, and it is the
 * difference between "that code did not work" from the API and telling
 * somebody they have not finished typing.
 */
export const MIN_INVITE_CODE = 8

export function isRedeemable(code: unknown): boolean {
  return typeof code === 'string' && code.trim().length >= MIN_INVITE_CODE
}

/** One invite, as a line: who it is for, or that it is open to anybody. */
export function inviteLine(invite: any): string {
  return String(invite?.invitedName || invite?.invitedEmail || 'Open invite')
}

export function inviteStatusText(invite: any): string {
  return String(invite?.status ?? 'pending')
}

/** The invites a club has, newest first, out of `{ invites }`. */
export function inviteRowsFrom(payload: unknown): any[] {
  const invites = (payload as any)?.invites
  if (!Array.isArray(invites))
    return []
  return invites
    .filter((invite: any) => invite && invite.id != null)
    .slice()
    .sort((a: any, b: any) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
}

/** One member, as a line. */
export function memberLine(member: any): string {
  return String(member?.name ?? 'Member')
}

export function memberRoleText(member: any): string {
  const role = String(member?.role ?? 'member')
  return role.charAt(0).toUpperCase() + role.slice(1)
}

export function clubWeeklyDistanceText(club: any): string {
  return `${Number(club?.weeklyDistance ?? 0).toFixed(1)} mi`
}

export function clubWeeklyActivitiesText(club: any): string {
  return String(club?.activitiesThisWeek ?? 0)
}
