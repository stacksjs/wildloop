import { describe, expect, it } from 'bun:test'
import { summariseCompletions } from '../../app/Support/completed-trails'
import { completedLabel } from '../../resources/functions/my-trails'

describe('summariseCompletions', () => {
  it('counts activities per trail and keeps the latest date', () => {
    const result = summariseCompletions([
      { trail_id: 7, completed_at: '2026-06-01T08:00:00Z' },
      { trail_id: 7, completed_at: '2026-09-09T08:00:00Z' },
      { trail_id: 3, completed_at: '2026-07-04T08:00:00Z' },
    ])
    expect(result).toEqual([
      { trailId: 7, times: 2, lastCompletedAt: '2026-09-09T08:00:00Z' },
      { trailId: 3, times: 1, lastCompletedAt: '2026-07-04T08:00:00Z' },
    ])
  })

  it('ignores activities without a trail', () => {
    expect(summariseCompletions([{ trail_id: null }, { trail_id: 0 }])).toEqual([])
  })

  it('adds saved trails marked visited, once, after an activity on the same trail', () => {
    const result = summariseCompletions(
      [{ trail_id: 7, completed_at: '2026-09-09T08:00:00Z' }],
      [
        { trail_id: 7, updated_at: '2026-01-01T00:00:00Z' },
        { trail_id: 12, updated_at: '2026-08-01T00:00:00Z' },
      ],
    )
    expect(result).toEqual([
      { trailId: 7, times: 1, lastCompletedAt: '2026-09-09T08:00:00Z' },
      { trailId: 12, times: 0, lastCompletedAt: '2026-08-01T00:00:00Z' },
    ])
  })

  it('falls back to created_at, and puts undated trails last', () => {
    const result = summariseCompletions([
      { trail_id: 5 },
      { trail_id: 9, created_at: '2026-05-05T00:00:00Z' },
    ])
    expect(result.map(c => c.trailId)).toEqual([9, 5])
    expect(result[1].lastCompletedAt).toBeNull()
  })
})

describe('completedLabel', () => {
  it('says how often and when', () => {
    expect(completedLabel(1, '2026-09-09T22:30:27Z')).toBe('Done Sep 9, 2026')
    expect(completedLabel(3, '2026-09-09T22:30:27Z')).toBe('Done 3 times · last Sep 9, 2026')
  })

  it('handles a visit marked without an activity, and missing dates', () => {
    expect(completedLabel(0, '2026-09-09T22:30:27Z')).toBe('Marked as done')
    expect(completedLabel(1, null)).toBe('Done once')
    expect(completedLabel(2, 'not a date')).toBe('Done 2 times')
  })
})
