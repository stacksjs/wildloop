import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'bun:test'
import { MAX_UPLOAD_ATTEMPTS, nextUploadDelayMs, queuedRunDisposition } from '../../resources/assets/scripts/run-upload-queue'

describe('offline activity retry policy', () => {
  it('backs off exponentially and caps at one day', () => {
    expect(nextUploadDelayMs(1)).toBe(30_000)
    expect(nextUploadDelayMs(2)).toBe(60_000)
    expect(nextUploadDelayMs(99)).toBe(86_400_000)
  })

  it('defers future retries and dead-letters repeated failures', () => {
    const now = Date.UTC(2026, 7, 12)
    expect(queuedRunDisposition({ attempts: 2, nextAttemptAt: new Date(now + 1000).toISOString() }, now)).toBe('deferred')
    expect(queuedRunDisposition({ attempts: 2, nextAttemptAt: new Date(now - 1000).toISOString() }, now)).toBe('ready')
    expect(queuedRunDisposition({ attempts: MAX_UPLOAD_ATTEMPTS, nextAttemptAt: new Date(now - 1000).toISOString() }, now)).toBe('failed')
  })
})

describe('service worker privacy', () => {
  it('never persists navigations and only deletes Wildloop-owned caches', async () => {
    const source = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8')
    expect(source).toContain("key.startsWith(CACHE_PREFIX)")
    expect(source).toContain("request.mode === 'navigate'")
    expect(source).not.toContain('cache.put(request, copy)')
    expect(source).toContain('no-store|private')
  })
})
