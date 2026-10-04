import { describe, expect, it } from 'bun:test'
import { runOutcome, runSaveMessage } from '../../resources/assets/scripts/game-api'

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

describe('run outcome tiles', () => {
  it('counts the claim, every territory taken, and the XP for all of it', () => {
    expect(runOutcome({
      activityId: 42,
      claim: { success: true, xpGained: 144, territory: { id: 9, name: 'Loop', areaSize: 44_000, centerLat: 34, centerLng: -118 } },
      conquest: {
        success: true,
        conqueredCount: 2,
        xpGained: 330,
        territories: [
          { originalId: 3, conqueredArea: 20_000, remainingArea: 22_000, newTerritoryId: 11 },
          { originalId: 4, conqueredArea: 1_500, remainingArea: 0 },
        ],
      },
    })).toEqual({ xp: 474, territoryIds: [9, 11, 4] })
  })

  it('is nothing for a run that won nothing', () => {
    expect(runOutcome({ activityId: 42, claim: { success: false, error: 'No territory' } })).toEqual({ xp: 0, territoryIds: [] })
  })
})
