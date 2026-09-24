import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { generateSignalsRuntimeDev } from '@stacksjs/stx'
import { computeConquestRecord } from '../../resources/functions/conquest-stats'
import { computeTrainingStats } from '../../resources/functions/training-stats'

/**
 * Every `wl` store action has to hand its state a new value.
 *
 * An action that changed state in place (`a.read = true`,
 * `Object.assign(existing, …)`, `this.trails.push(…)`) wrote to an object no
 * signal was watching, so the page never re-rendered. The visible case was a
 * trail opened from its card saying "Trail not found" after its fetch had
 * succeeded.
 *
 * This runs the real store from resources/components/stores.stx on the real
 * stx runtime. The runtime gets its own `window` instead of globalThis, since
 * every unit test file shares one process and several of them check
 * `typeof window`.
 */

// eslint-disable-next-line ts/no-explicit-any
let wl: any
// eslint-disable-next-line ts/no-explicit-any
let stx: any

function bootStore(): void {
  const noop = () => {}
  const element = () => ({ style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop, contains: () => false } })
  const memory = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, String(value)),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  }
  const document = {
    readyState: 'complete',
    createElement: element,
    head: element(),
    body: element(),
    documentElement: element(),
    addEventListener: noop,
    removeEventListener: noop,
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
  }
  // eslint-disable-next-line ts/no-explicit-any
  const win: any = {
    document,
    localStorage,
    addEventListener: noop,
    removeEventListener: noop,
    location: { pathname: '/', search: '', hash: '', href: 'http://localhost/' },
    history: { pushState: noop, replaceState: noop },
  }

  // The dev runtime logs every signal write.
  const log = console.log
  console.log = noop
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'localStorage', 'self', 'globalThis', generateSignalsRuntimeDev())(win, document, localStorage, win, win)

    const source = readFileSync(new URL('../../resources/components/stores.stx', import.meta.url), 'utf8')
    const script = source.slice(source.indexOf('<script client>') + '<script client>'.length, source.indexOf('</script>'))
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(script).replace(/^import .*$/gm, '')
    // eslint-disable-next-line no-new-func
    new Function('window', 'defineStore', 'computeConquestRecord', 'computeTrainingStats', js)(win, win.stx.defineStore, computeConquestRecord, computeTrainingStats)
  }
  finally {
    console.log = log
  }

  stx = win.stx
  wl = stx.useStore('wl')
}

/**
 * Run `act` and check each named piece of state was replaced, not edited: a
 * watcher on it re-ran, it holds a new value, and the old value is unchanged.
 */
function expectReplaced(keys: string[], act: () => void): void {
  const before = keys.map(key => wl[key]())
  const snapshots = before.map(value => structuredClone(value))
  const runs = keys.map(() => 0)
  keys.forEach((key, i) => stx.effect(() => {
    wl[key]()
    runs[i]++
  }))
  runs.fill(0)

  const log = console.log
  console.log = () => {}
  try {
    act()
  }
  finally {
    console.log = log
  }

  keys.forEach((key, i) => {
    expect({ key, reran: runs[i] > 0 }).toEqual({ key, reran: true })
    expect({ key, replaced: wl[key]() !== before[i] }).toEqual({ key, replaced: true })
    expect(before[i]).toEqual(snapshots[i])
  })
}

describe('wl store actions replace state instead of mutating it', () => {
  beforeAll(() => {
    bootStore()
    const me = wl.users()[0]
    wl.hydrateAuthenticatedUser({ id: me.id, name: me.name, email: 'me@wildloop.test' })
  })

  it('upsertTrailFromApi, for a new trail and a known one', () => {
    const known = wl.trails()[0]
    expectReplaced(['trails'], () => wl.upsertTrailFromApi({ ...known, id: 9001, name: 'New Trail' }))
    expect(wl.trails().find((t: { id: number }) => t.id === 9001)?.name).toBe('New Trail')

    expectReplaced(['trails'], () => wl.upsertTrailFromApi({ ...known, name: 'Renamed' }))
    expect(wl.trails().find((t: { id: number }) => t.id === known.id)?.name).toBe('Renamed')
  })

  it('setTrailRating', () => {
    const id = wl.trails()[0].id
    expectReplaced(['trails'], () => wl.setTrailRating(id, 4.6, 12))
    expect(wl.trails()[0]).toMatchObject({ rating: 4.6, reviewCount: 12 })
  })

  it('hydrateAuthenticatedUser, for a known user and a new one', () => {
    const id = wl.users()[1].id
    expectReplaced(['users'], () => wl.hydrateAuthenticatedUser({ id, name: 'Renamed Runner', email: 'renamed@wildloop.test' }))
    expect(wl.users().find((u: { id: number }) => u.id === id)?.name).toBe('Renamed Runner')

    expectReplaced(['users'], () => wl.hydrateAuthenticatedUser({ id: 9002, name: 'New Runner', email: 'new@wildloop.test' }))
    expect(wl.users().some((u: { id: number }) => u.id === 9002)).toBe(true)
  })

  it('addActivity, patchActivity, toggleKudos, setActivityKudos and addComment', () => {
    expectReplaced(['activities'], () => wl.addActivity({ id: 9003, user_id: wl.currentUserId(), title: 'Morning run', kudos_count: 0, comments: [] }))
    expect(wl.activities()[0].id).toBe(9003)

    expectReplaced(['activities'], () => wl.patchActivity(9003, { title: 'Evening run' }))
    expectReplaced(['activities'], () => wl.toggleKudos(9003, 1))
    expectReplaced(['activities'], () => wl.setActivityKudos(9003, 5))
    expectReplaced(['activities'], () => wl.addComment(9003, 'Nice pace'))

    const activity = wl.activities().find((a: { id: number }) => a.id === 9003)
    expect(activity).toMatchObject({ title: 'Evening run', kudos_count: 5 })
    expect(activity.comments.map((c: { text: string }) => c.text)).toEqual(['Nice pace'])
  })

  it('upsertChallenge, for a known challenge', () => {
    const known = wl.challenges()[0]
    expectReplaced(['challenges'], () => wl.upsertChallenge({ ...known, title: 'Renamed challenge' }))
    expect(wl.challenges()[0].title).toBe('Renamed challenge')
  })

  it('applyClubMembership', () => {
    wl.hydrateClubs([{ id: 1, name: 'Club', members: [], memberCount: 0, isMember: false }])
    expectReplaced(['clubs'], () => wl.applyClubMembership(1, true, 1))
    expect(wl.clubs()[0]).toMatchObject({ members: [wl.currentUserId()], isMember: true, memberCount: 1 })
  })

  it('setFollowing', () => {
    wl.hydrateFollowing([])
    expectReplaced(['following'], () => wl.setFollowing(42, true))
    expect(wl.following()).toEqual([42])
  })

  it('markNotificationRead', () => {
    wl.hydrateNotifications([{ id: 1, type: 'kudos', title: 'Kudos', message: '', link: '/', read: false, created_at: new Date().toISOString() }])
    expectReplaced(['notifications'], () => wl.markNotificationRead(1))
    expect(wl.notifications()[0].read).toBe(true)
  })

  it('conquerTerritory', () => {
    const me = wl.currentUserId()
    const target = wl.territories().find((t: { user_id: number }) => t.user_id !== me)
    const stats = wl.conquestStats()
    expect(stats.user_id).toBe(me)

    expectReplaced(['territories', 'conquests', 'conquestStats', 'notifications'], () => {
      expect(wl.conquerTerritory(target.id, 3.2)).toBe(true)
    })
    expect(wl.territories().find((t: { id: number }) => t.id === target.id)).toMatchObject({ user_id: me, conquestCount: target.conquestCount + 1 })
    expect(wl.conquests()[0].territory_id).toBe(target.id)
    expect(wl.conquestStats().totalConquests).toBe(stats.totalConquests + 1)
    expect(wl.notifications()[0].type).toBe('conquest_win')
  })
})
