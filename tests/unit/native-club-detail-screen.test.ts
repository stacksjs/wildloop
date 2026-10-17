import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, start, visibility, waitForRequest, waitForText, waitForVisibility } from '../fixtures/nativeScreen'

/**
 * One club, natively.
 *
 * Eighteenth screen. What it pins: the permissions are read off the payload —
 * inviting needs an owner or admin *on the roster* and deleting is the
 * creator's alone — an invite-only club offers a code rather than a button, a
 * refused join puts the member count back where it started, and deleting
 * takes two taps.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/ClubDetail.stx'), 'utf8')

/** The source with comments blanked — prose about a banned token matches a naive grep. */
const CODE = SOURCE
  .replace(/\{\{--[\s\S]*?--\}\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

const ME = 12
const OWNER = 44
const ADMIN = 90

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function detail(over: Record<string, unknown> = {}) {
  return {
    success: true,
    club: {
      id: 2,
      name: 'Dawn Patrol',
      type: 'Running',
      location: 'San Diego, CA',
      description: 'Before work, every day.',
      memberCount: 48,
      joinPolicy: 'open',
      creatorId: OWNER,
      isMember: false,
      weeklyDistance: 184.6,
      activitiesThisWeek: 37,
      members: [
        { userId: OWNER, name: 'Marta Keller', role: 'owner' },
        { userId: ADMIN, name: 'Rui Alves', role: 'admin' },
        { userId: ME, name: 'Glenn', role: 'member' },
      ],
      leaderboard: [{ rank: 1, name: 'Marta Keller', weeklyDistance: 52.1 }],
      recentFeed: [],
      ...over,
    },
  }
}

const INVITES = {
  invites: [
    { id: 1, code: 'AAAA1111', status: 'pending', invitedEmail: 'a@example.com', invitedName: null, createdAt: '2026-10-16T07:00:00.000Z' },
  ],
}

/** Start on an id, answer the keychain, `/api/me`, the club and the invites. */
async function open(id: unknown, body: unknown = detail(), status = 200, viewer = ME) {
  const screen = await start('ClubDetail', { id })

  if (!/^\d+$/.test(String(id ?? '')) || Number(id) <= 0)
    return { screen }

  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, 'tok_abc')

  const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  answer(screen, me, ok({ success: true, user: { id: viewer } }))

  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/clubs/'))
  if (status !== 200) {
    answer(screen, request, { status, statusText: 'No', headers: {}, body: '{}' })
    return { screen, request }
  }
  answer(screen, request, ok(body))

  // Only an owner or an admin asks for invites, so this is conditional.
  const club = (body as any)?.club
  const role = (club?.members ?? []).find((m: any) => m.userId === viewer)?.role
  if (role === 'owner' || role === 'admin') {
    const list = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/invites'))
    answer(screen, list, ok(INVITES))
    return { screen, request, list }
  }
  return { screen, request }
}

/**
 * The text a node currently shows.
 *
 * Walks the initial RENDER for the node's id, so it works for a node that
 * exists from the start and **not** for one inside a `:for` — a loop row is
 * `createNode`d with a fresh id and the render only holds the template. For a
 * row, assert on `shownText` with a value that came from the payload, which
 * cannot be there unless the row rendered.
 */
function textOf(screen: any, testID: string): string {
  const ids = new Map<string, string>()
  const walk = (node: any): void => {
    if (node?.props?.testID)
      ids.set(String(node.props.testID), String(node.props.__stxId))
    for (const child of node?.children ?? []) {
      if (child && typeof child === 'object')
        walk(child)
    }
  }
  walk(screen.sent.find((m: any) => m.type === 'RENDER')?.payload.document)
  const id = ids.get(testID)
  if (!id)
    return ''
  let text = ''
  for (const message of screen.sent.filter((m: any) => m.type === 'MUTATE')) {
    for (const op of message.payload.operations) {
      if (op.id === id && Array.isArray(op.patch?.children))
        text = String(op.patch.children[0] ?? '')
    }
  }
  return text
}

function joinCalls(screen: any) {
  return requests(screen).filter((r: any) =>
    r.payload?.module === 'Network' && String(r.payload.args[0].url ?? '').endsWith('/join'))
}

describe('Wildloop native club detail screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders its lists through the portable keyed boundary', () => {
    for (const list of ['member in members()', 'row in board()', 'invite in invites()'])
      expect(SOURCE).toContain(`:for="${list}"`)
    expect(SOURCE).not.toContain('<FlatList')
  })

  /*
   * `enableClipboard` is false in the app's capability set, so `craft.clipboard`
   * does not exist here. A copy button would do nothing.
   */
  it('offers no copy button, because there is no clipboard', () => {
    expect(CODE).not.toContain('clipboard')
    // The code itself is still shown, as text.
    expect(CODE).toContain('testID="invite-code"')
    // And the reason is still written down, in a comment.
    expect(SOURCE).toContain('enableClipboard')
  })

  it('asks the API, not the page path', async () => {
    const { request } = await open('2')

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/clubs/2')
  })

  it('loads nothing for a parameter that is not a club', async () => {
    for (const id of ['', 'abc', '0', '-3', '2.5']) {
      const { screen } = await open(id)
      await waitForVisibility(screen, 'club-missing', 'flex')

      expect(requests(screen)).toHaveLength(0)
      expect(visibility(screen, 'club-body')).toBe('none')
    }
  })

  it('reads a 404 as no such club rather than as a failure', async () => {
    const { screen } = await open('2', detail(), 404)
    await waitForVisibility(screen, 'club-missing', 'flex')

    expect(visibility(screen, 'club-error')).toBe('none')
  })

  it('shows the club, its week and its roster', async () => {
    const { screen } = await open('2')
    const texts = await waitForText(screen, 'Dawn Patrol')

    expect(texts).toContain('Before work, every day.')
    expect(texts).toContain('48 members')
    expect(texts).toContain('184.6 mi')
    expect(texts).toContain('Marta Keller')
    expect(texts).toContain('Owner')
    expect(texts).toContain('1. Marta Keller')
  })

  it('names the viewer\'s own role', async () => {
    const { screen } = await open('2')
    await waitForVisibility(screen, 'club-role', 'flex')

    expect(textOf(screen, 'club-role')).toBe('Member')
  })

  it('pushes a member to their own screen', async () => {
    const { screen } = await open('2')
    await waitForText(screen, 'Marta Keller')

    await screen.event('club-member', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'AthleteDetail' }) }),
    )
  })

  it('joins and counts up', async () => {
    const { screen } = await open('2')
    await waitForText(screen, 'Dawn Patrol')
    expect(textOf(screen, 'club-members')).toBe('48 members')

    await screen.event('club-join', 'onPress')
    const post = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url ?? '').endsWith('/join'))
    answer(screen, post, ok({ success: true, joined: true, memberCount: 49 }))
    await waitForText(screen, '49 members')

    expect(textOf(screen, 'club-join')).toBe('Leave')
  })

  /*
   * The bug this club actually had: a refused join took 48 members to 47,
   * because the count moved the way the tap had instead of back to where it
   * started.
   */
  it('puts the count back where it started when a join is refused', async () => {
    const { screen } = await open('2')
    await waitForText(screen, 'Dawn Patrol')

    await screen.event('club-join', 'onPress')
    const post = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url ?? '').endsWith('/join'))
    answer(screen, post, ok({ success: false, error: 'That club is closed.' }))
    await waitForVisibility(screen, 'club-notice', 'flex')

    expect(shownText(screen)).toContain('That club is closed.')
    expect(textOf(screen, 'club-members')).toBe('48 members')
    expect(textOf(screen, 'club-join')).toBe('Join')
  })

  it('takes the server\'s word on which way it went', async () => {
    const { screen } = await open('2')
    await waitForText(screen, 'Dawn Patrol')

    await screen.event('club-join', 'onPress')
    const post = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url ?? '').endsWith('/join'))
    // A request-to-join club answers success with `joined: false`.
    answer(screen, post, ok({ success: true, joined: false, memberCount: 48 }))
    await Bun.sleep(3)

    expect(textOf(screen, 'club-join')).toBe('Join')
    expect(textOf(screen, 'club-members')).toBe('48 members')
  })

  it('does not send a second join while one is in flight', async () => {
    const { screen } = await open('2')
    await waitForText(screen, 'Dawn Patrol')

    await screen.event('club-join', 'onPress')
    await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url ?? '').endsWith('/join'))
    const during = joinCalls(screen).length
    await screen.event('club-join', 'onPress')
    await Bun.sleep(2)

    expect(joinCalls(screen)).toHaveLength(during)
    expect(during).toBe(1)
  })

  /*
   * An invite-only club cannot be joined with a button, so it offers the code
   * field instead — and the join button is not there at all.
   */
  it('offers a code rather than a button on an invite-only club', async () => {
    const { screen } = await open('2', detail({ joinPolicy: 'invite_only' }))
    await waitForVisibility(screen, 'club-closed', 'flex')

    expect(visibility(screen, 'club-join')).toBe('none')
    console.error('[X] invite strings:', JSON.stringify(shownText(screen).filter(s => /nvite only/i.test(s))))
    console.error('[X] door:', JSON.stringify(textOf(screen, 'club-door')), 'join:', JSON.stringify(textOf(screen, 'club-join')))
    expect(shownText(screen)).toContain('Invite only')
  })

  it('holds out for a whole code before asking the server', async () => {
    const { screen } = await open('2', detail({ joinPolicy: 'invite_only' }))
    await waitForText(screen, 'Dawn Patrol')
    await waitForVisibility(screen, 'club-closed', 'flex')

    const before = requests(screen).length
    await screen.event('redeem-code', 'onChangeText', { text: 'ABC' })
    await screen.event('club-redeem', 'onPress')
    await waitForVisibility(screen, 'club-notice', 'flex')

    expect(shownText(screen)).toContain('Enter the invite code you were sent.')
    expect(requests(screen)).toHaveLength(before)
  })

  it('redeems a whole code, without naming the club', async () => {
    const { screen } = await open('2', detail({ joinPolicy: 'invite_only' }))
    await waitForText(screen, 'Dawn Patrol')
    await waitForVisibility(screen, 'club-closed', 'flex')

    await screen.event('redeem-code', 'onChangeText', { text: 'ABCD1234' })
    await screen.event('club-redeem', 'onPress')
    const post = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url ?? '').includes('/invites/accept'))

    expect(String(post.payload.args[0].url)).toBe('https://wildloop.org/api/clubs/invites/accept')
    expect(JSON.parse(String(post.payload.args[0].body))).toEqual({ code: 'ABCD1234' })
  })

  /*
   * Inviting is read off the roster, not off `isMember`. A plain member shown
   * the form is being offered something the API refuses.
   */
  it('offers invites to an admin and not to a member', async () => {
    const asMember = await open('2')
    await waitForText(asMember.screen, 'Dawn Patrol')
    expect(visibility(asMember.screen, 'club-invites')).toBe('none')

    const asAdmin = await open('2', detail(), 200, ADMIN)
    await waitForText(asAdmin.screen, 'Dawn Patrol')
    await waitForVisibility(asAdmin.screen, 'club-invites', 'flex')
    /*
     * Waits on the code itself, which is a loop row rather than a node that
     * exists from the start — so `shownText`, not `textOf`. The panel appears
     * as soon as the role is known, a batch before the list arrives, so
     * asserting off its visibility reads the rows empty.
     */
    const texts = await waitForText(asAdmin.screen, 'AAAA1111')
    expect(texts).toContain('a@example.com')
  })

  it('creates an invite for an email', async () => {
    const { screen } = await open('2', detail(), 200, ADMIN)
    await waitForText(screen, 'Dawn Patrol')
    await waitForVisibility(screen, 'club-invites', 'flex')

    await screen.event('invite-email', 'onChangeText', { text: 'new@example.com' })
    await screen.event('club-invite', 'onPress')
    const post = await waitForRequest(screen, 0, r =>
      String(r.payload?.args?.[0]?.method ?? '') === 'POST' && String(r.payload.args[0].url).endsWith('/invites'))

    expect(String(post.payload.args[0].url)).toBe('https://wildloop.org/api/clubs/2/invites')
    expect(JSON.parse(String(post.payload.args[0].body))).toEqual({ email: 'new@example.com' })
  })

  it('will not create an invite with no address', async () => {
    const { screen } = await open('2', detail(), 200, ADMIN)
    await waitForText(screen, 'Dawn Patrol')
    await waitForVisibility(screen, 'club-invites', 'flex')

    const before = requests(screen).length
    await screen.event('club-invite', 'onPress')
    await waitForVisibility(screen, 'club-notice', 'flex')

    expect(shownText(screen)).toContain('Enter the email address to invite.')
    expect(requests(screen)).toHaveLength(before)
  })

  /*
   * Deleting is the creator's alone. An admin's role sounds like it should
   * cover it and does not.
   */
  it('offers delete to the creator and to nobody else', async () => {
    const asAdmin = await open('2', detail(), 200, ADMIN)
    await waitForText(asAdmin.screen, 'Dawn Patrol')
    expect(visibility(asAdmin.screen, 'club-delete')).toBe('none')

    const asOwner = await open('2', detail(), 200, OWNER)
    await waitForText(asOwner.screen, 'Dawn Patrol')
    await waitForVisibility(asOwner.screen, 'club-delete', 'flex')
  })

  it('takes two taps to delete, and the first sends nothing', async () => {
    const { screen } = await open('2', detail(), 200, OWNER)
    await waitForText(screen, 'Dawn Patrol')
    await waitForVisibility(screen, 'club-delete', 'flex')

    const before = requests(screen).length
    await screen.event('club-delete', 'onPress')
    await waitForText(screen, 'Really delete? Everybody loses it.')
    expect(requests(screen)).toHaveLength(before)

    await screen.event('club-delete', 'onPress')
    const gone = await waitForRequest(screen, before, r => String(r.payload?.args?.[0]?.method ?? '') === 'DELETE')
    expect(String(gone.payload.args[0].url)).toBe('https://wildloop.org/api/clubs/2')
  })

  it('goes back to the directory once the club is gone', async () => {
    const { screen } = await open('2', detail(), 200, OWNER)
    await waitForText(screen, 'Dawn Patrol')
    await waitForVisibility(screen, 'club-delete', 'flex')

    await screen.event('club-delete', 'onPress')
    await waitForText(screen, 'Really delete? Everybody loses it.')
    await screen.event('club-delete', 'onPress')
    const gone = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'DELETE')
    answer(screen, gone, ok({ success: true }))
    await Bun.sleep(3)

    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'Clubs' }) }),
    )
  })

  it('offers the way back when there is nothing to show', async () => {
    const { screen } = await open('nope')
    await waitForVisibility(screen, 'club-missing', 'flex')

    await screen.event('back-to-clubs', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'Clubs' }) }),
    )
  })
})
