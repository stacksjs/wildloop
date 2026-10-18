import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, nativeBundle, nativeNodeProps, nodesByTestId, requests, start, waitForRequest, waitForText, type NativeSession } from '../fixtures/nativeScreen'

const ROOT = join(import.meta.dir, '../..')

beforeAll(compileNativeBundle, 30000)

function openManual(params: Record<string, unknown> = {}) {
  return start('ManualActivity',params,['fetch','secureStorage','crypto','haptics','lifecycle','dialog'],new Map([['auth_token','native-token']]))
}
async function supplyUUID(manual: NativeSession) {
  const uuid=await waitForRequest(manual,0,r=>r.payload.module==='Crypto' && r.payload.method==='randomUUID')
  answer(manual,uuid,'e8158db5-288f-4cb3-9540-016656f716c6')
}

describe('Wildloop native manual activity flow', () => {
  it('keeps a system UUID and the exact manual payload when retrying a failed save',async()=>{
    const manual=await start('ManualActivity',{},['fetch','secureStorage','crypto','haptics','lifecycle','dialog'],new Map([['auth_token','native-token']]))
    await manual.event('distance-input','onChangeText',{text:'3.1'})
    await manual.event('duration-input','onChangeText',{text:'28:00'})
    await manual.event('save-activity','onPress')
    const uuid=await waitForRequest(manual,0,r=>r.payload.module==='Crypto' && r.payload.method==='randomUUID')
    answer(manual,uuid,'2b53ece4-8df1-49fa-9e70-752ddc901cf7')
    const post=await waitForRequest(manual,0,r=>r.payload.module==='Network')
    expect(JSON.parse(post.payload.args[0].body).upload_id).toBe('manual:2b53ece4-8df1-49fa-9e70-752ddc901cf7')
    answer(manual,post,{status:503,body:JSON.stringify({message:'Try again later'})})
    await waitForText(manual,'Try again later')
    const before=requests(manual).length
    await manual.event('save-activity','onPress')
    const again=await waitForRequest(manual,before,r=>r.payload.module==='Network')
    expect(again.payload.args[0].body).toBe(post.payload.args[0].body)
    expect(requests(manual).filter(r=>r.payload.module==='Crypto')).toHaveLength(1)
  })
  it('clears private manual notes and ignores a save response after an account change',async()=>{
    const keychain=new Map([['auth_token','native-token']])
    const manual=await start('ManualActivity',{},['fetch','secureStorage','crypto','haptics','lifecycle','dialog'],keychain)
    await manual.event('distance-input','onChangeText',{text:'3'})
    await manual.event('duration-input','onChangeText',{text:'30:00'})
    await manual.event('notes-input','onChangeText',{text:'private route notes'})
    await manual.event('save-activity','onPress')
    await supplyUUID(manual)
    const post=await waitForRequest(manual,0,r=>r.payload.module==='Network')
    keychain.set('auth_token','other-token')
    await manual.scope.craft.snapshots.set('wildloop-session',{user:{id:13},version:1})
    answer(manual,post,{status:201,body:JSON.stringify({activity:{id:42,userId:12}})})
    await Bun.sleep(0)
    expect(nativeNodeProps(manual,'notes-input').value).toBe('')
    expect(requests(manual).some(r=>r.payload.module==='Haptics')).toBe(false)
    expect(manual.sent.some(r=>r.type==='NAVIGATE')).toBe(false)
  })
  it('uses app components and sends the real activity payload through the Craft protocol', async () => {
    expect(nativeBundle()).not.toContain('WebView')
    expect(readFileSync(join(ROOT, 'resources/native/ManualActivity.stx'), 'utf8')).toContain('<NativeRunMetric')
    const manual = await openManual({ userId: 12 })
    const render = manual.sent.find(message => message.type === 'RENDER').payload.document
    expect(nodesByTestId(render).has('distance-preview')).toBe(true)

    await manual.event('distance-input', 'onChangeText', { text: '5.126' })
    await manual.event('duration-input', 'onChangeText', { text: '45:30' })
    await manual.event('elevation-input', 'onChangeText', { text: '801.6' })
    await manual.event('trail-input', 'onChangeText', { text: '7' })
    await manual.event('notes-input', 'onChangeText', { text: 'ridge loop' })
    await manual.event('save-activity', 'onPress')

    await supplyUUID(manual)
    const requestCount = 0
    const post = await waitForRequest(manual, requestCount, request => request.payload?.module === 'Network')
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
    expect(haptic.payload).toMatchObject({ module: 'Haptics', method: 'impact', args: ['light'] })
    answer(manual, haptic, true)
    await Bun.sleep(0)
    expect(manual.sent).toContainEqual(expect.objectContaining({
      type: 'NAVIGATE',
      payload: { screen: 'ActivitySaved', params: expect.objectContaining({ id: 42, userId: 12, distance: 5.13 }) },
    }))
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
    const manual = await openManual()

    await manual.event('distance-input', 'onChangeText', { text: '3.1' })
    await manual.event('duration-input', 'onChangeText', { text: '28:00' })
    await manual.event('save-activity', 'onPress')

    await supplyUUID(manual)
    expect(requests(manual).some(r=>r.payload.module==='SecureStorage' && r.payload.method==='get')).toBe(true)
    const before = 0
    const post = await waitForRequest(manual, before, request => request.payload?.module === 'Network')
    const body = JSON.parse(post.payload.args[0].body)

    expect(post.payload.args[0].headers.authorization).toBe('Bearer native-token')
    expect('user_id' in body, 'the session owns identity; the body must not claim it').toBe(false)
    expect(body).toMatchObject({ activity_type: 'Trail Run', distance: 3.1, recording_source: 'manual' })
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

    const pending = await openManual({ userId: 12 })
    await pending.event('distance-input', 'onChangeText', { text: '3' })
    await pending.event('duration-input', 'onChangeText', { text: '30:00' })
    await pending.event('save-activity', 'onPress')
    await supplyUUID(pending)
    const requestCount = 0
    const post = await waitForRequest(pending, requestCount, request => request.payload?.module === 'Network')
    pending.scope.__stxNativeUnmount()
    expect(pending.sent).toContainEqual(expect.objectContaining({
      type: 'API_CANCEL',
      payload: { version: 1, requestId: post.id, reason: 'screen-closed' },
    }))

    const fresh = await openManual({ userId: 12 })
    const operations = fresh.sent.filter(message => message.type === 'MUTATE').flatMap(message => message.payload.operations)
    expect(operations.some(operation => operation.patch?.children?.includes('3 mi'))).toBe(false)
  })
})
