import { describe, expect, it } from 'bun:test'
import { runSaveMessage } from '../../resources/assets/scripts/game-api'

describe('run save feedback', () => {
  it('confirms a standard activity save', () => {
    expect(runSaveMessage({ activityId: 42 })).toBe('Activity saved')
  })

  it('explains an integrity exclusion as a saved activity, not a recording failure', () => {
    expect(runSaveMessage({
      activityId: 42,
      captureIneligible: true,
      integrityReason: 'GPS accuracy was too low for territory capture',
    })).toBe('Activity saved, but territory capture did not count: GPS accuracy was too low for territory capture')
  })

  it('says why a capture run drew no territory', () => {
    const error = 'No territory: your run finished 62 m from where it started. End within 50 m of your start to claim the ground inside the loop.'
    expect(runSaveMessage({
      activityId: 42,
      claim: { success: false, code: 'not_a_loop', error },
      conquest: { success: true, conqueredCount: 0, contested: [], defended: [] },
    })).toBe(`Activity saved. ${error}`)
  })

  it('lets a battle on the same run speak instead of the refused claim', () => {
    expect(runSaveMessage({
      activityId: 42,
      claim: { success: false, code: 'overlap', error: 'No new territory: this loop overlaps land someone else holds.' },
      conquest: { success: true, conqueredCount: 1, contested: [], defended: [] },
    })).toBe('Activity saved')
  })

  it('preserves a genuine failed-save message', () => {
    expect(runSaveMessage({ activityId: null, error: 'The activity API refused the upload' }))
      .toBe('The activity API refused the upload')
  })
})
