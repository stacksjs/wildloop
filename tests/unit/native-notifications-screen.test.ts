import { beforeAll, describe, expect, it } from 'bun:test'
import { answer, compileNativeBundle, nativeNodeText, requests, shownText, shownTextSince, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { timeAgo } from '../../resources/functions/notifications'

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Notifications.stx'), 'utf8')

/**
 * Notifications, natively.
 *
 * The first native screen that reads something only the signed-in athlete can
 * see, so this is where the token path on a *read* is pinned, and the first
 * that writes from a list (marking read). The day headings and the relative
 * times come from `resources/functions/notifications.ts`, the module the web
 * page reads, so the tests compose their expectations from it.
 */

const PAYLOAD = {
  notifications: [
    {
      id: 9,
      type: 'kudos',
      actorName: 'Kim Gottwald',
      body: 'gave you kudos on Mist Trail',
      link: '/activity/4',
      read: false,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: 10,
      type: 'conquest_attack',
      actorName: 'Harvey Lewis',
      body: 'took your ground on Skyline Loop',
      link: '/territory/2',
      read: true,
      createdAt: new Date(Date.now() - 200_000_000).toISOString(),
    },
  ],
}

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function signedInScreen() {
  const screen = await start('Notifications')
  const tokenRequest = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  expect(tokenRequest.payload).toMatchObject({ method: 'get', args: ['auth_token'] })
  const before = requests(screen).length
  answer(screen, tokenRequest, 'native-token')
  const read = await waitForRequest(screen, before, r => r.payload?.module === 'Network')
  return { screen, read }
}

describe('Wildloop native notifications screen', () => {
  beforeAll(compileNativeBundle, 30000)

  /*
   * The same list boundary Records was moved onto in 093ef1ac: a keyed `:for`
   * on the element rather than a `<template>` inside a `FlatList`, whose item
   * expansion is host-specific. Nested, because this list has day headings.
   */
  it('renders its rows through the portable keyed :for boundary', () => {
    expect(SOURCE).toContain('<View :for="day in sections()" :key="day.label"')
    expect(SOURCE).toContain('<Pressable :for="row in day.items" :key="row.id"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('reads the token before asking, and sends it', async () => {
    const { read } = await signedInScreen()

    expect(read.payload.args[0].url).toBe('https://wildloop.org/api/notifications')
    expect(read.payload.args[0].headers.authorization).toBe('Bearer native-token')
  })

  it('groups what it gets under the same headings as the web page', async () => {
    const { screen, read } = await signedInScreen()
    answer(screen, read, ok(PAYLOAD))

    const texts = await waitForText(screen, 'Kim Gottwald')
    expect(texts).toContain('gave you kudos on Mist Trail')
    expect(texts).toContain('Today')
    expect(texts).toContain('Earlier')
    // From the shared helper, so the row cannot describe the instant its own way.
    expect(texts).toContain(timeAgo(PAYLOAD.notifications[0].createdAt))
    expect(texts).toContain('1 unread')
  })

  /*
   * The badge is why somebody opened the screen, so it clears on the tap and
   * the request follows. A write that had to land first would read as a tap
   * that did nothing.
   */
  /*
   * An empty list means two different things, and the screen used to give one
   * answer for both. Under "Conquests" the filter really is hiding the rest,
   * and naming it tells the reader what to change. Under "All" nothing is
   * being withheld, so "Nothing under this filter" reads as though the app is
   * keeping something back when the truth is that nothing has happened.
   */
  it('blames the filter for an empty list only when a filter is on', async () => {
    const { screen, read } = await signedInScreen()
    answer(screen, read, ok({ notifications: [] }))
    await waitForText(screen, 'No notifications yet.')
    expect(nativeNodeText(screen, 'notifications-empty')).toBe('No notifications yet.')
    await screen.event('cycle-filter', 'onPress')
    await waitForText(screen, 'Nothing under this filter.')
    expect(nativeNodeText(screen, 'notifications-empty')).toBe('Nothing under this filter.')
  })

  it('clears the badge before the write lands, then writes', async () => {
    const { screen, read } = await signedInScreen()
    answer(screen, read, ok(PAYLOAD))
    await waitForText(screen, '1 unread')

    const before = requests(screen).length
    const sentBefore = screen.sent.length
    await screen.event('mark-all', 'onPress')

    // The token is already in hand from the read, so the write goes straight
    // out rather than asking the keychain twice.
    const write = await waitForRequest(screen, before, r => r.payload?.module === 'Network')
    // Measured from the tap, not over the whole history: "All caught up" is
    // what the screen said before any data arrived, so a history-wide check
    // would pass whether the tap worked or not.
    expect(shownTextSince(screen, sentBefore)).toContain('All caught up')

    expect(write.payload.args[0].url).toBe('https://wildloop.org/api/notifications/read')
    expect(write.payload.args[0].method).toBe('POST')
    expect(write.payload.args[0].headers.authorization).toBe('Bearer native-token')
  })

  it('opens what a row is about on the web side', async () => {
    const { screen, read } = await signedInScreen()
    answer(screen, read, ok(PAYLOAD))
    await waitForText(screen, 'Harvey Lewis')

    // The last row the screen drew, which is the conquest under Earlier.
    await screen.event('notification-row', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)).toMatchObject({ type: 'NAVIGATE_OPEN', payload: { path: '/territory/2' } })
  })

  /*
   * No token at all is not an error to apologise for — it is a screen with
   * nothing to show yet, and it says what signing in would get you.
   */
  it('asks a signed-out visitor to sign in rather than reporting a failure', async () => {
    const screen = await start('Notifications')
    const tokenRequest = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
    answer(screen, tokenRequest, null)

    await waitForText(screen, 'Sign in to hear when somebody gives you kudos, challenges you, or takes your ground.')
    expect(requests(screen).some(request => request.payload?.module === 'Network')).toBe(false)
    expect(shownText(screen).some(text => text.includes('Could not load'))).toBe(false)
  })

  it('reports a read it could not finish', async () => {
    const { screen, read } = await signedInScreen()
    answer(screen, read, { status: 500, statusText: 'Server Error', headers: {}, body: '{}' })

    await waitForText(screen, 'Could not load your notifications')
  })
})
