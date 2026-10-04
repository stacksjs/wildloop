import { describe, expect, it } from 'bun:test'
import { computeTerritoryDecay, DECAY_EXPIRE_DAYS, DECAY_STALE_DAYS } from '../../resources/functions/decay'
import { computeTerritoryRankAssignments } from '../../resources/functions/ranks'

const DAY = 86_400_000
const now = Date.parse('2026-10-03T12:00:00Z')
const daysAgo = (days: number) => new Date(now - days * DAY).toISOString()

describe('territory ranks', () => {
  it('ranks all time by the area held now', () => {
    const ranks = computeTerritoryRankAssignments([
      { id: 1, user_id: 10, total_area_owned: 50_000, total_territories_owned: 1 },
      { id: 2, user_id: 11, total_area_owned: 90_000, total_territories_owned: 2 },
    ], [], { now })
    expect(ranks.find(rank => rank.user_id === 11)?.all_time_rank).toBe(1)
    expect(ranks.find(rank => rank.user_id === 10)?.all_time_rank).toBe(2)
  })

  it('ranks the week by ground gained in it, not by the empire', () => {
    const ranks = computeTerritoryRankAssignments([
      { id: 1, user_id: 10, total_area_owned: 50_000 },
      { id: 2, user_id: 11, total_area_owned: 900_000 },
    ], [
      { user_id: 10, event_type: 'claimed', area_at_event: 40_000, created_at: daysAgo(2) },
      { user_id: 11, event_type: 'claimed', area_at_event: 900_000, created_at: daysAgo(30) },
    ], { now })
    expect(ranks.find(rank => rank.user_id === 10)?.weekly_rank).toBe(1)
  })

  it('does not rank a row whose player is gone, or count it against anyone', () => {
    const ranks = computeTerritoryRankAssignments([
      { id: 1, user_id: null, total_area_owned: 4_860_412 },
      { id: 2, user_id: 10, total_area_owned: 50_000 },
    ], [], { now })
    expect(ranks).toEqual([{ id: 2, user_id: 10, weekly_rank: 1, all_time_rank: 1 }])
  })
})

describe('territory decay', () => {
  it('contests land its owner has left alone, then expires it', () => {
    const plan = computeTerritoryDecay([
      { id: 1, user_id: 10, status: 'active', last_activity_at: daysAgo(DECAY_STALE_DAYS + 1) },
      { id: 2, user_id: 10, status: 'contested', last_activity_at: daysAgo(DECAY_EXPIRE_DAYS + 1) },
      { id: 3, user_id: 10, status: 'active', last_activity_at: daysAgo(1) },
      { id: 4, user_id: 10, status: 'contested', last_activity_at: daysAgo(DECAY_STALE_DAYS + 1) },
    ], { now })
    expect(plan.toContest.map(t => t.id)).toEqual([1])
    expect(plan.toExpire.map(t => t.id)).toEqual([2])
  })

  it('reads SQLite timestamps as UTC and falls back to the claim date', () => {
    const plan = computeTerritoryDecay([
      { id: 1, user_id: 10, status: 'active', last_activity_at: null, claimed_at: daysAgo(DECAY_STALE_DAYS + 1).replace('T', ' ').slice(0, 19) },
    ], { now })
    expect(plan.toContest.map(t => t.id)).toEqual([1])
  })

  it('leaves a territory with no usable date alone rather than guessing', () => {
    expect(computeTerritoryDecay([{ id: 1, user_id: 10, status: 'active' }], { now })).toEqual({ toContest: [], toExpire: [] })
  })
})
