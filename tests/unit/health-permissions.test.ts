import { describe, expect, it } from 'bun:test'

/**
 * What the app asks HealthKit for.
 *
 * A permission list is easy to extend and nobody notices, because asking for
 * more always works. The cost lands on the person granting it and on whoever
 * has to justify the list at review, so each entry has to be one the app
 * actually opens.
 *
 * Heart rate sat in this list and was read nowhere: there is no column for it,
 * the importer does not take one out of a GPX file, and every path that builds
 * an activity sets the field to null.
 */

const SETTINGS = 'resources/views/settings.stx'

/** The scopes named in the authorization call. */
async function requestedScopes(): Promise<string[]> {
  const source = await Bun.file(SETTINGS).text()
  const call = /health\.requestAuthorization\(\[([^\]]*)\]/.exec(source)
  expect(call, 'settings.stx should ask HealthKit for authorization').not.toBeNull()
  return [...call![1].matchAll(/'([^']+)'/g)].map(match => match[1])
}

describe('the HealthKit permissions the app asks for', () => {
  it('asks only for what it reads, plus the workouts it writes', async () => {
    expect((await requestedScopes()).sort()).toEqual(['activeEnergy', 'distance', 'steps', 'workouts'])
  })

  it('does not ask for heart rate, which nothing reads', async () => {
    expect(await requestedScopes()).not.toContain('heartRate')
  })

  /*
   * The check that keeps the two in step: every scope requested, apart from
   * the one written, has a `getData` call behind it.
   */
  it('reads back every scope it asks to read', async () => {
    const source = await Bun.file(SETTINGS).text()
    const read = new Set([...source.matchAll(/health\.getData\('([^']+)'/g)].map(m => m[1]))

    for (const scope of await requestedScopes()) {
      if (scope === 'workouts')
        continue // written by a finished recording, not read
      expect(read.has(scope), `${scope} is requested but never read`).toBe(true)
    }
  })
})

describe('the activity page', () => {
  it('does not print a heart rate it can never have', async () => {
    const page = await Bun.file('resources/views/activity/[id].stx').text()
    // The rendered label and the binding behind it, not the word: the comment
    // recording why the tile went is allowed to say what it was.
    expect(page).not.toMatch(/>\s*Avg HR\s*</)
    expect(page).not.toContain('activity.heartRateAvg')
  })
})
