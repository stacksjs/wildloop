import type { Server } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { activeSeam, install, loghqTransport, uninstall, whenAttached } from '@loghq/stacks'
import { log, transports } from '@stacksjs/logging'

/**
 * Attaching the log reporters, and why one of the two was never attached.
 *
 * `config/logging.ts` has carried a `loghqTransport()` entry in its
 * `transports` array for as long as loghq has been configured, and that array
 * is never read: nothing in `@stacksjs/logging`, in the rest of the framework,
 * or in this app calls `registerTransport` with it. bughq survived that anyway
 * because `bughqTransport()` registers itself from inside the factory. loghq's
 * declarative form does not, so the app has been streaming nothing.
 *
 * These run against a local sink rather than loghq, so the keys below are
 * nonsense and nothing leaves the machine. Both halves matter: that `install()`
 * really attaches AND really delivers, since an attached transport with a
 * rejected key is indistinguishable from a working one until you watch the
 * wire.
 */

const KEY = `loghq_${'0'.repeat(64)}`

let sink: Server
let received: Array<{ path: string, messages: string[] }>
let borrowedFetch: typeof fetch

beforeAll(() => {
  received = []
  // Every test file shares one process and eight of them replace
  // `globalThis.fetch` with a double. The SDK takes whatever is installed when
  // its client is constructed, so without this the entry goes into somebody
  // else's stub and the delivery assertion below fails on file ordering alone.
  borrowedFetch = globalThis.fetch
  globalThis.fetch = Bun.fetch
  sink = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      // `POST {host}/logs`, body `{ logs: [entry, ...] }` — docs/ingest.md in
      // the loghq repo is the wire contract.
      const body = await request.json().catch(() => ({})) as { logs?: Array<{ message?: string }> }
      const logs = body?.logs ?? []
      received.push({ path: new URL(request.url).pathname, messages: logs.map(entry => String(entry?.message ?? '')) })
      return Response.json({ ok: true, stored: logs.length, dropped: 0, skipped: 0 }, { status: 201 })
    },
  })
})

afterAll(() => {
  // Detach before the sink goes away: the logger is shared by every test file
  // in this process, so a transport left attached would spend the rest of the
  // run posting to a closed port.
  uninstall()
  sink.stop(true)
  globalThis.fetch = borrowedFetch
})

describe('streaming logs to loghq', () => {
  it('attaches through the logger’s own registry, and delivers', async () => {
    install({ key: KEY, host: `http://127.0.0.1:${sink.port}`, flushInterval: 0 })

    // Attachment is async — the adapter probes for `@stacksjs/logging` rather
    // than importing it, so that a non-Stacks process can use the same SDK.
    expect(await whenAttached()).toEqual({ seam: 'transport', via: 'registerTransport' })
    expect(transports().map(t => t.name)).toContain('loghq')

    await log.error('[test] a line for the sink', new Error('deliberate'))
    const { flush } = await import('@loghq/stacks')
    expect(await flush(), 'the queue should drain').toBe(true)

    expect(received.map(r => r.path)).toContain('/logs')
    expect(received.flatMap(r => r.messages).join('\n'), 'the line itself should arrive').toContain('[test] a line for the sink')
  })

  it('detaches again, so nothing is left pointing at a dead port', () => {
    uninstall()

    expect(activeSeam()).toEqual({ seam: 'none', via: null })
    expect(transports().map(t => t.name)).not.toContain('loghq')
  })

  /*
   * The defect itself. The declarative form builds a perfectly good transport
   * and hands it back for a framework to register — and nothing registers it,
   * which is why `config/logging.ts` calls `install()` instead.
   */
  it('does not attach when built declaratively for the transports array', () => {
    const transport = loghqTransport({ key: KEY, host: `http://127.0.0.1:${sink.port}` })

    expect(transport.name, 'the object itself is fine').toBe('loghq')
    expect(typeof transport.log).toBe('function')

    expect(activeSeam(), 'nothing attached it').toEqual({ seam: 'none', via: null })
    expect(transports().map(t => t.name)).not.toContain('loghq')
  })
})
