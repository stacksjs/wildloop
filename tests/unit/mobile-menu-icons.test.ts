import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LUCIDE_TO_SF, resolveIconName } from '@stacksjs/stx/native'
import { MOBILE_MENU_GROUPS } from '../../resources/functions/mobile-menu'

/**
 * Every menu icon has to be a name stx can actually resolve.
 *
 * Found on a device on 19 Oct 2026: Settings, Leaderboard, Battles and
 * Conquests each drew a plain circle. The names were `gearshape`, `crown`,
 * `bolt` and `scope` — all four real SF Symbols that `UIImage(systemName:)`
 * answers for, which is why reading the catalogue proved nothing.
 *
 * `<Icon :name>` is **lucide-first**: a bare word must be in `LUCIDE_TO_SF`,
 * and only a name with a dot in it reaches UIKit as an SF Symbol. A bare SF
 * name lucide has no word for falls back to `circle` — silently, on the
 * device, while every test and the type checker stay happy.
 *
 * Run through stx's own resolver rather than a copy of its table, so this
 * keeps telling the truth when the table grows.
 */
const ITEMS = MOBILE_MENU_GROUPS.flatMap(group => group.items)

describe('mobile menu icons', () => {
  it('has every symbol resolve to something other than the fallback', () => {
    const unresolved = ITEMS
      .map(item => ({ label: item.label, symbol: item.symbol, ...resolveIconName(item.symbol) }))
      .filter(item => !item.known)
    expect(unresolved).toEqual([])
  })

  /*
   * The fallback is a real symbol, so "it resolved" is not enough on its own:
   * a name that resolves *to* `circle` is the failure this is about. Only an
   * item that asked for a circle may draw one.
   */
  it('draws a circle only where a circle was asked for', () => {
    const circles = ITEMS.filter(item => resolveIconName(item.symbol).symbol === 'circle')
    expect(circles.map(item => item.label)).toEqual([])
  })

  /*
   * The three that had a lucide word keep drawing exactly the symbol they
   * drew before — the fix was the spelling, not the picture.
   */
  it('keeps the symbols the design asked for', () => {
    const symbolFor = (label: string) => resolveIconName(ITEMS.find(item => item.label === label)!.symbol).symbol
    expect(symbolFor('Settings')).toBe('gearshape')
    expect(symbolFor('Battles')).toBe('bolt')
    expect(symbolFor('Conquests')).toBe('scope')
    // lucide has no crown in its 240 entries, so this one takes the dotted
    // escape hatch instead and is filled rather than outlined.
    expect(symbolFor('Leaderboard')).toBe('crown.fill')
    expect(Object.values(LUCIDE_TO_SF)).not.toContain('crown')
  })

  /*
   * The two icons written as literals in the markup, which the data-driven
   * check above cannot see.
   */
  it('resolves the icons the Menu writes itself', () => {
    const source = readFileSync(join(import.meta.dir, '../../resources/native/Menu.stx'), 'utf8')
    const literals = [...source.matchAll(/<Icon name="([^"]+)"/g)].map(match => match[1])
    expect(literals.length).toBeGreaterThan(0)
    for (const name of literals)
      expect(resolveIconName(name).known).toBe(true)
  })
})
