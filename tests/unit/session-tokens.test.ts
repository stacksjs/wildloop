import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { bearerFrom, DAY_MS, slidExpiry, tokenTimestamp } from '../../app/Support/sessionTokens'

const LIFETIME = 30 * DAY_MS
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0)

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null }
}

describe('API sessions', () => {
  it('reads the bearer token and nothing else', () => {
    expect(bearerFrom({ headers: headers({ authorization: 'Bearer abc|123' }) })).toBe('abc|123')
    expect(bearerFrom({ bearerToken: () => 'direct' })).toBe('direct')
    expect(bearerFrom({ headers: headers({ authorization: 'Basic abc' }) })).toBeNull()
    expect(bearerFrom({ headers: headers({ authorization: 'Bearer   ' }) })).toBeNull()
    // The framework's auth cookie is not a way in.
    expect(bearerFrom({ headers: headers({ cookie: 'auth-token=abc|123' }) })).toBeNull()
  })

  it('slides a used token out to a full lifetime, at most once a day', () => {
    // Issued a moment ago: nothing to do.
    expect(slidExpiry(new Date(NOW + LIFETIME - 60_000), NOW, LIFETIME)).toBeNull()
    // Last moved just under a day ago: still nothing.
    expect(slidExpiry(new Date(NOW + LIFETIME - DAY_MS + 60_000), NOW, LIFETIME)).toBeNull()
    // A day or more since: pushed back out to thirty days from now.
    expect(slidExpiry(new Date(NOW + LIFETIME - DAY_MS), NOW, LIFETIME)?.getTime()).toBe(NOW + LIFETIME)
    expect(slidExpiry(new Date(NOW + 2 * DAY_MS), NOW, LIFETIME)?.getTime()).toBe(NOW + LIFETIME)
    // No expiry, or an unreadable one, is left alone.
    expect(slidExpiry(null, NOW, LIFETIME)).toBeNull()
    expect(slidExpiry(new Date('not a date'), NOW, LIFETIME)).toBeNull()
  })

  it('writes the expiry in the format the framework reads back as UTC', () => {
    expect(tokenTimestamp(new Date(NOW + 1234))).toBe('2026-09-21T12:00:01.234')
  })

  it('does not offer a refresh endpoint that answers with a cookie', () => {
    const routes = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8')
    expect(routes).not.toContain('RefreshTokenAction')
  })
})
