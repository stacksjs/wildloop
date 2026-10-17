import { beforeAll, describe, expect, it } from 'bun:test'
import { API, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

const qa = process.env.RECORDING_QA === '1'
beforeAll(async () => {
  if (qa)
    await startQaServers()
}, READY_TIMEOUT_MS)

describe.skipIf(!qa)('trail elevation profile API', () => {
  it('rejects malformed IDs and distinguishes missing trails', async () => {
    expect((await fetch(`${API}/trails/not-a-number/profile`)).status).toBe(422)
    expect((await fetch(`${API}/trails/999999999/profile`)).status).toBe(404)
  })

  it('does not invent an elevation line when the catalog has no geometry', async () => {
    const response = await fetch(`${API}/trails/1/profile`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, points: [] })
    expect(response.headers.get('Cache-Control')).toContain('public')
  })
})
