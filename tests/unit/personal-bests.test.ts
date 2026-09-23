import { describe, expect, it } from 'bun:test'
import { formatDuration, monthlyProgress, personalBests, shareText } from '../../resources/functions/personal-bests'

const runs = [
  { id: 1, title: 'Skyline loop', distance: 4.9, movingTime: '0:58:00', duration: '1:05:00', elevationGain: 400, completedAt: '2026-03-02T08:00:00Z' },
  { id: 2, title: 'Ridge traverse', distance: 3.2, movingTime: '1:46:10', elevationGain: 866, completedAt: '2026-09-12T08:00:00Z' },
  { id: 3, title: 'Last year', distance: 2, movingTime: '0:20:00', elevationGain: 10, completedAt: '2025-09-12T08:00:00Z' },
]

describe('personal bests', () => {
  it('finds each record and the activity that set it', () => {
    const bests = personalBests(runs)

    expect(bests.map(b => [b.key, b.value, b.activityId])).toEqual([
      ['distance', '4.9 mi', 1],
      ['time', '1h 46m', 2],
      ['elevation', '866 ft', 2],
    ])
  })

  it('counts moving time, not time stood at the trailhead', () => {
    const [, time] = personalBests([{ id: 9, distance: 1, movingTime: '0:30:00', duration: '2:00:00' }])
    expect(time.value).toBe('30m')
  })

  it('leaves out a record nothing has set, and shows nothing for no activities', () => {
    expect(personalBests([{ id: 4, distance: 2, movingTime: '0:20:00' }]).map(b => b.key)).toEqual(['distance', 'time'])
    expect(personalBests([])).toEqual([])
  })

  it('adds up this year by month and ignores other years', () => {
    const months = monthlyProgress(runs, 2026)

    expect(months).toHaveLength(12)
    expect(months[2].miles).toBe(4.9)
    expect(months[8].miles).toBe(3.2)
    expect(months.reduce((sum, m) => sum + m.miles, 0)).toBeCloseTo(8.1)
  })

  it('formats durations and share text for a person, not a parser', () => {
    expect(formatDuration(59 * 60)).toBe('59m')
    expect(formatDuration(3600 + 60)).toBe('1h 1m')
    expect(shareText(personalBests(runs)[0])).toBe('Longest activity: 4.9 mi on Wildloop')
  })
})
