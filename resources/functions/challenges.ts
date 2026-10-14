/**
 * Shared shaping for Challenge API responses (#965). Auto-imported into the
 * Challenge actions so every endpoint returns the same camelCase shape the
 * frontend store expects.
 */

import { formatTerritoryArea } from './territory-style'

export interface ChallengeNames {
  challengerName?: string
  challengedName?: string
  challengerAvatar?: string | null
  challengedAvatar?: string | null
  territoryName?: string
}

export function shapeChallenge(c: any, names: ChallengeNames = {}): any {
  return {
    id: c.id,
    challengerId: c.challenger_id,
    challengerName: names.challengerName ?? 'Unknown',
    challengedId: c.challenged_id,
    challengedName: names.challengedName ?? 'Unknown',
    challengerAvatar: names.challengerAvatar ?? null,
    challengedAvatar: names.challengedAvatar ?? null,
    territoryId: c.territory_id,
    territoryName: names.territoryName ?? 'Territory',
    status: c.status,
    winnerId: c.winner_id ?? null,
    areaAtStake: c.area_at_stake ?? 0,
    deadline: c.deadline,
    createdAt: c.created_at,
  }
}

/*
 * Below: what both the web page and the native screen need to read a
 * challenge, added when `/challenges` was promoted to a native screen.
 *
 * `shapeChallenge` above is the server's half — every Challenge endpoint
 * answers in that shape. These are the client's half, and they take that shape
 * as it arrives rather than the snake_case the web store converts it back to.
 */

/** The tabs, in the order the web page shows them. */
export const CHALLENGE_TABS = ['active', 'sent', 'received', 'completed'] as const

export type ChallengeTab = typeof CHALLENGE_TABS[number]

export const CHALLENGE_TAB_LABELS: Record<ChallengeTab, string> = {
  active: 'Active',
  sent: 'Sent',
  received: 'Received',
  completed: 'Completed',
}

export type ChallengeStatus = 'pending' | 'active' | 'completed' | 'declined'

export interface ChallengeRow {
  id: number
  challengerId: number
  challengerName: string
  challengedId: number
  challengedName: string
  territoryId: number
  territoryName: string
  status: ChallengeStatus
  winnerId: number | null
  /** Square metres, copied from the territory at the time of the challenge. */
  areaAtStake: number
  createdAt: string
}

function status(value: unknown): ChallengeStatus {
  return value === 'active' || value === 'completed' || value === 'declined' ? value : 'pending'
}

function id(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** `/api/challenges` — the viewer's own, both directions. Needs their token. */
export function challengesPath(): string {
  return '/api/challenges'
}

/** Accepting and declining are one endpoint, told apart by the body. */
export function challengeRespondRequest(challengeId: number, action: 'accept' | 'decline'): {
  path: string
  method: 'POST'
  body: { action: 'accept' | 'decline' }
} {
  return { path: `/api/challenges/${challengeId}/respond`, method: 'POST', body: { action } }
}

/** The territory at stake, which is a map and stays the website. */
export function territoryPath(territoryId: number): string {
  return `/territory/${territoryId}`
}

export function challengeRowsFrom(payload: unknown): ChallengeRow[] {
  const source = payload as { challenges?: unknown } | unknown[] | null
  const list = Array.isArray(source)
    ? source
    : Array.isArray((source as { challenges?: unknown })?.challenges)
      ? (source as { challenges: unknown[] }).challenges
      : []

  const rows: ChallengeRow[] = []
  for (const entry of list) {
    const c = entry as Record<string, unknown>
    const rowId = Number(c?.id)
    if (!Number.isFinite(rowId))
      continue

    rows.push({
      id: rowId,
      // Both spellings: the API answers in camelCase, and the web store keeps
      // its own snake_case copy. A screen reading one of them reads half the
      // rows as belonging to nobody.
      challengerId: id(c.challengerId ?? c.challenger_id),
      challengerName: String(c.challengerName ?? 'Unknown'),
      challengedId: id(c.challengedId ?? c.challenged_id),
      challengedName: String(c.challengedName ?? 'Unknown'),
      territoryId: id(c.territoryId ?? c.territory_id),
      territoryName: String(c.territoryName ?? 'Territory'),
      status: status(c.status),
      winnerId: c.winnerId == null && c.winner_id == null ? null : id(c.winnerId ?? c.winner_id),
      areaAtStake: Math.max(0, Number(c.areaAtStake ?? c.area_at_stake) || 0),
      createdAt: String(c.createdAt ?? c.created_at ?? ''),
    })
  }
  return rows
}

export function matchesChallengeTab(row: ChallengeRow, tab: ChallengeTab, viewerId: number): boolean {
  if (tab === 'active')
    return row.status === 'active' || row.status === 'pending'
  if (tab === 'sent')
    return row.challengerId === viewerId
  if (tab === 'received')
    return row.challengedId === viewerId
  return row.status === 'completed'
}

export function filterChallenges(rows: ChallengeRow[], tab: ChallengeTab, viewerId: number): ChallengeRow[] {
  return rows.filter(row => matchesChallengeTab(row, tab, viewerId))
}

/**
 * Where the challenge stands, from the viewer's side.
 *
 * A finished challenge is Won or Lost rather than "completed", because
 * "completed" is the same word for both people and only one of them won.
 */
export function challengeStatusText(row: Partial<ChallengeRow> | null | undefined, viewerId: number): string {
  if (row?.status === 'active')
    return 'In progress'
  if (row?.status === 'pending')
    return 'Pending'
  if (row?.status === 'declined')
    return 'Declined'
  return row?.winnerId === viewerId ? 'Won' : 'Lost'
}

/**
 * Who is on each side, with the viewer as "You".
 *
 * The web page mirrors the two around a VS mark, which needs the width of a
 * card. One line says the same thing.
 */
export function challengeVersusLine(row: Partial<ChallengeRow> | null | undefined, viewerId: number): string {
  const challenger = row?.challengerId === viewerId ? 'You' : String(row?.challengerName ?? 'Unknown')
  const challenged = row?.challengedId === viewerId ? 'You' : String(row?.challengedName ?? 'Unknown')
  return `${challenger} vs ${challenged}`
}

/**
 * The ground at stake.
 *
 * Square metres, because it is copied from the territory. It was once shown as
 * `/ 1000` km² — a thousandfold overstatement — so the unit is picked by the
 * shared formatter rather than by whoever writes the markup.
 */
export function challengeStakeText(areaAtStake: unknown): string {
  return `${formatTerritoryArea(Math.max(0, Number(areaAtStake) || 0))} at stake`
}

/** Only the defender answers, and only while it is still being asked. */
export function canRespondToChallenge(row: Partial<ChallengeRow> | null | undefined, viewerId: number): boolean {
  return row?.challengedId === viewerId && row?.status === 'pending'
}

/** Whose answer a pending challenge is waiting on, said from the viewer's side. */
export function challengeWaitingText(row: Partial<ChallengeRow> | null | undefined, viewerId: number): string {
  if (row?.status !== 'pending' || row?.challengerId !== viewerId)
    return ''
  return `Waiting for ${row?.challengedName ?? 'them'} to respond`
}

export function challengeEmptyText(tab: ChallengeTab): string {
  if (tab === 'sent')
    return 'You have not sent any'
  if (tab === 'received')
    return 'Nobody has challenged you'
  if (tab === 'completed')
    return 'No finished challenges yet'
  return 'No active challenges'
}
