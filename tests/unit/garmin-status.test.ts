import { describe, expect, it } from 'bun:test'
import { garminCardState, garminConnectedLabel, garminImportSummary } from '../../resources/functions/garmin-status'

describe('garminCardState', () => {
  it('is unavailable until Garmin approves the app, whatever else the payload says', () => {
    expect(garminCardState({ configured: false, connected: false })).toBe('unavailable')
    // Not approved means nothing can arrive, so a connection is never shown.
    expect(garminCardState({ configured: false, connected: true })).toBe('unavailable')
    expect(garminCardState(null)).toBe('unavailable')
    expect(garminCardState(undefined)).toBe('unavailable')
  })

  it('offers to connect once approved', () => {
    expect(garminCardState({ configured: true, connected: false })).toBe('disconnected')
  })

  it('is connected only when approved and linked', () => {
    expect(garminCardState({ configured: true, connected: true })).toBe('connected')
  })
})

describe('garminConnectedLabel', () => {
  it('says since when', () => {
    expect(garminConnectedLabel({ connectedAt: '2026-09-20T09:00:00Z' }, 'en-US')).toBe('Connected since Sep 20, 2026')
  })

  it('falls back to plain Connected without a usable date', () => {
    expect(garminConnectedLabel({ connectedAt: null }, 'en-US')).toBe('Connected')
    expect(garminConnectedLabel({ connectedAt: 'not a date' }, 'en-US')).toBe('Connected')
  })
})

describe('garminImportSummary', () => {
  it('talks about Garmin imports, not the account, when there are none', () => {
    // "Waiting for your first activity" read as though the account had no
    // activity at all, to someone whose profile showed a hike.
    expect(garminImportSummary({ importedCount: 0 }, 'en-US')).toBe('No Garmin activities imported yet')
    expect(garminImportSummary({}, 'en-US')).toBe('No Garmin activities imported yet')
    expect(garminImportSummary({ importedCount: 'garbage' }, 'en-US')).toBe('No Garmin activities imported yet')
  })

  it('counts imports and dates the latest', () => {
    expect(garminImportSummary({ importedCount: 1, lastSyncAt: '2026-09-22T18:30:00Z' }, 'en-US'))
      .toBe('1 Garmin activity imported · last on Sep 22, 2026')
    expect(garminImportSummary({ importedCount: 1204, lastSyncAt: '2026-09-22T18:30:00Z' }, 'en-US'))
      .toBe('1,204 Garmin activities imported · last on Sep 22, 2026')
  })

  it('leaves the date off rather than printing a bad one', () => {
    expect(garminImportSummary({ importedCount: 3, lastSyncAt: null }, 'en-US')).toBe('3 Garmin activities imported')
  })
})
