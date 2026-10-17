/** Real route, auth, ORM persistence and cache checks; visual behaviour is checked in the browser. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { encode } from 'ts-images'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

const qa = process.env.RECORDING_QA === '1'
let trailId = 0
const tokens: string[] = []

async function register(): Promise<string> {
  const csrf = await csrfToken(API)
  const res = await fetch(`${API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': APP, 'X-CSRF-Token': csrf, 'Cookie': `X-CSRF-Token=${encodeURIComponent(csrf)}` },
    body: JSON.stringify({ name: 'Review Lifecycle QA', email: `review-${crypto.randomUUID()}@example.test`, password: `Local-QA-${crypto.randomUUID()}` }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await res.json()).token
}

function write(token: string | null, method: 'POST' | 'DELETE', body: object = {}, id: number | string = trailId): Promise<Response> {
  return fetch(`${API}/trails/${id}/reviews`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

async function read(): Promise<any> {
  const res = await fetch(`${API}/trails/${trailId}/reviews`)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('private, no-cache')
  return res.json()
}

async function uploadPhoto(token: string): Promise<{ id: string, url: string }> {
  const data = new Uint8ClampedArray(400 * 300 * 4).fill(180)
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  const bytes = await encode({ data, width: 400, height: 300, colorSpace: 'srgb', hasAlpha: false, bitDepth: 8 } as any, 'jpeg', { quality: 90 } as any)
  const body = new FormData()
  body.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'review.jpg')
  const res = await fetch(`${API}/trails/${trailId}/photos`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body })
  expect(res.status, await res.clone().text()).toBe(201)
  return (await res.json()).photo
}

beforeAll(async () => {
  if (!qa) return
  await startQaServers()
  const listed = await fetch(`${API}/trails?country=all&limit=50`)
  trailId = (await listed.json()).trails.find((t: any) => t.name === 'Review Lifecycle Loop').id
  tokens.push(await register(), await register())
}, READY_TIMEOUT_MS + 30_000)

afterAll(async () => {
  if (!qa) return
  for (const token of tokens) await write(token, 'DELETE')
})

describe.skipIf(!qa)('trail review lifecycle', () => {
  it('creates, edits and deletes only the session user review, refreshing ratings and conditions', async () => {
    const before = await read()
    expect(before.reviews).toHaveLength(0)
    const created = await write(tokens[0], 'POST', { rating: 4, content: 'Lifecycle QA: walked the complete loop.', difficulty: 'moderate', conditions: 'muddy', visit_date: '2026-01-02' })
    expect(created.status, await created.clone().text()).toBe(201)
    const first = await created.json()
    const reviewId = first.review.id
    expect(first.trail.reviewCount).toBe(before.reviews.length + 1)
    const row = (await read()).reviews.find((r: any) => r.id === reviewId)
    expect(row).toMatchObject({ rating: 4, visitDate: '2026-01-02', difficulty: 'moderate', conditions: 'muddy' })

    // Neither an anonymous visitor nor a different athlete can delete this review.
    expect([401, 403]).toContain((await write(null, 'DELETE')).status)
    expect((await write(tokens[1], 'DELETE', { user_id: row.userId, id: reviewId })).status).toBe(404)
    expect((await read()).reviews.some((r: any) => r.id === reviewId)).toBe(true)

    const edited = await write(tokens[0], 'POST', { rating: 5, content: 'Lifecycle QA: updated the review after a return visit.', difficulty: 'easy', conditions: 'excellent', visit_date: '2026-01-03' })
    expect(edited.status, await edited.clone().text()).toBe(200)
    expect((await edited.json()).review.id).toBe(reviewId)
    const afterEdit = await read()
    expect(afterEdit.reviews.filter((r: any) => r.id === reviewId)).toHaveLength(1)
    expect(afterEdit.reviews.find((r: any) => r.id === reviewId)).toMatchObject({ rating: 5, content: 'Lifecycle QA: updated the review after a return visit.', visitDate: '2026-01-03' })

    const other = await write(tokens[1], 'POST', { rating: 3, content: 'Another athlete review must survive this deletion.' })
    expect(other.status).toBe(201)
    const otherId = (await other.json()).review.id
    const removed = await write(tokens[0], 'DELETE')
    expect(removed.status, await removed.clone().text()).toBe(200)
    expect((await removed.json()).trail).toEqual({ id: trailId, rating: 3, reviewCount: 1 })
    const afterDelete = await read()
    expect(afterDelete.reviews.some((r: any) => r.id === reviewId)).toBe(false)
    expect(afterDelete.reviews.map((r: any) => r.id)).toEqual([otherId])
    expect(afterDelete.difficulty.total).toBe(before.difficulty.total)
    const catalog = await fetch(`${API}/trails/${trailId}`)
    expect((await catalog.json()).trail).toMatchObject({ rating: 3, review_count: 1 })
    expect(afterDelete.conditions.reports.some((r: any) => r.note.includes('Lifecycle QA:'))).toBe(false)
    expect((await write(tokens[0], 'DELETE')).status).toBe(404)
    const emptied = await write(tokens[1], 'DELETE')
    expect((await emptied.json()).trail).toEqual({ id: trailId, rating: 0, reviewCount: 0 })
    expect((await read()).reviews).toHaveLength(0)
  })

  it('retains existing photos when adding photos during an edit, and refuses another athlete photos', async () => {
    const first = await uploadPhoto(tokens[0])
    const next = await uploadPhoto(tokens[0])
    const foreign = await uploadPhoto(tokens[1])
    const payload = { rating: 4, content: 'Photos from a walk around the loop.' }
    expect((await write(tokens[0], 'POST', { ...payload, photo_ids: [first.id] })).status).toBe(201)
    const edited = await write(tokens[0], 'POST', { ...payload, photo_ids: [next.id], retain_photos: true })
    expect(edited.status).toBe(200)
    expect(JSON.parse((await edited.json()).review.photos)).toEqual([first.url, next.url])
    const bad = await write(tokens[0], 'POST', { ...payload, photo_ids: [foreign.id], retain_photos: true })
    expect(bad.status).toBe(422)
    expect(JSON.parse((await read()).reviews[0].photos)).toEqual([first.url, next.url])
    expect((await write(tokens[0], 'DELETE')).status).toBe(200)
  })

  it('reads only the authenticated athlete state without community or saved-list pagination',async()=>{
    const viewer=(token:string|null, suffix='')=>fetch(`${API}/trails/${trailId}/viewer${suffix}`,{headers:token?{Authorization:`Bearer ${token}`}:{}})
    expect([401,403]).toContain((await viewer(null)).status)
    expect((await viewer(tokens[0])).headers.get('cache-control')).toBe('private, no-store')
    expect(await (await viewer(tokens[0])).json()).toMatchObject({saved:false,review:null})
    expect((await write(tokens[0],'POST',{rating:4,content:'My own review must be available outside the community page.'})).status).toBe(201)
    const saved=await fetch(`${API}/trails/${trailId}/save`,{method:'PUT',headers:{Authorization:`Bearer ${tokens[0]}`}})
    expect(saved.status).toBe(200)
    const mine=await (await viewer(tokens[0],'?limit=1&offset=200&user_id=999999')).json()
    expect(mine).toMatchObject({saved:true,review:{rating:4,content:'My own review must be available outside the community page.'}})
    expect(mine.review.userId).toBe(mine.userId)
    expect(await (await viewer(tokens[1],`?user_id=${mine.userId}`)).json()).toMatchObject({saved:false,review:null})
    expect((await write(tokens[0],'DELETE')).status).toBe(200)
    const unsaved=await fetch(`${API}/trails/${trailId}/save`,{method:'DELETE',headers:{Authorization:`Bearer ${tokens[0]}`}})
    expect(unsaved.status).toBe(200)
    expect(await (await viewer(tokens[0])).json()).toMatchObject({saved:false,review:null})
    const missing=await fetch(`${API}/trails/999999999/viewer`,{headers:{Authorization:`Bearer ${tokens[0]}`}})
    expect(missing.status).toBe(404)
    const malformed=await fetch(`${API}/trails/invalid/viewer`,{headers:{Authorization:`Bearer ${tokens[0]}`}})
    expect(malformed.status).toBe(422)
  })

  it('validates trail identifiers and refuses missing reviews', async () => {
    expect((await write(tokens[0], 'DELETE', {}, 'invalid')).status).toBe(422)
    expect((await write(tokens[0], 'DELETE', {}, 999_999_999)).status).toBe(404)
  })
})
