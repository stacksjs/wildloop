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
  /*
   * No `setTimeout` on purpose, and this is load-bearing twice over.
   *
   * **Fidelity.** The native runtime does not promise a timer. The bridge arms
   * its request timeout as
   * `typeof globalThis.setTimeout === 'function' ? … : null`, so on a host
   * without one no timeout is armed at all — and a screen that leaned on a
   * timer would pass here and fail on a phone, which is exactly what the note
   * at the top of Athletes.stx is about. Handing the bundle a timer the device
   * may not have makes this fixture less like the thing it stands in for.
   *
   * **A flake.** With `setTimeout` in scope, every request armed a 30-second
   * bridge timeout, and eight test files left fifteen of them uncleared
   * between them — a test that asserts a request was *made* has no reason to
   * answer it. In a suite that runs longer than thirty seconds those fired
   * mid-run and rejected into nothing, surfacing as
   * `Request js_… timed out after 30000ms` against whichever file happened to
   * be executing. That is the intermittent native failure that moved around.
   *
   * Measured 16 Oct 2026: 192 native tests across 24 files pass with no timer
   * in scope, and nothing arms a long timer any more.
   */
  const scope: Record<string, any> = {
    console,
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
 * Wait until a node reaches a display state.
 *
 * The companion to `waitForText`, and the one to reach for whenever the thing
 * being waited on is a `:show`. `waitForText` cannot do this job: a static
 * label is in the first RENDER whatever the screen decides, so waiting on
 * "No such territory" returns before the screen has decided anything and
 * `visibility` then reads the state from the first frame. That is the same
 * initial-RENDER-is-not-the-frame trap as stacksjs/stx#2073 and #2074, in
 * test-writing form — it cost six failing assertions on the territory detail
 * screen, each of which looked like a bug in the screen.
 *
 * Polls rather than sleeping a guessed amount: the batch that resolves a
 * `:show` can take tens of milliseconds to arrive.
 */
export async function waitForVisibility(
  session: NativeSession,
  testID: string,
  want: 'flex' | 'none' | 'shown' | 'absent',
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (visibility(session, testID) === want)
      return
    await Bun.sleep(1)
  }
  throw new Error(
    `${testID} never became ${want} — it is ${visibility(session, testID)}`,
  )
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

/**
 * Whether a node is on screen: `'flex'`, `'none'`, `'shown'` when it exists
 * and nothing has hidden it, or `'absent'`.
 *
 * `:show` keeps a node mounted and hides it with `style.display`, where `:if`
 * unmounts — a batch after the initial render, which carries every branch
 * either way (tests/unit/native-conditional-timing.test.ts). So on a `:show`
 * screen a control that must not be offered, and a message that must not be
 * showing, are both *present* and hidden, and only the style says so. A test
 * that searches the text instead passes whatever the screen does, because a
 * static label is in the first RENDER regardless.
 */
export function visibility(session: NativeSession, testID: string): string {
  const operations = session.sent
    .filter(message => message.type === 'MUTATE')
    .flatMap(message => message.payload.operations)

  const ids = new Set<string>()
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object')
      return
    if (node.props?.testID === testID && node.props?.__stxId)
      ids.add(String(node.props.__stxId))
    for (const child of node.children ?? [])
      walk(child)
  }
  walk(session.sent.find(message => message.type === 'RENDER')?.payload.document)
  for (const operation of operations) {
    if (operation.op === 'createNode' && operation.node?.props?.testID === testID)
      ids.add(String(operation.id))
  }

  const display = operations
    .filter(operation => operation.op === 'updateNode' && ids.has(String(operation.id)) && operation.patch?.style?.display)
    .map(operation => operation.patch.style.display)

  return display.at(-1) ?? (ids.size > 0 ? 'shown' : 'absent')
}
