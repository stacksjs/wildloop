import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { authReadyUser, dataNeedsForPath } from '../../resources/composables/useWildloopApp'

describe('route-aware app bootstrap', () => {
  it('keeps the marketing route free of unrelated catalog requests', () => {
    expect(dataNeedsForPath('/')).toEqual({
      activities: false,
      battles: false,
      follows: false,
      territories: false,
      trails: false,
    })
  })

  it('loads only the catalog a discovery route needs', () => {
    expect(dataNeedsForPath('/trails')).toMatchObject({
      activities: false,
      battles: false,
      territories: false,
      trails: true,
    })
    expect(dataNeedsForPath('/trail/123').trails).toBe(true)
  })

  it('loads recording and territory dependencies on their route groups', () => {
    expect(dataNeedsForPath('/record')).toMatchObject({
      activities: true,
      territories: true,
      trails: true,
    })
    expect(dataNeedsForPath('/territories')).toMatchObject({
      battles: true,
      territories: true,
      trails: false,
    })
  })

  it('loads social data for feed and athlete pages', () => {
    expect(dataNeedsForPath('/feed')).toMatchObject({ activities: true, follows: true })
    expect(dataNeedsForPath('/athlete/42')).toMatchObject({ activities: true, follows: true })
  })

  it('loads real battles for the feed banner, which has no demo battles to fall back on', () => {
    expect(dataNeedsForPath('/feed').battles).toBe(true)

    const store = readFileSync(new URL('../../resources/components/stores.stx', import.meta.url), 'utf8')
    expect(store).toContain('conquests: [] as Conquest[],')
    expect(store).not.toContain('seedConquests')
  })

  it('accepts only a complete authenticated identity from the cross-bundle event', () => {
    expect(authReadyUser({ user: { id: 7, email: 'runner@wildloop.test', name: 'Runner' } }))
      .toMatchObject({ id: 7, email: 'runner@wildloop.test' })
    expect(authReadyUser({ user: { id: 0, email: 'runner@wildloop.test' } })).toBeNull()
    expect(authReadyUser({ user: { id: 7 } })).toBeNull()
    expect(authReadyUser(null)).toBeNull()
  })
})
