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
