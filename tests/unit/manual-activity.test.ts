import { describe, expect, it } from 'bun:test'
import { buildManualActivity, todayLocal } from '../../resources/functions/manual-activity'

const input = {
  type: 'Trail Run',
  distance: '5.126',
  duration: '45:30',
  elevation: '801.6',
  trailId: '7',
  date: '2026-09-08',
  notes: '  ridge loop  ',
  visibility: 'followers',
}

describe('buildManualActivity', () => {
  it('builds the same real API payload for web and native manual entry', () => {
    const result = buildManualActivity(input, 12, {
      now: new Date('2026-09-10T08:00:00-07:00'),
      uploadId: 'manual:test-id',
    })
    expect(result).toEqual({
      ok: true,
      movingSeconds: 2730,
      payload: {
        user_id: 12,
        trail_id: 7,
        activity_type: 'Trail Run',
        distance: 5.13,
        duration: '45:30',
        moving_time: '45:30',
        pace: '8:53/mi',
        elevation: 802,
        notes: 'ridge loop',
        visibility: 'followers',
        completed_at: new Date('2026-09-08T12:00:00').toISOString(),
        upload_id: 'manual:test-id',
        recording_source: 'manual',
        game_mode: 'none',
      },
    })
  })

  it('uses the current instant for an entry made today', () => {
    const now = new Date('2026-09-10T08:00:00-07:00')
    const result = buildManualActivity({ ...input, date: todayLocal(now) }, 12, { now, uploadId: 'manual:today' })
    expect(result.ok && result.payload.completed_at).toBe(now.toISOString())
  })

  it.each([
    [{ ...input, type: 'Swim' }, 'Pick an activity type'],
    [{ ...input, distance: '0' }, 'Distance must be a positive number of miles'],
    [{ ...input, duration: 'forty minutes' }, 'Duration must look like 45:30 or 1:45:30'],
    [{ ...input, elevation: '-1' }, 'Elevation must be a non-negative number of feet'],
    [{ ...input, trailId: '2.5' }, 'Trail must be a positive whole number'],
    [{ ...input, visibility: 'friends' }, 'Pick who can see the activity'],
    [{ ...input, date: 'tomorrow' }, 'Date must look like YYYY-MM-DD'],
    [{ ...input, date: '2026-02-30' }, 'Date is not valid'],
  ])('rejects invalid manual input before an API request', (candidate, error) => {
    expect(buildManualActivity(candidate, 12, { uploadId: 'manual:invalid' })).toEqual({ ok: false, error })
  })

  it('requires an authenticated Wildloop user', () => {
    expect(buildManualActivity(input, 0, { uploadId: 'manual:no-user' })).toEqual({
      ok: false,
      error: 'Sign in before saving an activity',
    })
  })
})
