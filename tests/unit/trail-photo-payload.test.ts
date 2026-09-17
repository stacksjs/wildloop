import { describe, expect, it } from 'bun:test'
import { isPhotoKey } from '../../app/Support/photoStorage'
import { toTrailPhotoPayload, trailPhotoUrl } from '../../app/Support/trailPhotoPayload'

const uuid = '3f2b8c1e-9a4d-4e7f-b1c2-5d6e7f8a9b0c'
const row = { uuid, trail_id: 12, user_id: 7, width: 1536, height: 2048, created_at: '2026-09-17T12:00:00.000Z', user_name: ' Ada ' }

describe('trail photo payload', () => {
  it('addresses a photo by its UUID and serves it through the app, never straight from the bucket', () => {
    expect(trailPhotoUrl(12, uuid)).toBe(`/api/trail-photos/12/${uuid}.jpg`)
    expect(trailPhotoUrl(12, uuid, 'thumb')).toBe(`/api/trail-photos/12/${uuid}-thumb.jpg`)
  })

  it('builds URLs the file route will accept', () => {
    for (const url of [trailPhotoUrl(12, uuid), trailPhotoUrl(12, uuid, 'thumb')])
      expect(isPhotoKey(url.replace('/api/trail-photos/', 'trails/'))).toBe(true)
  })

  it('credits the person who added it and says whether the viewer did', () => {
    expect(toTrailPhotoPayload(row, 7)).toEqual({
      id: uuid,
      trailId: 12,
      url: `/api/trail-photos/12/${uuid}.jpg`,
      thumbUrl: `/api/trail-photos/12/${uuid}-thumb.jpg`,
      width: 1536,
      height: 2048,
      credit: 'Ada',
      createdAt: '2026-09-17T12:00:00.000Z',
      mine: true,
    })
    expect(toTrailPhotoPayload(row, 8).mine).toBe(false)
    expect(toTrailPhotoPayload(row, null).mine).toBe(false)
  })

  it('never exposes the uploader id or the storage keys', () => {
    const payload = toTrailPhotoPayload({ ...row, storage_key: 'trails/12/x.jpg' } as any, null)
    expect(Object.keys(payload)).not.toContain('user_id')
    expect(JSON.stringify(payload)).not.toContain('storage_key')
  })
})
