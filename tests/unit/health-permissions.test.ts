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
  /*
   * The tile is back, and the rule that removed it still holds.
   *
   * 50f4c2ef took it out because nothing could produce a heart rate and it
   * printed an em dash on every activity ever saved, which reads as broken
   * rather than as absent. #1010 gave it a source — heart rate parsed out of
   * an imported GPX, TCX or FIT file — so the tile may render, but only for
   * an activity that actually has one. What this asserts is the guard, not
   * the absence.
   */
  it('renders the heart rate tile only for an activity that has one', async () => {
    const page = await Bun.file('resources/views/activity/[id].stx').text()

    // One Avg HR label, and the element carrying it is guarded. Checked as
    // two plain facts rather than one regex spanning the whole tile, which
    // breaks every time the markup is reformatted.
    const labels = [...page.matchAll(/>\s*Avg HR\s*</g)]
    expect(labels).toHaveLength(1)

    const guarded = page.indexOf('<div :if="activity.heartRateAvg"')
    expect(guarded, 'the Avg HR tile should be guarded by :if="activity.heartRateAvg"').toBeGreaterThan(-1)
    // The label falls inside the guarded element, not before it.
    expect(labels[0].index!).toBeGreaterThan(guarded)
  })

  /*
   * The grid has to narrow with it, or the two surviving tiles stretch across
   * three columns and leave a gap where the heart rate would have been.
   */
  it('drops to two columns when there is no heart rate', async () => {
    const page = await Bun.file('resources/views/activity/[id].stx').text()
    expect(page).toContain("activity.heartRateAvg ? 'grid-cols-3' : 'grid-cols-2'")
  })
})
