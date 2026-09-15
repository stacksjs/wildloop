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

  it('preserves a genuine failed-save message', () => {
    expect(runSaveMessage({ activityId: null, error: 'The activity API refused the upload' }))
      .toBe('The activity API refused the upload')
  })
})
