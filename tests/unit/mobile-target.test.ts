import { afterEach, describe, expect, it, mock } from 'bun:test'
import { holdOnBundledPage, serverPath, serverURLFor } from '../../resources/functions/native-remote'
import { assertDeviceServer, deviceServerURL } from '../../scripts/run-ios-device'
import { previewServerURL } from '../../scripts/run-mobile-e2e'
import { resolveMobileServer, serverArgument } from '../../scripts/mobile-target'
import { nativeRemote } from '../../scripts/write-native-remote'

describe('the server a native build loads', () => {
  it('lets the Simulator load this Mac or production', () => {
    expect(resolveMobileServer('http://localhost:3000', 'simulator')).toBe('http://localhost:3000')
    expect(resolveMobileServer('https://wildloop.org/', 'simulator')).toBe('https://wildloop.org')
  })

  it('refuses an iPhone build pointed at this Mac', () => {
    expect(() => resolveMobileServer('http://localhost:3000', 'device')).toThrow('An iPhone cannot reach')
    expect(() => resolveMobileServer('http://127.0.0.1:3000', 'device')).toThrow('An iPhone cannot reach')
  })

  it('refuses a URL with no scheme instead of guessing https', () => {
    expect(() => resolveMobileServer('localhost:3000', 'simulator')).toThrow('absolute http')
  })

  it('allows plain http only for this Mac', () => {
    expect(() => resolveMobileServer('http://wildloop.org', 'device')).toThrow('use https')
    expect(resolveMobileServer('https://trail-demo.example.dev', 'device')).toBe('https://trail-demo.example.dev')
  })

  it('reads --server in either spelling', () => {
    expect(serverArgument(['ios', '--preview', '--server=http://localhost:3000'])).toBe('http://localhost:3000')
    expect(serverArgument(['--server', 'https://wildloop.org'])).toBe('https://wildloop.org')
    expect(serverArgument(['ios', '--preview'])).toBeUndefined()
    expect(() => serverArgument(['--server', '--preview'])).toThrow('--server needs a URL')
  })

  it('builds a phone against production unless told otherwise, whatever the shell says', () => {
    const shell = process.env.MOBILE_URL
    process.env.MOBILE_URL = 'http://localhost:3000'
    try {
      expect(deviceServerURL([])).toBe('https://wildloop.org')
      expect(() => deviceServerURL(['--server=http://localhost:3000'])).toThrow('An iPhone cannot reach')
    }
    finally {
      if (shell === undefined) delete process.env.MOBILE_URL
      else process.env.MOBILE_URL = shell
    }
  })

  it('refuses a built phone app that loads this Mac', () => {
    expect(() => assertDeviceServer({ devServerURL: 'http://localhost:3000' })).toThrow('cannot reach')
    expect(() => assertDeviceServer({ devServerURL: 'https://wildloop.org' })).not.toThrow()
    expect(() => assertDeviceServer({})).not.toThrow()
  })

  it('gives a Simulator preview a server only when asked', () => {
    expect(previewServerURL(['ios', '--preview'])).toBeNull()
    expect(previewServerURL(['ios', '--preview', '--server=http://localhost:3000'])).toBe('http://localhost:3000')
  })
})

describe('the bundled copy finding its way back', () => {
  it('records the build\'s server in the bundle, and nothing for a bundled-only build', () => {
    expect(nativeRemote({ devServerURL: 'http://localhost:3000' })).toEqual({ url: 'http://localhost:3000' })
    expect(nativeRemote({})).toBeNull()
    expect(nativeRemote({ devServerURL: 'craft://app' })).toBeNull()
  })

  it('maps a bundled page to the same page on the server', () => {
    expect(serverPath('/index.html')).toBe('/')
    expect(serverPath('/feed.html')).toBe('/feed')
    expect(serverPath('/trail/index.html')).toBe('/trail/')
    expect(serverURLFor('http://localhost:3000', { pathname: '/profile', search: '?tab=saved', hash: '' }))
      .toBe('http://localhost:3000/profile?tab=saved')
    expect(serverURLFor(undefined, { pathname: '/', search: '', hash: '' })).toBeNull()
    expect(serverURLFor('craft://app', { pathname: '/', search: '', hash: '' })).toBeNull()
  })

  it('does not reload the recorder under a run in progress', () => {
    expect(holdOnBundledPage('/record')).toBe(true)
    expect(holdOnBundledPage('/record.html')).toBe(true)
    expect(holdOnBundledPage('/feed')).toBe(false)
  })
})

describe('the return trip from the bundled copy', () => {
  const host = globalThis as any
  const saved = { location: host.location, fetch: host.fetch, setInterval: host.setInterval }

  afterEach(() => {
    host.location = saved.location
    host.fetch = saved.fetch
    host.setInterval = saved.setInterval
  })

  async function bundledPage(probe: (url: string, init: any) => Promise<unknown>) {
    const replace = mock((_url: string) => {})
    host.location = { protocol: 'craft:', pathname: '/feed', search: '', hash: '', replace }
    host.setInterval = () => 0
    host.fetch = mock(async (url: string, init: any) => url === '/native-remote.json'
      // Craft's file handler: the file is there, and fetch still says status 0.
      ? { ok: false, status: 0, json: async () => ({ url: 'http://localhost:3000' }) }
      : probe(url, init))
    const { returnToServerFromBundledCopy } = await import(`../../resources/functions/native-remote.ts?page=${Math.random()}`)
    await returnToServerFromBundledCopy()
    return replace
  }

  it('reads the server from a file Craft serves with status 0, and goes back once it answers', async () => {
    const replace = await bundledPage(async () => ({ type: 'opaque' }))
    await Bun.sleep(0)

    expect(replace).toHaveBeenCalledWith('http://localhost:3000/feed')
  })

  it('gives up on a look that never answers, so the next one can run', async () => {
    let signal: AbortSignal | undefined
    const replace = await bundledPage((_url, init) => {
      signal = init.signal
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    })

    expect(signal).toBeDefined()
    expect(replace).not.toHaveBeenCalled()
  })
})
