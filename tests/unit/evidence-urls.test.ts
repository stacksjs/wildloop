import { describe, expect, it } from 'bun:test'
import { normalizeEvidenceUrl, normalizeTrackerUrl } from '../../app/Support/evidenceUrls'

/**
 * Evidence and tracker link validation.
 *
 * Moved here with the functions themselves, out of
 * `resources/functions/route-records.ts`. That module is shared with the
 * native records screen, so it is compiled into a bundle where `new URL` does
 * not exist — these two were the last web API in it, and `bun run gate:stx`
 * had been carrying them as a standing note.
 *
 * The cases below are the point of the functions rather than the point of the
 * move: a lookalike host, an http downgrade and a `javascript:` scheme are
 * each a way onto a public records board.
 */

describe('normalizeEvidenceUrl', () => {
  it('accepts a link to a platform that actually holds the recording', () => {
    expect(normalizeEvidenceUrl('https://www.strava.com/activities/123')).toBe('https://www.strava.com/activities/123')
  })

  it('accepts a subdomain of an allowed host', () => {
    expect(normalizeEvidenceUrl('https://connect.garmin.com/modern/activity/1')).not.toBeNull()
  })

  it('rejects a blog post, which is a trip report rather than a trace', () => {
    expect(normalizeEvidenceUrl('https://example.com/my-big-run')).toBeNull()
  })

  it('rejects http, so a trace cannot be served over a tamperable channel', () => {
    expect(normalizeEvidenceUrl('http://www.strava.com/activities/123')).toBeNull()
  })

  /*
   * `strava.com.evil.test` contains an allowed host and is not one. A
   * substring check would admit it, which is why the test names the shape
   * rather than the function.
   */
  it('rejects a lookalike host that merely contains an allowed name', () => {
    expect(normalizeEvidenceUrl('https://strava.com.evil.test/activities/1')).toBeNull()
    expect(normalizeEvidenceUrl('https://notstrava.com/activities/1')).toBeNull()
  })

  it('refuses a scheme that is not a link at all', () => {
    for (const raw of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd'])
      expect(normalizeEvidenceUrl(raw)).toBeNull()
  })

  it('refuses anything that is not a string, or is only space', () => {
    for (const raw of [null, undefined, 42, {}, [], '', '   '])
      expect(normalizeEvidenceUrl(raw)).toBeNull()
  })

  it('reads a link somebody pasted with space around it', () => {
    expect(normalizeEvidenceUrl('  https://www.strava.com/activities/5  ')).toBe('https://www.strava.com/activities/5')
  })
})

describe('normalizeTrackerUrl', () => {
  /*
   * A tracker is read while an attempt is still out there, so it is held to a
   * lower bar than evidence: any https host, because a live tracker can be
   * anywhere. The scheme check is what remains.
   */
  it('holds a tracker link to https, but not to a platform allow-list', () => {
    expect(normalizeTrackerUrl('https://share.garmin.com/abc')).toBe('https://share.garmin.com/abc')
    expect(normalizeTrackerUrl('https://some-live-tracker.example/xyz')).toBe('https://some-live-tracker.example/xyz')
  })

  it('refuses a scheme that would run rather than load', () => {
    for (const raw of ['javascript:alert(1)', 'data:text/html,hi', 'http://share.garmin.com/abc'])
      expect(normalizeTrackerUrl(raw)).toBeNull()
  })

  it('refuses anything that is not a string, or is only space', () => {
    for (const raw of [null, undefined, 42, {}, '', '   ', 'not a url'])
      expect(normalizeTrackerUrl(raw)).toBeNull()
  })
})
