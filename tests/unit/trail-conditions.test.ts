import { describe, expect, it } from 'bun:test'
import { activeDanger, conditionOption, conditionReports, TRAIL_CONDITION_IDS } from '../../resources/functions/trail-conditions'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

describe('trail conditions', () => {
  it('offers the old six and the new weather and hazards', () => {
    for (const id of ['excellent', 'good', 'fair', 'poor', 'muddy', 'icy', 'snowy', 'flooded', 'washed-out', 'extreme-heat', 'wildfire', 'closed', 'fallen-trees'])
      expect(TRAIL_CONDITION_IDS).toContain(id)
    expect(conditionOption('icy')?.severity).toBe('danger')
    expect(conditionOption('muddy')?.severity).toBe('caution')
    expect(conditionOption('good')?.severity).toBe('good')
    expect(conditionOption('lava')).toBeNull()
  })

  it('lists reports newest first, from the visit date when given, and drops old ones', () => {
    const reports = conditionReports([
      { conditions: 'good', userName: 'Ana', created_at: daysAgo(3), text: 'Dry.' },
      { conditions: 'icy', userName: 'Ben', created_at: daysAgo(1), visitDate: daysAgo(10), text: 'Ice at the top.' },
      { conditions: 'muddy', userName: 'Cy', created_at: daysAgo(90) },
      { conditions: '', userName: 'Di', created_at: daysAgo(1) },
    ], NOW)
    expect(reports.map(r => [r.id, r.by])).toEqual([['good', 'Ana'], ['icy', 'Ben']])
    expect(reports[1].note).toBe('Ice at the top.')
  })
})

describe('activeDanger', () => {
  it('flags a danger reported this week', () => {
    const reports = conditionReports([{ conditions: 'flooded', userName: 'Ana', created_at: daysAgo(2) }], NOW)
    expect(activeDanger(reports, NOW)?.id).toBe('flooded')
  })

  it('lets a newer good report clear it, but not a caution one', () => {
    const cleared = conditionReports([
      { conditions: 'icy', userName: 'Ana', created_at: daysAgo(4) },
      { conditions: 'good', userName: 'Ben', created_at: daysAgo(1) },
    ], NOW)
    expect(activeDanger(cleared, NOW)).toBeNull()

    const muddy = conditionReports([
      { conditions: 'icy', userName: 'Ana', created_at: daysAgo(4) },
      { conditions: 'muddy', userName: 'Ben', created_at: daysAgo(1) },
    ], NOW)
    expect(activeDanger(muddy, NOW)?.id).toBe('icy')
  })

  it('ignores dangers older than a week', () => {
    const reports = conditionReports([{ conditions: 'wildfire', userName: 'Ana', created_at: daysAgo(9) }], NOW)
    expect(activeDanger(reports, NOW)).toBeNull()
  })
})
