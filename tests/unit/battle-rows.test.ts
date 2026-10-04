import { describe, expect, it } from 'bun:test'
import { isAnsweredContest, pairSplitRows } from '../../app/Support/battleRows'

describe('the battle board', () => {
  it('shows a contest the owner later defended once, as the defence', () => {
    const defended = { territory_id: 6, event_type: 'defended' }
    const contest = { territory_id: 6, event_type: 'contested' }
    const rows = [defended, contest] // newest first
    expect(isAnsweredContest(rows, contest)).toBe(true)
    expect(isAnsweredContest(rows, defended)).toBe(false)
  })

  it('keeps a contest nobody has answered yet: that is the live battle', () => {
    const live = { territory_id: 1, event_type: 'contested' }
    const elsewhere = { territory_id: 6, event_type: 'defended' }
    expect(isAnsweredContest([elsewhere, live], live)).toBe(false)
  })

  it('treats a takeover after a contest as the answer too', () => {
    const takeover = { territory_id: 5, event_type: 'conquered' }
    const contest = { territory_id: 5, event_type: 'contested' }
    expect(isAnsweredContest([takeover, contest], contest)).toBe(true)
  })
})

describe('a split on the battle board', () => {
  // What ProcessActivityConquestAction writes when Bob (2) cuts Alice's (1)
  // territory 6 and takes the smaller side as territory 9. Newest first.
  const split = { id: 21, territory_id: 6, event_type: 'split', user_id: 1, previous_owner_id: null, new_territory_id: 9, area_at_event: 30_000 }
  const taken = { id: 22, territory_id: 9, event_type: 'conquered', user_id: 2, previous_owner_id: 1, new_territory_id: null, area_at_event: 12_000 }

  it('is one battle, Bob taking ground from Alice, not Alice conquering herself', () => {
    const rows = pairSplitRows([taken, split])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ territory_id: 6, event_type: 'conquered', user_id: 2, previous_owner_id: 1, area_at_event: 12_000 })
  })

  it('reports the area taken, not the area kept', () => {
    expect(pairSplitRows([split, taken])[0].area_at_event).toBe(12_000)
  })

  it('leaves out a split whose other half is outside the window', () => {
    expect(pairSplitRows([split])).toEqual([])
  })

  it('leaves every other event alone', () => {
    const contest = { id: 3, territory_id: 4, event_type: 'contested', user_id: 2 }
    const takeover = { id: 4, territory_id: 5, event_type: 'conquered', user_id: 2, previous_owner_id: 1 }
    expect(pairSplitRows([contest, takeover])).toEqual([contest, takeover])
  })
})
