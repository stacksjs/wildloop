import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeKeychain, answer, compileNativeBundle, nativeBundle, nodesByTestId, requests, segmentChosen, start, waitForRequest } from '../fixtures/nativeScreen'

const ROOT = join(import.meta.dir, '../..')

beforeAll(compileNativeBundle, 30000)

describe('Wildloop native manual activity flow', () => {
  it('uses app components and sends the real activity payload through the Craft protocol', async () => {
    expect(nativeBundle()).not.toContain('WebView')
    expect(readFileSync(join(ROOT, 'resources/native/ManualActivity.stx'), 'utf8')).toContain('<NativeRunMetric')
    const manual = await start('ManualActivity', { userId: 12 })
    const render = manual.sent.find(message => message.type === 'RENDER').payload.document
    expect(nodesByTestId(render).has('distance-preview')).toBe(true)

    await manual.event('distance-input', 'onChangeText', { text: '5.126' })
    await manual.event('duration-input', 'onChangeText', { text: '45:30' })
    await manual.event('elevation-input', 'onChangeText', { text: '801.6' })
    await manual.event('trail-input', 'onChangeText', { text: '7' })
    await manual.event('notes-input', 'onChangeText', { text: 'ridge loop' })
    await manual.event('save-activity', 'onPress')

    const post = await waitForRequest(manual, 0, request => request.payload?.module === 'Network')
    const request = post.payload.args[0]
    expect(post.payload.module).toBe('Network')
    expect(post.payload.method).toBe('fetch')
    expect(request.url).toBe('https://wildloop.org/api/activities')
    expect(request.method).toBe('POST')
    expect(request.headers.authorization).toBe('Bearer native-token')
    expect(typeof request.body).toBe('string')
    // No `user_id`: `ActivityStoreAction` takes the actor from `Auth.user()`
    // and ignores the field, so the screen does not claim one.
    expect('user_id' in JSON.parse(request.body)).toBe(false)
    expect(JSON.parse(request.body)).toMatchObject({
      trail_id: 7,
      activity_type: 'Trail Run',
      distance: 5.13,
      duration: '45:30',
      moving_time: '45:30',
      pace: '8:53/mi',
      elevation: 802,
      notes: 'ridge loop',
      visibility: 'followers',
      recording_source: 'manual',
      game_mode: 'none',
    })
    const postRequestCount = requests(manual).length
    answer(manual, post, {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json' },
      // Shaped like `activityResponse`: the owner comes back from the server,
      // which is what the saved screen then shows.
      body: JSON.stringify({ activity: { id: 42, userId: 12 } }),
    })
    const haptic = await waitForRequest(manual, postRequestCount, request => request.payload?.module === 'Haptics')
    // A saved activity is a success, and stx sends the host its own
    // notification haptic rather than approximating it as an impact.
    expect(haptic.payload).toMatchObject({ module: 'Haptics', method: 'notification', args: ['success'] })
    answer(manual, haptic, true)
    await Bun.sleep(0)
    expect(manual.sent.at(-1)).toMatchObject({
      type: 'NAVIGATE',
      payload: { screen: 'ActivitySaved', params: expect.objectContaining({ id: 42, userId: 12, distance: 5.13 }) },
    })
  })

  /*
   * The screen as the host opens it from a path: `ios.nativeScreens` maps
   * `/activity/new` to this screen, and a path carries no params.
   *
   * It used to read its user id from `route.params.userId` and refuse the save
   * when there was none — before reading the token, so a signed-in athlete on a
   * cold start got "Sign in before saving an activity" and no request left the
   * device. The API takes the actor from `Auth.user()` and ignores the field, so
   * the token is the only identity this screen needs.
   */
  it('saves on a cold start, with no route params and no user id in the body', async () => {
    const manual = await start('ManualActivity')

    await manual.event('distance-input', 'onChangeText', { text: '3.1' })
    await manual.event('duration-input', 'onChangeText', { text: '28:00' })
    await manual.event('save-activity', 'onPress')

    // The bearer is read before anything is posted; the fixture's device
    // holds one, so the screen gets as far as the request.
    expect(requests(manual).some((r: any) => r.payload?.module === 'SecureStorage' && r.payload.args[0] === 'auth_token')).toBe(true)
    const post = await waitForRequest(manual, 0, request => request.payload?.module === 'Network')
    const body = JSON.parse(post.payload.args[0].body)

    expect(post.payload.args[0].headers.authorization).toBe('Bearer native-token')
    expect('user_id' in body, 'the session owns identity; the body must not claim it').toBe(false)
    expect(body).toMatchObject({ activity_type: 'Trail Run', distance: 3.1, recording_source: 'manual' })
  })

  /*
   * The type and audience are segmented controls: every choice on screen,
   * the chosen one announced as selected. Choosing is what reaches the body.
   */
  it('saves the type and audience chosen from the segmented controls', async () => {
    const manual = await start('ManualActivity')
    await manual.event('distance-input', 'onChangeText', { text: '4.2' })
    await manual.event('duration-input', 'onChangeText', { text: '50:00' })
    expect(segmentChosen(manual, 'activity-type-Trail Run')).toBe(true)
    expect(segmentChosen(manual, 'visibility-followers')).toBe(true)

    await manual.event('activity-type-Hike', 'onPress')
    await manual.event('visibility-private', 'onPress')
    expect(segmentChosen(manual, 'activity-type-Hike')).toBe(true)
    expect(segmentChosen(manual, 'activity-type-Trail Run')).toBe(false)
    expect(segmentChosen(manual, 'visibility-private')).toBe(true)
    await manual.event('save-activity', 'onPress')

    const post = await waitForRequest(manual, 0, request => request.payload?.module === 'Network')
    expect(JSON.parse(post.payload.args[0].body)).toMatchObject({ activity_type: 'Hike', visibility: 'private' })
  })

  /*
   * The Feed offers "Log activity" to everybody, and this form reads the
   * bearer in `save` — at the very end. A signed-out viewer could fill in
   * distance, time, elevation and a title and only then be told the app has
   * nowhere to put it. Same rule as Record: ask on the way in.
   */
  it('sends a signed-out viewer to log in instead of taking a form it cannot save', async () => {
    const screen = await start('ManualActivity', { userId: 12 }, undefined, {}, nativeKeychain(null))
    for (let attempt = 0; attempt < 60 && !screen.sent.some((message: any) => message.type === 'NAVIGATE_OPEN'); attempt++)
      await Bun.sleep(1)
    expect(screen.sent.some((message: any) => message.type === 'NAVIGATE_OPEN' && message.payload.path === '/login?next=%2Factivity%2Fnew')).toBe(true)
  })

  it('keeps route state isolated and supports back, replace, and teardown cancellation', async () => {
    const saved = await start('ActivitySaved', {
      id: 42,
      userId: 12,
      activityType: 'Trail Run',
      distance: 5.13,
      duration: '45:30',
      pace: '8:53/mi',
      elevation: 802,
    })
    await saved.event('activity-back', 'onPress')
    expect(saved.sent.at(-1)).toMatchObject({ type: 'NAVIGATE_BACK' })
    await saved.event('log-another', 'onPress')
    expect(saved.sent.at(-1)).toMatchObject({ type: 'NAVIGATE_REPLACE', payload: { screen: 'ManualActivity', params: { userId: 12 } } })

    const pending = await start('ManualActivity', { userId: 12 })
    await pending.event('distance-input', 'onChangeText', { text: '3' })
    await pending.event('duration-input', 'onChangeText', { text: '30:00' })
    await pending.event('save-activity', 'onPress')
    const post = await waitForRequest(pending, 0, request => request.payload?.module === 'Network')
    pending.scope.__stxNativeUnmount()
    expect(pending.sent).toContainEqual(expect.objectContaining({
      type: 'API_CANCEL',
      payload: { version: 1, requestId: post.id, reason: 'screen-closed' },
    }))

    const fresh = await start('ManualActivity', { userId: 12 })
    const operations = fresh.sent.filter(message => message.type === 'MUTATE').flatMap(message => message.payload.operations)
    expect(operations.some(operation => operation.patch?.children?.includes('3 mi'))).toBe(false)
  })
})
