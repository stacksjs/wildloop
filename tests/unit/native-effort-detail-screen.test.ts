import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, waitForGeometry, shownText, start, visibility, waitForRequest, waitForText, waitForVisibility } from '../fixtures/nativeScreen'

/**
 * One record attempt, natively.
 *
 * Sixteenth screen, and the one that closes the records board's last hand-off
 * to the web. What it pins: the attempt is asked for by the route's id, which
 * buttons exist comes from the server's own `isOwner`/`canReview` rather than
 * a locally-held viewer id, a finish files the instant it is pressed, the
 * course is parsed out of the trail's `geometry` and drawn open, and review —
 * which needs a note — opens the web page instead of offering half a decision.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/EffortDetail.stx'), 'utf8')

/**
 * The source with its comments blanked.
 *
 * Counting a banned token by a naive grep is the hazard CLAUDE.md names: the
 * comment at the top of this screen explains *why* it runs no timer, and
 * quotes `setTimeout` to do it, so the ban matched the explanation. Strip
 * first, then look.
 */
const CODE = SOURCE
  .replace(/\{\{--[\s\S]*?--\}\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

const STARTED = '2026-10-16T06:00:00.000Z'

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function effortBody(over: Record<string, unknown> = {}) {
  return {
    effort: {
      id: 31,
      userId: 12,
      userName: 'Glenn',
      trailId: 7,
      trailName: 'Steep Ravine Loop',
      trailDistance: 8.2,
      style: 'unsupported',
      category: 'mens',
      direction: 'standard',
      teamSize: 1,
      status: 'verified',
      startedAt: STARTED,
      finishedAt: '2026-10-16T07:12:43.000Z',
      elapsedSeconds: 4363,
      elapsedLabel: '1:12:43',
      paceLabel: '8:52 /mi',
      evidenceUrl: null,
      gpxUrl: null,
      trackerUrl: null,
      tripReport: null,
      reviewNote: null,
      reviewedAt: null,
      rank: 3,
      bucketSize: 12,
      headline: false,
      isOwner: false,
      canReview: false,
      ...over,
    },
  }
}

const TRAIL = { trail: { id: 7, geometry: [[37.90, -122.64], [37.91, -122.65], [37.92, -122.66]] } }

/** Start on an id and answer the keychain, the attempt and the course. */
async function open(id: unknown, body: unknown = effortBody(), status = 200, trail: unknown = TRAIL) {
  const screen = await start('EffortDetail', { id })

  // A parameter that cannot be an attempt does no I/O at all.
  if (!/^\d+$/.test(String(id ?? '')) || Number(id) <= 0)
    return { screen }

  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, 'tok_abc')

  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/route-efforts/'))
  if (status !== 200) {
    answer(screen, request, { status, statusText: 'No', headers: {}, body: '{}' })
    return { screen, request }
  }
  answer(screen, request, ok(body))

  const course = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/trails/'))
  answer(screen, course, trail === null ? { status: 500, statusText: 'No', headers: {}, body: '{}' } : ok(trail))
  return { screen, request, course }
}


function networkCalls(screen: any) {
  return requests(screen).filter((r: any) => r.payload?.module === 'Network').map((r: any) => ({
    url: String(r.payload.args[0].url),
    method: String(r.payload.args[0].method ?? 'GET'),
    body: r.payload.args[0].body ?? null,
  }))
}

describe('Wildloop native effort detail screen', () => {
  beforeAll(compileNativeBundle)

  it('renders its evidence through the portable keyed boundary', () => {
    expect(SOURCE).toContain(':for="row in evidence()"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  /*
   * The native runtime does not promise a timer, so the screen must not tick.
   * A ticking clock would pass every test here and stop on a phone.
   */
  it('runs no timer, because the runtime does not promise one', () => {
    expect(CODE).not.toContain('setInterval')
    expect(CODE).not.toContain('setTimeout')
    // The explanation is still there, in a comment, where it belongs.
    expect(SOURCE).toContain('setTimeout')
  })

  it('asks for the attempt the route named', async () => {
    const { request } = await open('31')

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/route-efforts/31')
    expect(request.payload.args[0].headers.authorization).toBe('Bearer tok_abc')
  })

  it('loads nothing for a parameter that is not an attempt', async () => {
    for (const id of ['', 'abc', '0', '-3', '31.5.1']) {
      const { screen } = await open(id)
      await waitForVisibility(screen, 'effort-missing', 'flex')

      expect(requests(screen)).toHaveLength(0)
      expect(visibility(screen, 'effort-body')).toBe('none')
    }
  })

  it('reads a 404 as not found rather than as a failure', async () => {
    const { screen } = await open('31', effortBody(), 404)
    await waitForVisibility(screen, 'effort-missing', 'flex')

    expect(visibility(screen, 'effort-error')).toBe('none')
  })

  it('shows the attempt, its clock and where it ranks', async () => {
    const { screen } = await open('31')
    const texts = await waitForText(screen, 'Steep Ravine Loop')

    expect(texts).toContain('Glenn')
    expect(texts).toContain('1:12:43')
    expect(texts).toContain('8:52 /mi')
    expect(texts).toContain('3 of 12 on this board')
  })

  /*
   * The course comes from the trail's stored `geometry`, which needs parsing —
   * reading a `line` key the endpoint never sends draws nothing, silently.
   */
  it('draws the course parsed out of the trail geometry', async () => {
    const { screen } = await open('31')
    await waitForVisibility(screen, 'effort-map-frame', 'flex')

    const [drawn] = await waitForGeometry(screen)
    expect(drawn).toEqual([37.90, -122.64, 37.91, -122.65, 37.92, -122.66])
  })

  /* A course is a line that goes somewhere; closing it draws a leg nobody ran. */
  it('leaves the course open, unlike a territory', async () => {
    const { screen } = await open('31')
    await waitForVisibility(screen, 'effort-map-frame', 'flex')

    const [drawn] = await waitForGeometry(screen)
    expect(drawn.slice(0, 2)).not.toEqual(drawn.slice(-2))
  })

  it('keeps the attempt when its course cannot be loaded', async () => {
    const { screen } = await open('31', effortBody(), 200, null)
    await waitForText(screen, 'Steep Ravine Loop')

    expect(visibility(screen, 'effort-body')).toBe('flex')
    expect(visibility(screen, 'effort-error')).toBe('none')
    expect(visibility(screen, 'effort-map-frame')).toBe('none')
  })

  /*
   * The gating is the server's. A screen that worked ownership out locally
   * would offer buttons the API refuses, and the athlete would find out from
   * an error.
   */
  it('offers nothing on somebody else\'s attempt', async () => {
    const { screen } = await open('31')
    await waitForText(screen, 'Steep Ravine Loop')

    expect(visibility(screen, 'effort-actions')).toBe('none')
    expect(visibility(screen, 'effort-review')).toBe('none')
  })

  it('offers the athlete their own running attempt', async () => {
    const { screen } = await open('31', effortBody({ isOwner: true, status: 'in_progress', elapsedLabel: '—', finishedAt: null }))
    await waitForVisibility(screen, 'effort-actions', 'flex')

    expect(visibility(screen, 'effort-finish')).toBe('flex')
    expect(visibility(screen, 'effort-dnf')).toBe('flex')
    expect(visibility(screen, 'effort-withdraw')).toBe('flex')
  })

  it('does not offer to withdraw a verified record', async () => {
    const { screen } = await open('31', effortBody({ isOwner: true, status: 'verified' }))
    await waitForText(screen, 'Steep Ravine Loop')

    expect(visibility(screen, 'effort-withdraw')).toBe('none')
  })

  it('says a live attempt is still running, and that the clock was read at load', async () => {
    const { screen } = await open('31', effortBody({ status: 'in_progress', elapsedLabel: '—', finishedAt: null }))
    await waitForVisibility(screen, 'effort-live', 'flex')

    expect(shownText(screen)).toContain('Still running — read at load')
  })

  /* A finish files the instant it was pressed, as a PATCH on the attempt. */
  it('files a finish for now', async () => {
    const { screen } = await open('31', effortBody({ isOwner: true, status: 'in_progress', elapsedLabel: '—', finishedAt: null }))
    await waitForVisibility(screen, 'effort-finish', 'flex')

    const before = Date.now()
    await screen.event('effort-finish', 'onPress')
    const patch = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'PATCH')

    expect(String(patch.payload.args[0].url)).toBe('https://wildloop.org/api/route-efforts/31')
    const sent = JSON.parse(String(patch.payload.args[0].body))
    expect(Date.parse(sent.finished_at)).toBeGreaterThanOrEqual(before - 1000)
    expect(Date.parse(sent.finished_at)).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('marks a DNF as an outcome rather than a time', async () => {
    const { screen } = await open('31', effortBody({ isOwner: true, status: 'in_progress', elapsedLabel: '—', finishedAt: null }))
    await waitForVisibility(screen, 'effort-dnf', 'flex')

    await screen.event('effort-dnf', 'onPress')
    const patch = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'PATCH')

    expect(JSON.parse(String(patch.payload.args[0].body))).toEqual({ outcome: 'dnf' })
  })

  it('withdraws by deleting the attempt', async () => {
    const { screen } = await open('31', effortBody({ isOwner: true, status: 'pending' }))
    await waitForVisibility(screen, 'effort-withdraw', 'flex')

    await screen.event('effort-withdraw', 'onPress')
    const gone = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'DELETE')

    expect(String(gone.payload.args[0].url)).toBe('https://wildloop.org/api/route-efforts/31')
  })

  it('reports an action the server refused, and keeps the attempt on screen', async () => {
    const { screen } = await open('31', effortBody({ isOwner: true, status: 'in_progress', elapsedLabel: '—', finishedAt: null }))
    await waitForVisibility(screen, 'effort-dnf', 'flex')

    await screen.event('effort-dnf', 'onPress')
    const patch = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'PATCH')
    answer(screen, patch, ok({ success: false, error: 'Somebody already filed that.' }))
    await waitForVisibility(screen, 'effort-action-error', 'flex')

    expect(shownText(screen)).toContain('Somebody already filed that.')
    expect(visibility(screen, 'effort-body')).toBe('flex')
  })

  /*
   * Review is on this screen rather than handed off. The first version offered
   * "Review it on the web" through `craft.navigation.open('/effort/31')`,
   * which would have looped back here: that call is not "open the web view",
   * it is "let the shell route this path", and `/effort/:id` is now native.
   */
  it('offers a reviewer the decision here, not a path back to itself', async () => {
    const { screen } = await open('31', effortBody({ canReview: true, status: 'pending' }))
    await waitForVisibility(screen, 'effort-review', 'flex')

    expect(visibility(screen, 'effort-actions')).toBe('none')
    expect(SOURCE).not.toContain('/effort/${wanted')
  })

  it('verifies with the note the reviewer wrote', async () => {
    const { screen } = await open('31', effortBody({ canReview: true, status: 'pending' }))
    await waitForVisibility(screen, 'effort-review', 'flex')

    await screen.event('review-note', 'onChangeText', { text: 'Trace checks out.' })
    await screen.event('effort-verify', 'onPress')
    const posted = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'POST')

    expect(String(posted.payload.args[0].url)).toBe('https://wildloop.org/api/route-efforts/31/review')
    expect(JSON.parse(String(posted.payload.args[0].body))).toEqual({ decision: 'verify', note: 'Trace checks out.' })
  })

  it('verifies without a note, which is allowed', async () => {
    const { screen } = await open('31', effortBody({ canReview: true, status: 'pending' }))
    await waitForVisibility(screen, 'effort-review', 'flex')

    await screen.event('effort-verify', 'onPress')
    const posted = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'POST')

    expect(JSON.parse(String(posted.payload.args[0].body))).toEqual({ decision: 'verify' })
  })

  /*
   * The athlete is owed a reason, so a reject without one is refused here
   * rather than by the API — the reviewer is told before they press it, and
   * nothing is sent.
   */
  it('refuses a rejection with no note, without asking the server', async () => {
    const { screen } = await open('31', effortBody({ canReview: true, status: 'pending' }))
    await waitForVisibility(screen, 'effort-review', 'flex')

    const before = requests(screen).length
    await screen.event('effort-reject', 'onPress')
    await waitForVisibility(screen, 'effort-action-error', 'flex')

    expect(shownText(screen)).toContain('A rejection needs a note.')
    expect(requests(screen)).toHaveLength(before)
  })

  it('rejects with a note', async () => {
    const { screen } = await open('31', effortBody({ canReview: true, status: 'pending' }))
    await waitForVisibility(screen, 'effort-review', 'flex')

    await screen.event('review-note', 'onChangeText', { text: 'No trace for the last four miles.' })
    await screen.event('effort-reject', 'onPress')
    const posted = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'POST')

    expect(JSON.parse(String(posted.payload.args[0].body)))
      .toEqual({ decision: 'reject', note: 'No trace for the last four miles.' })
  })

  it('sends one back without requiring a reason', async () => {
    const { screen } = await open('31', effortBody({ canReview: true, status: 'pending' }))
    await waitForVisibility(screen, 'effort-review', 'flex')

    await screen.event('effort-reopen', 'onPress')
    const posted = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'POST')

    expect(JSON.parse(String(posted.payload.args[0].body))).toEqual({ decision: 'reopen' })
  })

  it('opens the evidence it actually has', async () => {
    const { screen } = await open('31', effortBody({ evidenceUrl: 'https://www.strava.com/activities/9', trackerUrl: 'https://t.example/x' }))
    const texts = await waitForText(screen, 'Activity')

    expect(texts).toContain('Live tracker')
    expect(texts).not.toContain('GPS file')

    await screen.event('evidence-row', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE_OPEN').map((m: any) => String(m.payload?.path)))
      .toContain('https://t.example/x')
  })

  it('re-reads the attempt on refresh', async () => {
    const { screen } = await open('31')
    await waitForText(screen, 'Steep Ravine Loop')

    const before = networkCalls(screen).length
    await screen.event('effort-refresh', 'onPress')
    await waitForRequest(screen, before, r => r.payload?.module === 'Network')

    expect(networkCalls(screen).length).toBeGreaterThan(before)
  })

  it('offers the way back to the board when there is nothing to show', async () => {
    const { screen } = await open('nope')
    await waitForVisibility(screen, 'effort-missing', 'flex')

    await screen.event('back-to-records', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'Records' }) }),
    )
  })
})
