import { describe, expect, it } from 'bun:test'
import { summariseCompletions } from '../../app/Support/completed-trails'

/**
 * "Marked as done" is a note to yourself about a trail you walked before
 * Wildloop, or recorded without picking the trail. It is self-reported, not
 * evidence that you were there, so it must never earn anything: no
 * achievement, no leaderboard place, no counter, and nothing anti-cheat
 * weighs. Those are computed from recorded activities and the territory they
 * won.
 *
 * The mark lives on `saved_trails.has_visited`. Nothing that hands out
 * standing, or judges whether an activity was real, may read it.
 */

const earnsSomething = [
  'app/Actions/Achievement/EvaluateAchievementsAction.ts',
  'app/Actions/Achievement/UserAchievementsAction.ts',
  'resources/functions/achievements.ts',
  'app/Actions/Activity/ActivityLeaderboardAction.ts',
  'app/Actions/Territory/TerritoryLeaderboardAction.ts',
  'app/Actions/Territory/ClaimTerritoryAction.ts',
  'app/Actions/Social/AthleteShowAction.ts',
  'app/Actions/Maintenance/RecomputeCountersAction.ts',
  'app/Support/activityIntegrityCheck.ts',
  'resources/functions/activity-anomaly.ts',
]

describe('a trail marked as done by hand', () => {
  it.each(earnsSomething)('is invisible to %s', async (path) => {
    const source = await Bun.file(path).text()
    expect(source, path).not.toContain('has_visited')
    expect(source, path).not.toContain('saved_trails')
    expect(source, path).not.toContain('SavedTrail')
  })

  it('counts as no activity on the trail', () => {
    expect(summariseCompletions([], [{ trail_id: 12, updated_at: '2026-08-01T00:00:00Z' }]))
      .toEqual([{ trailId: 12, times: 0, lastCompletedAt: '2026-08-01T00:00:00Z' }])
  })

  it('does not add to the activities recorded on the same trail', () => {
    const [seven] = summariseCompletions(
      [{ trail_id: 7, completed_at: '2026-09-09T08:00:00Z' }, { trail_id: 7, completed_at: '2026-09-10T08:00:00Z' }],
      [{ trail_id: 7, updated_at: '2026-09-20T00:00:00Z' }],
    )
    expect(seven.times).toBe(2)
    // The mark cannot backdate or post-date the walking either.
    expect(seven.lastCompletedAt).toBe('2026-09-10T08:00:00Z')
  })

  it('cannot be taken back where an activity is the evidence', async () => {
    // The page offers the mark only as a mark: a trail done by recording it
    // stays done, and the button says so rather than pretending to undo it.
    const page = await Bun.file('resources/views/trail/[id].stx').text()
    expect(page).toContain('doneByActivity')
    expect(page).toMatch(/if \(markingDone\(\) \|\| doneByActivity\(\)\)\s*\n\s*return/)
  })
})
