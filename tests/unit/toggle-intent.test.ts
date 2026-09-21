import { describe, expect, it } from 'bun:test'
import { wantsIt } from '../../app/Support/toggleIntent'

describe('save, kudos, follow and block', () => {
  it('add on PUT and remove on DELETE, however many times they are sent', () => {
    for (const current of [true, false]) {
      expect(wantsIt('PUT', current)).toBe(true)
      expect(wantsIt('put', current)).toBe(true)
      expect(wantsIt('DELETE', current)).toBe(false)
    }
  })

  it('still flip on POST, for apps open across a deploy', () => {
    expect(wantsIt('POST', true)).toBe(false)
    expect(wantsIt('POST', false)).toBe(true)
  })
})
