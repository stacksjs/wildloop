/**
 * The territory battle feed, as both pages that read it read it.
 *
 * `/api/territories/battles` answers one row shape and two pages tell two
 * different stories with it: `/battles` is the game's feed, in the third
 * person, and `/conquests` is the player's own record, in the second. The
 * voices differ enough that each used to carry its own `battleBadge` — and
 * they disagreed, so the same battle read "Conquered" on one page and "Lost"
 * on the other with nothing saying which was meant.
 *
 * Both are here now, named for whose story they tell: `feedBadge`/`feedVerb`
 * against `ownBadge`/`ownLine`. The counters stay in `conquest-stats.ts`,
 * which already folds a record out of these rows.
 *
 * Nothing here may touch a web API — `battlesPath` builds its query with
 * `encodeURIComponent`, because the native runtime defines no
 * `URLSearchParams`.
 *
 * @module functions/battles
 */

import type { MapBounds } from './map-area'
import { mapBoundsContain } from './map-area'

/** The feed is the newest in the whole game; a player's own record is not. */
export const FEED_LIMIT = 200
export const OWN_LIMIT = 1000

/** One battle, as the API answers it. Already snake_case — no translation. */
export interface BattleRow {
  id: number
  territory_id: number
  territoryName: string
  centerLat: number | null
  centerLng: number | null
  attacker_id: number
  attackerName: string
  attackerAvatar: string | null
  defender_id: number
  defenderName: string
  defenderAvatar: string | null
  status: 'active' | 'conquered' | 'defended'
  areaCaptured: number
  runDistance: number
  description: string
  created_at: string
}

export function battlesPath(options: { mine?: boolean, limit?: number } = {}): string {
  const limit = options.limit ?? (options.mine ? OWN_LIMIT : FEED_LIMIT)
  const mine = options.mine ? '&mine=1' : ''
  return `/api/territories/battles?limit=${encodeURIComponent(String(limit))}${mine}`
}

export function battleRowsFrom(payload: unknown): BattleRow[] {
  const battles = (payload as any)?.battles
  if (!Array.isArray(battles))
    return []

  const rows: BattleRow[] = []
  for (const row of battles) {
    if (!row || row.id == null)
      continue
    rows.push({
      id: Number(row.id),
      territory_id: Number(row.territory_id ?? 0),
      territoryName: String(row.territoryName ?? `Territory #${row.territory_id ?? 0}`),
      centerLat: row.centerLat == null ? null : Number(row.centerLat),
      centerLng: row.centerLng == null ? null : Number(row.centerLng),
      attacker_id: Number(row.attacker_id ?? 0),
      attackerName: String(row.attackerName ?? 'An attacker'),
      attackerAvatar: row.attackerAvatar ?? null,
      defender_id: Number(row.defender_id ?? 0),
      defenderName: String(row.defenderName ?? 'the previous owner'),
      defenderAvatar: row.defenderAvatar ?? null,
      status: row.status === 'conquered' || row.status === 'defended' ? row.status : 'active',
      areaCaptured: Number(row.areaCaptured ?? 0),
      runDistance: Number(row.runDistance ?? 0),
      description: String(row.description ?? ''),
      created_at: String(row.created_at ?? ''),
    })
  }
  return rows
}

// ── The feed: every battle in the game, in the third person ──────────────────

export const BATTLE_PERIODS = ['today', 'week', 'all'] as const
export type BattlePeriod = typeof BATTLE_PERIODS[number]

export const BATTLE_PERIOD_LABELS: Record<BattlePeriod, string> = {
  today: 'Today',
  week: 'This week',
  all: 'All time',
}

/**
 * Battles inside a period.
 *
 * `now` is a parameter rather than read from the clock, so a test can say what
 * "today" means instead of depending on when it runs. `today` is midnight
 * local, matching what the web page showed.
 */
export function filterBattlesByPeriod(battles: BattleRow[], period: BattlePeriod, now = Date.now()): BattleRow[] {
  if (period === 'all')
    return battles

  const since = period === 'today'
    ? new Date(now).setHours(0, 0, 0, 0)
    : now - 7 * 86_400_000

  return battles.filter((battle) => {
    const at = new Date(battle.created_at).getTime()
    return Number.isFinite(at) && at >= since
  })
}

/** Battles whose territory centre falls inside a box. */
export function filterBattlesByArea(battles: BattleRow[], box: MapBounds | null | undefined): BattleRow[] {
  if (!box)
    return battles
  return battles.filter(battle =>
    battle.centerLat != null
    && battle.centerLng != null
    && mapBoundsContain(box, battle.centerLat, battle.centerLng),
  )
}

export function liveBattles(battles: BattleRow[]): BattleRow[] {
  return battles.filter(battle => battle.status === 'active')
}

export function countByStatus(battles: BattleRow[], status: BattleRow['status']): number {
  return battles.filter(battle => battle.status === status).length
}

/**
 * What happened, told about other people.
 *
 * A contest still open reads as an attack in progress rather than a failed
 * one — the owner has not answered it yet.
 */
export function feedVerb(battle: BattleRow): string {
  if (battle.status === 'conquered')
    return 'conquered'
  if (battle.status === 'active')
    return 'is attacking'
  return 'failed to conquer'
}

export function feedBadge(battle: BattleRow): string {
  if (battle.status === 'conquered')
    return 'Conquered'
  if (battle.status === 'active')
    return 'Contested'
  return 'Defended'
}

/** "Marta is attacking Balboa Loop", in one string a template can interpolate. */
export function feedLine(battle: BattleRow): string {
  return `${battle.attackerName} ${feedVerb(battle)} ${battle.territoryName}`
}

// ── The player's own record, in the second person ─────────────────────────────

export const CONQUEST_FILTERS = ['all', 'attacks', 'defenses', 'lost'] as const
export type ConquestFilter = typeof CONQUEST_FILTERS[number]

export const CONQUEST_FILTER_LABELS: Record<ConquestFilter, string> = {
  all: 'All',
  attacks: 'Attacks',
  defenses: 'Defenses',
  lost: 'Lost',
}

export function isMyAttack(battle: BattleRow, viewerId: number | null | undefined): boolean {
  return viewerId != null && battle.attacker_id === viewerId
}

/**
 * The battles an athlete was actually in.
 *
 * "All" used to list every battle in the game under "Your conquests", each
 * labelled as though the player had been on one side of it.
 */
export function ownBattles(battles: BattleRow[], viewerId: number | null | undefined): BattleRow[] {
  if (!viewerId)
    return []
  return battles.filter(battle => battle.attacker_id === viewerId || battle.defender_id === viewerId)
}

export function filterConquests(
  battles: BattleRow[],
  filter: ConquestFilter,
  viewerId: number | null | undefined,
): BattleRow[] {
  const mine = ownBattles(battles, viewerId)
  if (filter === 'attacks')
    return mine.filter(battle => battle.attacker_id === viewerId)
  if (filter === 'defenses')
    return mine.filter(battle => battle.defender_id === viewerId)
  if (filter === 'lost')
    return mine.filter(battle => battle.defender_id === viewerId && battle.status === 'conquered')
  return mine
}

/**
 * What happened, from the player's side, up to but not including the zone.
 *
 * Split from `ownLine` because the two callers need different ends of it: the
 * web page links the territory name as its own element, so it wants the phrase
 * that stops before it, and the native screen wants the whole sentence. One of
 * them slicing the other's string back apart is how they drift.
 *
 * Every attack used to read "You conquered", including one that only contested
 * the land and one the owner ran off; every defence read "attacked", including
 * the ones that were lost.
 */
export function ownPhrase(battle: BattleRow, viewerId: number | null | undefined): string {
  if (isMyAttack(battle, viewerId)) {
    if (battle.status === 'conquered')
      return `You took ground from ${battle.defenderName} at`
    if (battle.status === 'active')
      return 'You are contesting'
    return `${battle.defenderName} held you off at`
  }
  if (battle.status === 'conquered')
    return `${battle.attackerName} took ground from you at`
  if (battle.status === 'active')
    return `${battle.attackerName} is attacking`
  return `You held off ${battle.attackerName} at`
}

/** The same thing as one sentence, for a screen with nothing to link. */
export function ownLine(battle: BattleRow, viewerId: number | null | undefined): string {
  return `${ownPhrase(battle, viewerId)} ${battle.territoryName}`
}

export function ownBadge(battle: BattleRow, viewerId: number | null | undefined): string {
  if (isMyAttack(battle, viewerId))
    return battle.status === 'conquered' ? 'Conquered' : battle.status === 'active' ? 'Contesting' : 'Repelled'
  return battle.status === 'conquered' ? 'Lost' : battle.status === 'active' ? 'Under attack' : 'Defended'
}

/** Whether the player came out ahead. Null while the battle is still open. */
export function wonBattle(battle: BattleRow, viewerId: number | null | undefined): boolean | null {
  if (battle.status === 'active')
    return null
  return isMyAttack(battle, viewerId)
    ? battle.status === 'conquered'
    : battle.status === 'defended'
}

/** Ground of the player's being taken right now, newest first. */
export function underAttack(battles: BattleRow[], viewerId: number | null | undefined, limit = 5): BattleRow[] {
  if (!viewerId)
    return []
  return battles
    .filter(battle => battle.defender_id === viewerId && battle.status === 'active')
    .slice(0, limit)
}

export function conquestEmptyText(filter: ConquestFilter): string {
  if (filter === 'attacks')
    return 'You have not attacked anybody\'s ground yet.'
  if (filter === 'defenses')
    return 'Nobody has come for your ground yet.'
  if (filter === 'lost')
    return 'You have not lost a zone. Yet.'
  return 'No battles yet. Run a closed loop across somebody else\'s zone.'
}

// ── On one territory's own page ───────────────────────────────────────────────

/**
 * This zone's battles, newest first.
 *
 * The feed is the whole game, so a territory's history is filtered out of it.
 * Sorted here rather than trusted: the endpoint orders by `created_at desc`,
 * and a page that depends on that silently reorders the day it does not.
 */
export function territoryHistory(battles: BattleRow[], territoryId: number): BattleRow[] {
  return battles
    .filter(battle => battle.territory_id === territoryId)
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

/**
 * What happened, told on the zone's own page.
 *
 * A third voice, and it has to be: the feed names the territory ("Marta is
 * attacking Balboa Loop") and here the reader is already looking at it, so the
 * line is relative to the ground instead — "is attacking it".
 */
export function herePhrase(battle: BattleRow): string {
  if (battle.status === 'conquered')
    return 'took ground here'
  if (battle.status === 'active')
    return 'is attacking it'
  return 'was held off'
}

/** "Marta is attacking it", for a screen with no separate attacker element. */
export function hereLine(battle: BattleRow): string {
  return `${battle.attackerName} ${herePhrase(battle)}`
}
