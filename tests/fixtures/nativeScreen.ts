import { expect } from 'bun:test'
import { join } from 'node:path'
import vm from 'node:vm'
import { nativeScreenFiles } from '@stacksjs/actions/build/native-screens'
import { compileNativeBundle as compileBundle } from '@stacksjs/stx/native'
import mobile from '../../config/mobile'

/**
 * One compiled native bundle, driven through a fake Craft bridge.
 *
 * Lifted out of `tests/unit/native-manual-activity-flow.test.ts` when the
 * records screen became the second thing that needs it. The screens come from
 * `ios.nativeScreens` in config/mobile.ts — the same map the generated
 * craft.config.json carries — so a test cannot pass against a screen list the
 * app does not ship.
 */

const ROOT = join(import.meta.dir, '../..')
let bundle = ''

export async function compileNativeBundle(): Promise<void> {
  if (bundle)
    return

  // The screens come from `ios.nativeScreens` in config/mobile.ts, which is
  // also what the generated craft.config.json carries — so a test cannot pass
  // against a screen list the app does not ship.
  const screens = nativeScreenFiles(mobile.ios, ROOT)
  bundle = (await compileBundle({ screens, root: ROOT })).code
}

/** The compiled bundle itself, for assertions about what it does not contain. */
export function nativeBundle(): string {
  return bundle
}

export interface NativeSession {
  sent: any[]
  scope: Record<string, any>
  receive: (message: Record<string, unknown>) => void
  event: (testID: string, name: string, nativeEvent?: Record<string, unknown>) => Promise<void>
}

export function nodesByTestId(node: any, found = new Map<string, string>()): Map<string, string> {
  if (node?.props?.testID) found.set(String(node.props.testID), String(node.props.__stxId))
  for (const child of node?.children ?? []) {
    if (child && typeof child === 'object') nodesByTestId(child, found)
  }
  return found
}

export async function start(route: string, params: Record<string, unknown> = {}): Promise<NativeSession> {
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
      const operations = sent.filter(message => message.type === 'MUTATE')
        .flatMap(message => message.payload.operations)
      // A row inside a `:for` does not exist in the first RENDER — it arrives as
      // a `createNode`, and its handler as an `updateNode` after that. So the
      // id is looked up in both places, which is what makes this usable for a
      // list screen rather than only a form.
      const created = operations
        .filter(operation => operation.op === 'createNode' && operation.node?.props?.testID === testID)
        .map(operation => String(operation.id))
      const candidates = [nodes.get(testID), ...created].filter(Boolean) as string[]
      // The most recently created node wins, so a list test taps the last row
      // it was given rather than whichever one the protocol numbered first.
      const handlerId = operations
        .filter(operation => candidates.includes(String(operation.id)) && operation.patch?.events?.[name])
        .map(operation => operation.patch.events[name])
        .at(-1)
      expect(handlerId, `no ${name} handler on a node with testID "${testID}"`).toBeTruthy()
      receive({ type: 'EVENT', payload: { handlerId, nativeEvent } })
      await Bun.sleep(0)
    },
  }
}

export function answer(session: NativeSession, request: any, data: unknown): void {
  session.receive({
    type: 'API_RESPONSE',
    correlationId: request.id,
    payload: { version: 1, requestId: request.id, data },
  })
}

export function requests(session: NativeSession): any[] {
  return session.sent.filter(message => message.type === 'API_REQUEST')
}

export async function waitForRequest(
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

/**
 * Every string the screen has put on the display, in order.
 *
 * Text reaches the host as `patch.children` on an `updateNode`, or inside the
 * node of a `createNode` — not as a `text` prop — so an assertion about what
 * somebody can read has to harvest both. Harvesting strings rather than
 * walking a tree keeps a test about content from depending on the shape of the
 * protocol.
 */
export function shownText(session: NativeSession): string[] {
  const found: string[] = []
  const harvest = (value: unknown): void => {
    if (typeof value === 'string')
      found.push(value)
    else if (Array.isArray(value))
      value.forEach(harvest)
    else if (value && typeof value === 'object')
      Object.values(value as Record<string, unknown>).forEach(harvest)
  }
  for (const message of session.sent) {
    if (message.type === 'RENDER')
      harvest(message.payload.document)
    if (message.type === 'MUTATE')
      harvest(message.payload.operations)
  }
  return found
}

/**
 * Wait until the screen has displayed a string.
 *
 * A response arrives through the bridge and the mutations that follow it are
 * several microtasks away, so a fixed `sleep` makes a list test pass or fail on
 * machine speed. This polls the way `waitForRequest` does.
 */
export async function waitForText(session: NativeSession, text: string): Promise<string[]> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const shown = shownText(session)
    if (shown.includes(text))
      return shown
    await Bun.sleep(1)
  }
  throw new Error(`The screen never displayed ${JSON.stringify(text)}`)
}

/**
 * The strings the screen has displayed *since* a point in the conversation.
 *
 * `shownText` harvests the whole history, which makes it useless for "did this
 * tap change the screen": the text a screen showed before data arrived is
 * still in there, so the assertion passes without the tap doing anything. Take
 * `session.sent.length` before the interaction and pass it here.
 */
export function shownTextSince(session: NativeSession, from: number): string[] {
  const found: string[] = []
  const harvest = (value: unknown): void => {
    if (typeof value === 'string')
      found.push(value)
    else if (Array.isArray(value))
      value.forEach(harvest)
    else if (value && typeof value === 'object')
      Object.values(value as Record<string, unknown>).forEach(harvest)
  }
  for (const message of session.sent.slice(from)) {
    if (message.type === 'MUTATE')
      harvest(message.payload.operations)
  }
  return found
}
