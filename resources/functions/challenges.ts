/**
 * Shared shaping for Challenge API responses (#965). Auto-imported into the
 * Challenge actions so every endpoint returns the same camelCase shape the
 * frontend store expects.
 */

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
