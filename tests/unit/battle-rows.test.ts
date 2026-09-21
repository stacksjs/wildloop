import { describe, expect, it } from 'bun:test'
import { isAnsweredContest } from '../../app/Support/battleRows'

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
