import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { runNativeCompile } from '@stacksjs/stx/native'

const ROOT = join(import.meta.dir, '../..')
let bundle = ''

beforeAll(async () => {
  bundle = (await runNativeCompile(undefined, {
    cwd: join(ROOT, 'resources'),
    config: 'native.config.json',
    format: 'bundle',
  })).output
})

interface NativeSession {
  sent: any[]
  scope: Record<string, any>
  receive: (message: Record<string, unknown>) => void
  event: (testID: string, name: string, nativeEvent?: Record<string, unknown>) => Promise<void>
}

function nodesByTestId(node: any, found = new Map<string, string>()): Map<string, string> {
  if (node?.props?.testID) found.set(String(node.props.testID), String(node.props.__stxId))
  for (const child of node?.children ?? []) {
    if (child && typeof child === 'object') nodesByTestId(child, found)
  }
  return found
}

async function start(route: 'manual' | 'activity', params: Record<string, unknown> = {}): Promise<NativeSession> {
  const sent: any[] = []
  let callback: (raw: string) => void = () => {}
  const scope: Record<string, any> = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Map,
    Set,
    WeakMap,
    WeakSet,
    __stxNativeRoute: route,
    __stxNativeParams: params,
    __stxNativeBridge: {
      platform: 'ios',
      capabilityProtocolVersion: 1,
      capabilities: ['fetch', 'secureStorage', 'haptics', 'lifecycle'],
      postMessage: (raw: string) => sent.push(JSON.parse(raw)),
      onMessage: (receiver: typeof callback) => { callback = receiver },
    },
  }
  vm.runInNewContext(bundle, scope)
  await Bun.sleep(0)
  const rendered = sent.find(message => message.type === 'RENDER')?.payload.document
  const nodes = nodesByTestId(rendered)
  const receive = (message: Record<string, unknown>) => callback(JSON.stringify(message))
  return {
    sent,
    scope,
    receive,
    event: async (testID, name, nativeEvent = {}) => {
      const id = nodes.get(testID)
      const operations = sent.filter(message => message.type === 'MUTATE')
        .flatMap(message => message.payload.operations)
      const handlerId = operations.find(operation => operation.id === id && operation.patch?.events?.[name])?.patch.events[name]
      expect(handlerId).toBeTruthy()
      receive({ type: 'EVENT', payload: { handlerId, nativeEvent } })
      await Bun.sleep(0)
    },
  }
}

function answer(session: NativeSession, request: any, data: unknown): void {
  session.receive({
    type: 'API_RESPONSE',
    correlationId: request.id,
    payload: { version: 1, requestId: request.id, data },
  })
}

function requests(session: NativeSession): any[] {
  return session.sent.filter(message => message.type === 'API_REQUEST')
}

async function waitForRequest(
  session: NativeSession,
  after: number,
  predicate: (request: any) => boolean,
): Promise<any> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const request = requests(session).slice(after).find(predicate)
    if (request) return request
    await Bun.sleep(1)
  }
  throw new Error('Timed out waiting for a native capability request')
}

describe('Wildloop native manual activity flow', () => {
  it('uses app components and sends the real activity payload through the Craft protocol', async () => {
    expect(bundle).not.toContain('WebView')
    expect(readFileSync(join(ROOT, 'resources/native/ManualActivity.stx'), 'utf8')).toContain('<NativeRunMetric')
    const manual = await start('manual', { userId: 12 })
    const render = manual.sent.find(message => message.type === 'RENDER').payload.document
    expect(nodesByTestId(render).has('distance-preview')).toBe(true)

    await manual.event('distance-input', 'onChangeText', { text: '5.126' })
    await manual.event('duration-input', 'onChangeText', { text: '45:30' })
    await manual.event('elevation-input', 'onChangeText', { text: '801.6' })
    await manual.event('trail-input', 'onChangeText', { text: '7' })
    await manual.event('notes-input', 'onChangeText', { text: 'ridge loop' })
    await manual.event('save-activity', 'onPress')

    const tokenRequest = requests(manual).at(-1)
    expect(tokenRequest.payload).toMatchObject({ module: 'SecureStorage', method: 'get', args: ['auth_token'] })
    const requestCount = requests(manual).length
    answer(manual, tokenRequest, 'native-token')
    const post = await waitForRequest(manual, requestCount, request => request.payload?.module === 'Network')
    const request = post.payload.args[0]
    expect(post.payload.module).toBe('Network')
    expect(post.payload.method).toBe('fetch')
    expect(request.url).toBe('https://wildloop.org/api/activities')
    expect(request.method).toBe('POST')
    expect(request.headers.authorization).toBe('Bearer native-token')
    expect(typeof request.body).toBe('string')
    expect(JSON.parse(request.body)).toMatchObject({
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
      recording_source: 'manual',
      game_mode: 'none',
    })
    const postRequestCount = requests(manual).length
    answer(manual, post, {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activity: { id: 42 } }),
    })
    const haptic = await waitForRequest(manual, postRequestCount, request => request.payload?.module === 'Haptics')
    expect(haptic.payload).toMatchObject({ module: 'Haptics', method: 'impact', args: ['light'] })
    answer(manual, haptic, true)
    await Bun.sleep(0)
    expect(manual.sent.at(-1)).toMatchObject({
      type: 'NAVIGATE',
      payload: { screen: 'activity', params: expect.objectContaining({ id: 42, userId: 12, distance: 5.13 }) },
    })
  })

  it('keeps route state isolated and supports back, replace, and teardown cancellation', async () => {
    const saved = await start('activity', {
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
    expect(saved.sent.at(-1)).toMatchObject({ type: 'NAVIGATE_REPLACE', payload: { screen: 'manual', params: { userId: 12 } } })

    const pending = await start('manual', { userId: 12 })
    await pending.event('distance-input', 'onChangeText', { text: '3' })
    await pending.event('duration-input', 'onChangeText', { text: '30:00' })
    await pending.event('save-activity', 'onPress')
    const tokenRequest = requests(pending).at(-1)
    const requestCount = requests(pending).length
    answer(pending, tokenRequest, 'native-token')
    const post = await waitForRequest(pending, requestCount, request => request.payload?.module === 'Network')
    pending.scope.__stxNativeUnmount()
    expect(pending.sent).toContainEqual(expect.objectContaining({
      type: 'API_CANCEL',
      payload: { version: 1, requestId: post.id, reason: 'screen-closed' },
    }))

    const fresh = await start('manual', { userId: 12 })
    const operations = fresh.sent.filter(message => message.type === 'MUTATE').flatMap(message => message.payload.operations)
    expect(operations.some(operation => operation.patch?.children?.includes('3 mi'))).toBe(false)
  })
})
