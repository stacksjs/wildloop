import { describe, expect, it } from 'bun:test'
import { assertNativeReviewPersistence } from '../../scripts/run-native-trail-android-e2e'

describe('native review acceptance persistence checks', () => {
  it('requires the edited rating and text on the original review', () => {
    const created = { id: 7, content: 'First visit.', rating: 5 }
    const id = assertNativeReviewPersistence([created], 'create', created.content)
    expect(id).toBe(7)
    expect(() => assertNativeReviewPersistence([created], 'edit', 'Return visit.', id)).toThrow('expected review')
    expect(() => assertNativeReviewPersistence([{ ...created, id: 8, content: 'Return visit.', rating: 4 }], 'edit', 'Return visit.', id)).toThrow('second review')
    expect(assertNativeReviewPersistence([{ ...created, content: 'Return visit.', rating: 4 }], 'edit', 'Return visit.', id)).toBe(id)
  })

  it('rejects duplicate creates and a review left behind after deletion', () => {
    const row = { id: 7, content: 'First visit.', rating: 5 }
    expect(() => assertNativeReviewPersistence([row, { ...row, id: 8 }], 'create', row.content)).toThrow('expected review')
    expect(() => assertNativeReviewPersistence([row], 'delete', row.content)).toThrow('did not remove')
    expect(assertNativeReviewPersistence([], 'delete', row.content)).toBeUndefined()
  })
})
