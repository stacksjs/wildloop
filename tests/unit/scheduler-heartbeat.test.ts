import { describe, expect, it } from 'bun:test'
import { pingHeartbeat } from '../../app/Support/schedulerHeartbeat'

const URL = 'https://statushq.org/api/ping/0123456789abcdef0123456789abcdef'

describe('scheduler heartbeat', () => {
  it('posts to the monitor and reports an accepted ping', async () => {
    const calls: Array<{ url: string, method?: string, signal?: AbortSignal | null }> = []
    const ok = await pingHeartbeat(URL, async (url, init) => {
      calls.push({ url, method: init?.method, signal: init?.signal })
      return new Response('{"success":true}', { status: 200 })
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(URL)
    expect(calls[0].method).toBe('POST')
    // A hung StatusHQ must not hold a scheduler job open.
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('does nothing without a URL', async () => {
    let called = false
    expect(await pingHeartbeat(undefined, async () => { called = true; return new Response() })).toBe(false)
    expect(await pingHeartbeat('  ', async () => { called = true; return new Response() })).toBe(false)
    expect(called).toBe(false)
  })

  it('never throws, whatever StatusHQ does', async () => {
    expect(await pingHeartbeat(URL, async () => new Response('', { status: 404 }))).toBe(false)
    expect(await pingHeartbeat(URL, async () => { throw new TypeError('fetch failed') })).toBe(false)
  })

  it('never puts the token in a log line', async () => {
    const { log } = await import('@stacksjs/logging')
    const lines: string[] = []
    const original = log.warn
    log.warn = ((message: unknown) => { lines.push(String(message)) }) as typeof log.warn
    try {
      await pingHeartbeat(URL, async () => new Response('', { status: 500 }))
      await pingHeartbeat(URL, async () => { throw new Error(`could not reach ${URL}`) })
    }
    finally {
      log.warn = original
    }
    expect(lines).toHaveLength(2)
    for (const line of lines)
      expect(line).not.toContain('0123456789abcdef')
  })
})

describe('a reported job', () => {
  const base = 'https://statushq.org/api/ping/abc'

  function recorder() {
    const pinged: string[] = []
    const fetcher = async (url: string) => { pinged.push(url); return new Response('{}', { status: 200 }) }
    return { pinged, fetcher }
  }

  it('pings start, then success', async () => {
    const { pinged, fetcher } = recorder()
    const { runReported } = await import('../../app/Support/schedulerHeartbeat')
    await runReported('./buddy db:snapshot', base, async () => 0, fetcher)
    expect(pinged).toEqual([`${base}/start`, base])
  })

  it('pings fail and throws on a non-zero exit', async () => {
    const { pinged, fetcher } = recorder()
    const { runReported } = await import('../../app/Support/schedulerHeartbeat')
    await expect(runReported('./buddy db:snapshot', `${base}/`, async () => 3, fetcher)).rejects.toThrow('exited with code 3')
    expect(pinged).toEqual([`${base}/start`, `${base}/fail`])
  })

  it('pings fail when the command cannot even start', async () => {
    const { pinged, fetcher } = recorder()
    const { runReported } = await import('../../app/Support/schedulerHeartbeat')
    await expect(runReported('x', base, async () => { throw new Error('spawn failed') }, fetcher)).rejects.toThrow('spawn failed')
    expect(pinged).toEqual([`${base}/start`, `${base}/fail`])
  })

  it('runs the command for real, and pings nothing without a URL', async () => {
    const { pinged, fetcher } = recorder()
    const { runReported } = await import('../../app/Support/schedulerHeartbeat')
    await runReported('true', undefined, undefined, fetcher)
    await expect(runReported('exit 2', undefined, undefined, fetcher)).rejects.toThrow('exited with code 2')
    expect(pinged).toEqual([])
  })
})
