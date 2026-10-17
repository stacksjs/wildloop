import { beforeAll, describe, expect, it } from 'bun:test'
import { createNativeApi } from '../../resources/functions/native-api'
import { QA_ADMIN } from './qa-admin'
import { APP, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

const qa = process.env.RECORDING_QA === '1'
describe.skipIf(!qa)('native API authentication contract', () => {
  beforeAll(startQaServers, READY_TIMEOUT_MS)
  it('refreshes the security cookie even when native networking already holds one', async () => {
    const previous = 'd'.repeat(64)
    const response = await fetch(`${APP}/api/csrf`, { headers: { Cookie: `X-CSRF-Token=${previous}` } })
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie().some(cookie => /^X-CSRF-Token=[a-f0-9]{64};/.test(cookie))).toBe(true)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
  it('signs in through the normal CSRF contract and uses its bearer for private reads', async () => {
    let token = ''
    const api = createNativeApi({
      app: { url: `${APP}/feed` },
      secureStorage: { get: () => token },
    })
    const login = await api.send('/api/login', 'POST', { email: QA_ADMIN.email, password: QA_ADMIN.password, remember: true })
    expect(login.status).toBe(200)
    expect(login.body.token).toBeString()
    token = login.body.token
    const me = await api.send('/api/me')
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(QA_ADMIN.email)
  })
})
