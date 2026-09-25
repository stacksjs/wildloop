import { describe, expect, it } from 'bun:test'
import { countOf } from '../../app/Support/modelCounts'

describe('admin overview counts', () => {
  it('uses the database count aggregate without loading rows', async () => {
    let countCalls = 0

    const count = await countOf({
      async count() {
        countCalls += 1
        return 593188
      },
    })

    expect(count).toBe(593188)
    expect(countCalls).toBe(1)
  })

  it('returns zero when an optional table is unavailable', async () => {
    const count = await countOf({
      async count() {
        throw new Error('missing table')
      },
    })

    expect(count).toBe(0)
  })
})
