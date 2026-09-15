import { describe, expect, it } from 'bun:test'
import { withLocationRequestTimeout } from '../../resources/assets/scripts/location-request'

describe('location request timeout', () => {
  it('settles a bridge request that never calls back', async () => {
    const result = await withLocationRequestTimeout(new Promise<never>(() => undefined), 1)
      .then(() => 'resolved', error => error instanceof Error ? error.message : 'unknown')

    expect(result).toBe('Location request timed out')
  })

  it('preserves a location result that arrives before the timeout', async () => {
    await expect(withLocationRequestTimeout(Promise.resolve({ latitude: 37.7749 }), 1)).resolves.toEqual({ latitude: 37.7749 })
  })
})
