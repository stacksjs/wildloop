import { describe, expect, it } from 'bun:test'
import { claimName, splitPieceName } from '../../app/Support/territoryNames'

describe('territory names', () => {
  it('names a claim after the nearest town, not the clock', () => {
    expect(claimName('Silver Lake', [])).toBe('Silver Lake Loop')
  })

  it('numbers a second claim in the same town', () => {
    expect(claimName('Silver Lake', ['Silver Lake Loop'])).toBe('Silver Lake Loop 2')
    expect(claimName('Silver Lake', ['Silver Lake Loop', 'Silver Lake Loop 2'])).toBe('Silver Lake Loop 3')
  })

  it('still names a claim where no town is known', () => {
    expect(claimName(null, [])).toBe('Unnamed Loop')
    expect(claimName('  ', ['Unnamed Loop'])).toBe('Unnamed Loop 2')
  })

  it('does not stack a suffix on land split again and again', () => {
    expect(splitPieceName('Silver Lake Loop')).toBe('Silver Lake Loop (Conquered)')
    expect(splitPieceName('Silver Lake Loop (Conquered) (Conquered)')).toBe('Silver Lake Loop (Conquered)')
  })
})
