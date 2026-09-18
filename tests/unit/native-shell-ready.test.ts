import { afterEach, describe, expect, it } from 'bun:test'
import { nativeShellReady } from '../../resources/functions/native-shell-ready'

const host = globalThis as typeof globalThis & {
  craft?: unknown
  webkit?: { messageHandlers?: { craft?: unknown } }
}

afterEach(() => {
  delete host.craft
  delete host.webkit
})

describe('native shell readiness', () => {
  it('answers false in a browser without waiting for anything', async () => {
    expect(await nativeShellReady(50)).toBe(false)
  })

  it('answers true straight away once the bridge is installed', async () => {
    host.craft = {}
    expect(await nativeShellReady(50)).toBe(true)
  })

  it('waits for craftReady when the WebView is there but the bridge is not', async () => {
    // This is the state the app is actually in at page load on iPhone: the
    // message handler exists, `craft` does not yet. Asking once here is what
    // left the site header and the marketing landing page in the app.
    host.webkit = { messageHandlers: { craft: {} } }

    const answer = nativeShellReady(1000)
    await Bun.sleep(10)
    host.craft = {}
    globalThis.dispatchEvent(new Event('craftReady'))

    expect(await answer).toBe(true)
  })

  it('gives up rather than hanging when a host never finishes installing', async () => {
    host.webkit = { messageHandlers: { craft: {} } }
    expect(await nativeShellReady(40)).toBe(false)
  })
})
