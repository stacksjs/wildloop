import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, shownTextSince, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'
import { clubMemberText, clubWeekLine } from '../../resources/functions/clubs'

/**
 * The club directory, natively.
 *
 * Seventh screen, and the second that writes per row. What it pins: joining
 * and leaving go through the one endpoint the server decides, the row is put
 * back from the server's answer rather than from what the tap assumed, an
 * invite-only club opens its page instead of offering a button that would be
 * refused, and the filter is applied in the client because the directory
 * arrives whole.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Clubs.stx'), 'utf8')

const CLUBS = {
  clubs: [
    { id: 1, name: 'Queen City Trail Club', description: 'Tuesday nights.', location: 'Cincinnati, OH', type: 'Running', isPrivate: false, joinPolicy: 'open', memberCount: 48, isMember: false, weeklyDistance: 312, activitiesThisWeek: 27 },
    { id: 2, name: 'Alpenverein Munich', description: 'Weekend ridges.', location: 'Munich, Bayern', type: 'Hiking', isPrivate: false, joinPolicy: 'request', memberCount: 1, isMember: true, weeklyDistance: 0, activitiesThisWeek: 0 },
    { id: 3, name: 'Gorge Land Grab', description: 'Loops only.', location: 'Portland, OR', type: 'Territory Game', isPrivate: true, joinPolicy: 'invite_only', memberCount: 9, isMember: false, weeklyDistance: 64, activitiesThisWeek: 1 },
  ],
}

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/*
 * The listing is public, but `isMember` is not: without the viewer's token
 * every club comes back as one they are not in. So the screen reads the
 * keychain before it reads the directory, and the test answers that first.
 */
async function directory(token: string | null = 'tok_abc') {
  const screen = await start('Clubs')
  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, token)
  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  return { screen, request }
}

describe('Wildloop native clubs screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders the list through the portable keyed boundary', () => {
    expect(SOURCE).toContain(':for="club in shown()" :key="club.id"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('reads the directory with the viewer\'s token, so membership is real', async () => {
    const { request } = await directory()

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/clubs')
    expect(request.payload.args[0].headers.authorization).toBe('Bearer tok_abc')
  })

  it('still reads the directory when nobody is signed in', async () => {
    const { request } = await directory(null)

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/clubs')
    expect(request.payload.args[0].headers.authorization).toBeUndefined()
  })

  it('reads the keychain once, however many callers want the token', async () => {
    const { screen } = await directory()

    const keychainReads = requests(screen).filter((r: any) => r.payload?.module === 'SecureStorage')
    expect(keychainReads).toHaveLength(1)
  })

  it('shows each crew with the numbers the shared module computes', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(CLUBS))
    const texts = await waitForText(screen, 'Queen City Trail Club')

    expect(texts).toContain('Cincinnati, OH · Running')
    expect(texts).toContain(`${clubMemberText(48)} · ${clubWeekLine(CLUBS.clubs[0] as any)}`)
    expect(texts).toContain('48 members · 312 mi · 27 activities this week')
  })

  /*
   * A club that did nothing this week says so. Two zeroes in a metric row is
   * what the web page can afford; on a phone row it reads as a broken number.
   */
  it('says a quiet week rather than showing two zeroes', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(CLUBS))
    const texts = await waitForText(screen, 'Alpenverein Munich')

    expect(texts).toContain('1 member · Quiet week')
  })

  it('names the door only where the button has not said it', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(CLUBS))
    const texts = await waitForText(screen, 'Gorge Land Grab')

    expect(texts).toContain('Invite only')
    expect(texts).toContain('Ask to join')
  })

  it('filters in the client, because the directory arrives whole', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(CLUBS))
    await waitForText(screen, 'Queen City Trail Club')

    const before = requests(screen).length
    await screen.event('cycle-filter', 'onPress')
    await Bun.sleep(0)

    // "My clubs": the one the viewer is in, and no second trip to the server.
    expect(requests(screen).length).toBe(before)
    expect(shownText(screen)).toContain('My clubs')
  })

  /*
   * An invite-only club cannot be joined from a list, so the control goes to
   * the club's page — where the invite code is redeemed — instead of sending a
   * request the server would refuse. The fixture taps the last row carrying
   * the testID, which is that club.
   *
   * A push rather than a web-view hand-off since ClubDetail: `/club/:id` is a
   * native screen now.
   */
  it('pushes the page of an invite-only club instead of asking to join it', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(CLUBS))
    await waitForText(screen, 'Gorge Land Grab')

    const before = requests(screen).length
    await screen.event('club-action', 'onPress')
    await Bun.sleep(0)

    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'ClubDetail', params: { id: '3' } }) }),
    )
    expect(requests(screen).length).toBe(before)
  })

  /*
   * Join and leave are the same endpoint and the server decides the direction,
   * so the row is put back from `joined` in the response rather than from what
   * the tap assumed. One open club here, so the tap lands on it.
   */
  it('joins through the one endpoint, and takes the server\'s answer for the row', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok({ clubs: [CLUBS.clubs[0]] }))
    await waitForText(screen, 'Queen City Trail Club')
    expect(shownText(screen)).toContain('48 members · 312 mi · 27 activities this week')

    const before = requests(screen).length
    await screen.event('club-action', 'onPress')
    const join = await waitForRequest(screen, before, r => r.payload?.module === 'Network')

    expect(join.payload.args[0].url).toBe('https://wildloop.org/api/clubs/1/join')
    expect(join.payload.args[0].method).toBe('POST')
    expect(join.payload.args[0].headers.authorization).toBe('Bearer tok_abc')

    // Measured from here, not from the whole transcript: '48 members' and
    // 'Join' are both in the history from before the tap, so a search over
    // everything passes whatever the screen does with the response.
    /*
     * The server answers 52, not the 49 the tap guessed — three other people
     * joined while this one was deciding. Asserting on 49 would pass against
     * the optimistic update alone and prove nothing about the response.
     */
    const afterAnswer = screen.sent.length
    answer(screen, join, { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ success: true, joined: true, memberCount: 52 }) })
    await waitForText(screen, '52 members · 312 mi · 27 activities this week')

    expect(shownTextSince(screen, afterAnswer)).toContain('52 members · 312 mi · 27 activities this week')
  })

  /*
   * The count moves before the server has answered, because a join that waits
   * a round trip to show feels broken. It is a claim, not a fact, until the
   * response lands.
   */
  it('moves the row optimistically, then puts it back when the server refuses', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok({ clubs: [CLUBS.clubs[0]] }))
    await waitForText(screen, 'Queen City Trail Club')

    const before = requests(screen).length
    await screen.event('club-action', 'onPress')
    const join = await waitForRequest(screen, before, r => r.payload?.module === 'Network')
    expect(shownText(screen)).toContain('49 members · 312 mi · 27 activities this week')

    const afterRefusal = screen.sent.length
    answer(screen, join, { status: 403, statusText: 'Forbidden', headers: {}, body: '{}' })
    await Bun.sleep(1)

    // Since the refusal landed, not somewhere in the transcript: the row read
    // '48 members' and 'Join' before the tap, so searching the whole history
    // would pass even if the screen kept the optimistic value.
    const since = shownTextSince(screen, afterRefusal)
    expect(since).toContain('48 members · 312 mi · 27 activities this week')
    expect(since).toContain('Join')
  })

  it('says to sign in rather than failing silently, when there is no token', async () => {
    const { screen, request } = await directory(null)
    answer(screen, request, ok({ clubs: [CLUBS.clubs[0]] }))
    await waitForText(screen, 'Queen City Trail Club')

    const before = requests(screen).length
    await screen.event('club-action', 'onPress')
    const texts = await waitForText(screen, 'Sign in on the web to join a club.')

    expect(requests(screen).length).toBe(before)
    expect(texts).toContain('Join')
  })

  it('pushes a row to the club\'s own screen', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(CLUBS))
    await waitForText(screen, 'Gorge Land Grab')

    await screen.event('club-row', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'ClubDetail', params: { id: '3' } }) }),
    )
  })

  it('reports a directory it could not load', async () => {
    const { screen, request } = await directory()
    answer(screen, request, { status: 500, statusText: 'Server Error', headers: {}, body: '{}' })

    await waitForText(screen, 'Could not load clubs')
  })
})
