import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { clubSuccessor } from '../../app/Support/accountDeletion'
import { deleteAccount } from '../../resources/assets/scripts/auth'

const store = new Map<string, string>()
const calls: Array<{ url: string, init: any }> = []

function respondWith(status: number, body?: unknown): void {
  calls.length = 0
  globalThis.fetch = mock(async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as any
}

beforeEach(() => {
  store.clear()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
})

afterEach(() => {
  delete (globalThis as any).localStorage
})

describe('deleting an account', () => {
  it('hands a club to the member who joined first, and deletes it when nobody else is in it', () => {
    const members = [
      { id: 1, user_id: 9, created_at: '2026-01-01T00:00:00Z' },
      { id: 3, user_id: 4, created_at: '2026-03-01T00:00:00Z' },
      { id: 2, user_id: 7, created_at: '2026-02-01T00:00:00Z' },
    ]
    expect(clubSuccessor(members, 9)).toBe(7)
    expect(clubSuccessor([{ id: 1, user_id: 9, created_at: '2026-01-01T00:00:00Z' }], 9)).toBeNull()
    // The same moment: the earlier row wins, so the answer never depends on read order.
    expect(clubSuccessor([
      { id: 5, user_id: 2, created_at: '2026-01-01T00:00:00Z' },
      { id: 4, user_id: 3, created_at: '2026-01-01T00:00:00Z' },
    ], 9)).toBe(3)
  })

  it('asks the API with the password, then forgets the session on this device', async () => {
    store.set('auth_token', 'abc')
    store.set('auth_user', JSON.stringify({ id: 5, email: 'pawel@wildloop.test' }))
    respondWith(204)

    const failure = await deleteAccount('correct horse')

    const request = calls.find(call => call.url === '/api/me' && call.init?.method === 'DELETE')
    expect(request?.init.method).toBe('DELETE')
    expect(JSON.parse(request?.init.body)).toEqual({ password: 'correct horse' })
    expect(request?.init.headers.Authorization).toBe('Bearer abc')
    expect(failure).toBeNull()
    expect(store.has('auth_token')).toBe(false)
    expect(store.has('auth_user')).toBe(false)
  })

  it('keeps the session and says why when the password is wrong', async () => {
    store.set('auth_token', 'abc')
    respondWith(403, { success: false, error: 'That is not your password.' })

    expect(await deleteAccount('nope')).toBe('That is not your password.')
    expect(store.get('auth_token')).toBe('abc')
  })

  it('is routed as DELETE /me behind the auth middleware', () => {
    const routes = readFileSync(new URL('../../routes/api.ts', import.meta.url), 'utf8')
    const group = routes.slice(routes.indexOf('// Authenticated user routes'))
    expect(group).toContain("route.group({ middleware: 'auth' }")
    expect(group).toContain("route.delete('/me', 'Actions/Auth/AccountDestroyAction')")
  })

  it('is offered in settings, behind a second step and the password', () => {
    const settings = readFileSync(new URL('../../resources/views/settings.stx', import.meta.url), 'utf8')
    expect(settings).toContain('Delete my account permanently')
    expect(settings).toContain('await deleteAccount(deletePassword())')
    expect(settings).toContain(':if="deleteOpen()"')
  })
})
