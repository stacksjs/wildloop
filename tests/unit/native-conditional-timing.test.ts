import { beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import vm from 'node:vm'
import { compileNativeBundle } from '@stacksjs/stx/native'

/**
 * When a native conditional is resolved, and when a bound geometry arrives.
 *
 * This exists because two issues were filed off a bad reading. I probed the
 * RENDER payload, found `:if` had changed nothing and `:geometry` was not a
 * prop, and reported that the runtime ignores `:if` (stacksjs/stx#2074) and
 * that the compiler drops `:geometry` (stacksjs/stx#2073). Both were wrong in
 * the same way: **the initial RENDER is not the frame.** Each binding is
 * applied, in the first post-mount MUTATE batch, and reading only the render
 * document reports a delay as a drop.
 *
 * So these assertions deliberately read both halves — what the first RENDER
 * contains and what the operations afterwards do — because the gap between
 * them is the whole finding. Measured identical on 0.2.520 and 0.2.532.
 */

const ROOT = join(import.meta.dir, '../..')
const PROBE = join(ROOT, 'tests/fixtures/conditionalProbe.stx')

interface Probe {
  /** The document in the first RENDER, as id → testID. */
  rendered: Map<string, string>
  /** Every node in the first RENDER, by type. */
  nodes: any[]
  /** Every operation from every MUTATE batch, in order. */
  operations: any[]
}

let probe: Probe

async function drive(): Promise<Probe> {
  const { code } = await compileNativeBundle({ screens: { ConditionalProbe: PROBE }, root: ROOT })
  const sent: any[] = []
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
    __stxNativeRoute: 'ConditionalProbe',
    __stxNativeParams: {},
    __stxNativeBridge: {
      platform: 'ios',
      capabilityProtocolVersion: 1,
      capabilities: ['fetch', 'secureStorage', 'haptics', 'lifecycle'],
      postMessage: (raw: string) => sent.push(JSON.parse(raw)),
      onMessage: () => {},
    },
  }
  vm.runInNewContext(code, scope)
  await Bun.sleep(5)

  const rendered = new Map<string, string>()
  const nodes: any[] = []
  const walk = (node: any): void => {
    if (node?.type)
      nodes.push(node)
    if (node?.props?.testID)
      rendered.set(String(node.props.testID), String(node.props.__stxId))
    for (const child of node?.children ?? []) {
      if (child && typeof child === 'object')
        walk(child)
    }
  }
  walk(sent.find(message => message.type === 'RENDER')?.payload.document)

  const operations = sent
    .filter(message => message.type === 'MUTATE')
    .flatMap(message => message.payload.operations)

  return { rendered, nodes, operations }
}

/** Operations touching one node, in order. */
function opsFor(id: string): any[] {
  return probe.operations.filter(op => op.id === id || op.childId === id)
}

describe('a native conditional, and when it is resolved', () => {
  beforeAll(async () => {
    probe = await drive()
  })

  /*
   * The half that was right. Every branch is in the first render, whatever its
   * condition says — which is what put a spinner, an error slot and a result
   * count on Trails in one frame, and an Accept button on a challenge the
   * viewer had sent.
   */
  it('renders every branch, whatever the condition says', () => {
    expect(probe.rendered.has('turns-on')).toBe(true)
    expect(probe.rendered.has('turns-off')).toBe(true)
    expect(probe.rendered.has('loop-if')).toBe(true)
  })

  /*
   * The half that was wrong. `:if` is applied — it just happens a batch late.
   */
  it('applies `:if` in the batch after the render, rather than ignoring it', () => {
    const turnsOff = probe.rendered.get('turns-off')!
    expect(opsFor(turnsOff).some(op => op.op === 'removeNode')).toBe(true)

    const created = probe.operations.filter(op => op.op === 'createNode' && op.node?.props?.testID === 'turns-on')
    expect(created.length).toBeGreaterThan(0)
    expect(probe.operations.some(op => op.op === 'insertChild' && op.childId === created[0].id)).toBe(true)
  })

  it('applies `:if` on a loop row too', () => {
    const rows = probe.operations.filter(op => op.op === 'createNode' && op.node?.props?.testID === 'loop-if')
    // Two rows are rendered; the one whose `ok` is false is removed again.
    expect(rows.length).toBe(2)
    expect(rows.some(row => probe.operations.some(op => op.op === 'removeNode' && op.id === row.id))).toBe(true)
  })

  /*
   * `:show` resolves in the same batch as `:if`, which is why it buys no
   * speed — only a node that stays mounted, and a `style.display` a test can
   * read.
   */
  it('resolves `:show` through style, in that same batch', () => {
    const shown = probe.rendered.get('shown-node')!
    const styled = opsFor(shown).filter(op => op.patch?.style?.display)
    expect(styled.length).toBeGreaterThan(0)
  })
})

describe('a bound geometry on MapPolyline', () => {
  beforeAll(async () => {
    probe ??= await drive()
  })

  /*
   * This is the exact reading that produced the bad filing: the polyline in the
   * first render carries a marker saying a parent binding exists, and no array.
   * Asserted so the next probe recognises it as a promise rather than a drop.
   */
  it('is only a marker in the first render, not a prop', () => {
    const polyline = probe.nodes.find(node => String(node.type) === 'MapPolyline')
    expect(polyline).toBeDefined()

    // What the bad probe saw: a binding is announced, and carries no array.
    expect(polyline.props['data-stx-parent-bindings']).toContain('geometry')
    expect(polyline.props.geometry).toBeUndefined()
    // An unbound sibling prop on the same node is there from the start, which
    // is what made the absence look like a compiler drop rather than a delay.
    expect(polyline.props.strokeColor).toBe('#f00')
  })

  it('arrives as a flat array in the batch after the render', () => {
    const patched = probe.operations.filter(op => op.op === 'updateNode' && op.patch?.props?.geometry)
    expect(patched.length).toBeGreaterThan(0)
    expect(patched[0].patch.props.geometry).toEqual([32.7, -117.1, 32.8, -117.2])
  })
})

/**
 * The fixture's scope, as a contract.
 *
 * Separate from the conditional timing above, and here because this file is
 * the one about *when* things happen in a native screen.
 */
describe('what the native scope does not offer', () => {
  /*
   * A timer is not promised by the runtime, so the fixture does not hand the
   * bundle one. Putting it back re-arms a 30-second bridge timeout per request
   * and brings back the intermittent `Request js_… timed out after 30000ms`
   * that used to land on whichever file was running at the time — see the
   * comment on `scope` in tests/fixtures/nativeScreen.ts.
   */
  it('gives the bundle no timer, as a host without one would not', async () => {
    const { compileNativeBundle: compile, start } = await import('../fixtures/nativeScreen')
    await compile()
    const session = await start('Stats')

    expect(session.scope.setTimeout).toBeUndefined()
    expect(session.scope.setInterval).toBeUndefined()
  })
})
