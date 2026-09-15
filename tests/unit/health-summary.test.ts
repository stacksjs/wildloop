import { describe, expect, it } from 'bun:test'
import { formatHealthSummary } from '../../resources/functions/health-summary'

describe('native health summary', () => {
  it('formats measured values for the Settings screen', () => {
    expect(formatHealthSummary({ steps: 1_234.6, distanceMetres: 4_320, activeEnergy: 765.2 }))
      .toBe('1,235 steps · 4.3 km · 765 kcal today')
  })

  it('replaces incomplete bridge values with useful zeroes rather than NaN', () => {
    expect(formatHealthSummary({ steps: undefined, distanceMetres: Number.NaN, activeEnergy: null }))
      .toBe('0 steps · 0.0 km · 0 kcal today')
  })
})
