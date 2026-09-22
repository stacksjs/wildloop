import { afterEach, describe, expect, it } from 'bun:test'
import { nativeShellReady } from '../../resources/functions/native-shell-ready'

const host = globalThis as typeof globalThis & {
  CraftAndroid?: unknown
  craft?: unknown
  webkit?: { messageHandlers?: { craft?: unknown } }
}

afterEach(() => {
  delete host.CraftAndroid
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

  it('answers true straight away in the Android app, before its bridge installs', async () => {
    // Android installs `craft` only when the page has finished loading, which
    // on the landing page came after the timeout; its interface is there from
    // the start.
    host.CraftAndroid = {}
    expect(await nativeShellReady(40)).toBe(true)
  })

  it('answers true straight away in the iPhone app, before its bridge installs', async () => {
    host.webkit = { messageHandlers: { craft: {} } }
    const agent = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent')
    Object.defineProperty(globalThis.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15', configurable: true })
    try {
      expect(await nativeShellReady(40)).toBe(true)
    }
    finally {
      if (agent) Object.defineProperty(globalThis.navigator, 'userAgent', agent)
      else delete (globalThis.navigator as { userAgent?: string }).userAgent
    }
  })

  it('gives up rather than hanging when a host never finishes installing', async () => {
    host.webkit = { messageHandlers: { craft: {} } }
    expect(await nativeShellReady(40)).toBe(false)
  })
})
