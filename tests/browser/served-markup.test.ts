/**
 * What the app actually serves, read as a document.
 *
 * The `.pw.ts` specs next door drive a real browser because they assert on
 * client-side behaviour: a dropdown opening, a store upserting, a signal firing.
 * None of that can move here — `very-happy-dom` parses markup and deliberately
 * runs no page scripts, so a document arrives inert.
 *
 * What *can* be asserted without a browser is the half those specs never look
 * at: the server-rendered output itself. Heading structure, landmarks, the
 * accessible name of every control, whether `aria-labelledby` targets resolve,
 * whether the social metadata is there. All of it ships to every first-time
 * visitor and to every crawler before a line of JavaScript runs, and none of it
 * was covered.
 *
 * Fetched from the running QA app rather than from `dist/`, which is gitignored
 * and would go stale silently — a suite asserting on a snapshot of markup would
 * keep passing while the real page regressed. This asks the server what it is
 * serving right now, so dynamic routes count too.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { Browser } from 'very-happy-dom'
import { APP, API, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// Same gate as its siblings: these need the isolated QA app, so an ordinary
// `bun test` skips them and CI runs them with RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

/** A served page, parsed into a document that can be queried. */
interface Served {
  page: any
  document: any
  html: string
}

async function serve(path: string): Promise<Served> {
  const response = await fetch(`${APP}${path}`, { headers: { accept: 'text/html' } })
  expect(response.status, `GET ${path}`).toBe(200)
  expect(response.headers.get('content-type') ?? '', `GET ${path} content-type`).toContain('text/html')

  const html = await response.text()
  const page: any = new Browser().newPage()
  page.setDefaultTimeout(2_000)
  await page.setContent(html)

  return { page, document: page.mainFrame.window.document, html }
}

/** Lifted from the element rather than the locator, so a whole page can be swept. */
function accessibleNameOf(element: any): string {
  const labelled = element.getAttribute?.('aria-labelledby')
  if (labelled) {
    const text = labelled.split(/\s+/)
      .map((id: string) => element.ownerDocument?.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text)
      return text
  }

  const label = (element.getAttribute?.('aria-label') ?? '').replace(/\s+/g, ' ').trim()
  if (label)
    return label

  const alt = (element.getAttribute?.('alt') ?? '').replace(/\s+/g, ' ').trim()
  if (alt)
    return alt

  const title = (element.getAttribute?.('title') ?? '').replace(/\s+/g, ' ').trim()
  if (title)
    return title

  return String(element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Decorative by declaration, so an empty name is correct rather than missing. */
function isDecorative(element: any): boolean {
  return element.getAttribute?.('aria-hidden') === 'true'
    || element.getAttribute?.('role') === 'presentation'
    || element.getAttribute?.('role') === 'none'
}

/**
 * Whether the element's name is bound for hydration rather than written out.
 *
 * `x-aria-label` and `:aria-label` are filled in by the runtime, so the control is
 * named once the page is live — it is simply not named in the markup. Counting
 * those as missing would report the app's pre-hydration state as an accessibility
 * defect, which is a different claim from the one this file makes. A control with
 * no name from any source is still caught.
 */
function isNamedOnTheClient(element: any): boolean {
  return element.getAttribute?.('x-aria-label') !== null
    || element.getAttribute?.(':aria-label') !== null
    || element.getAttribute?.('x-aria-labelledby') !== null
}

/** The routes every visitor and crawler sees. */
const ROUTES = ['/', '/trails'] as const

let trailPath = ''

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  // One real trail id, so the dynamic route is exercised rather than assumed.
  const response = await fetch(`${API}/trails?limit=1&sort=featured`)
  expect(response.status, await response.clone().text()).toBe(200)
  const trail = (await response.json()).trails?.[0]
  expect(trail?.id, 'the QA catalog must have at least one trail').toBeDefined()
  trailPath = `/trail/${trail.id}`
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('the served document', () => {
  it('declares a language, a charset and a viewport', async () => {
    for (const route of ROUTES) {
      const { document } = await serve(route)

      expect(document.documentElement.getAttribute('lang'), `${route} lang`).toBeTruthy()
      expect(document.querySelector('meta[charset]'), `${route} charset`).not.toBeNull()
      expect(
        document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
        `${route} viewport`,
      ).toContain('width=device-width')
    }
  })

  it('carries a title that says what the page is', async () => {
    for (const route of ROUTES) {
      const { document } = await serve(route)
      const title = document.title.trim()

      expect(title, `${route} title`).not.toBe('')
      // Long enough to be a sentence, short enough not to be truncated in a tab
      // or a search result.
      expect(title.length, `${route} title length (${JSON.stringify(title)})`).toBeGreaterThan(10)
      expect(title.length, `${route} title length (${JSON.stringify(title)})`).toBeLessThan(70)
    }
  })

  it('renders real content, not an empty shell waiting on JavaScript', async () => {
    // The assertion the whole file rests on: if this ever fails, the app has
    // moved to client rendering and everything below is measuring an empty page.
    for (const route of ROUTES) {
      const { document } = await serve(route)
      // `innerText`, not `textContent`: the latter includes `<script>` bodies, so a
      // page of inline runtime would satisfy this while rendering nothing.
      const text = String(document.body.innerText ?? '').replace(/\s+/g, ' ').trim()

      expect(text.length, `${route} server-rendered text`).toBeGreaterThan(500)
    }
  })
})

describe.skipIf(!qa)('heading structure', () => {
  it('gives each static route exactly one h1', async () => {
    for (const route of ROUTES) {
      const { page } = await serve(route)
      const h1s = await page.getByRole('heading', { level: 1 }).allTextContents()

      expect(h1s.length, `${route} h1 count, found ${JSON.stringify(h1s)}`).toBe(1)
      expect(h1s[0].trim(), `${route} h1 text`).not.toBe('')
      // The failure this locks in: `/trails` used to serve the literal
      // `{{ listHeading() }}`, hidden, with no rendered heading at all.
      expect(h1s[0], `${route} h1 is rendered`).not.toContain('{{')
    }
  })

  // This one was skipped for a long time on a premise that turned out to be
  // wrong: that a per-record heading could not be served because
  // `cache.renderVary: 'source'` keys the render by file path, so one render of
  // `trail/[id].stx` would answer all ~600k trails. A server script that reads
  // its params opts the route out of that cache, which the page now does, so the
  // heading can name its own trail without one trail answering for another.
  //
  // Two separate defects had to go, and the count is what catches the second.
  // The heading held a literal `{{ trail.name }}`, because `trail` is a client
  // signal and nothing had resolved it server-side. And both the trail header
  // and the not-found card were served — `:if` is evaluated on the client, so
  // stx sends both branches — which is two `h1`s for one page.
  it('gives the trail route a server-rendered h1', async () => {
    const { page } = await serve(trailPath)
    const h1s = await page.getByRole('heading', { level: 1 }).allTextContents()

    expect(h1s.length, `${trailPath} h1 count, found ${JSON.stringify(h1s)}`).toBe(1)
    expect(h1s[0], `${trailPath} h1 is rendered, not a literal expression`).not.toContain('{{')

    // The point of serving it at all: the heading has to say which trail this
    // is, to a reader who has run no JavaScript.
    const name = await fetch(`${API}/trails/${trailPath.split('/').pop()}`)
      .then(r => r.json())
      .then(payload => String(payload?.trail?.name ?? '').trim())
    expect(name, 'the API must give a name to compare against').not.toBe('')
    expect(h1s[0], `${trailPath} h1 names the trail`).toContain(name)
  })

  it('does not skip a heading level', async () => {
    for (const route of ROUTES) {
      const { document } = await serve(route)
      const levels = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .map((h: any) => Number(h.tagName[1]))

      expect(levels.length, `${route} has headings to check`).toBeGreaterThan(1)

      const skips = levels
        .map((level, index) => ({ from: levels[index - 1], to: level }))
        .filter(({ from, to }) => from !== undefined && to > from + 1)

      expect(skips, `${route} skipped heading levels`).toEqual([])
    }
  })
})

describe.skipIf(!qa)('landmarks and controls', () => {
  it('has a main landmark', async () => {
    for (const route of ROUTES) {
      const { page } = await serve(route)
      expect(await page.getByRole('main').count(), `${route} main landmark`).toBeGreaterThan(0)
    }
  })

  it('gives every link an accessible name', async () => {
    for (const route of ROUTES) {
      const { document } = await serve(route)
      const links = Array.from(document.querySelectorAll('a[href]')) as any[]

      expect(links.length, `${route} has links to check`).toBeGreaterThan(5)

      const unnamed = links
        .filter(link => !isDecorative(link) && !isNamedOnTheClient(link) && accessibleNameOf(link) === '')
        .map(link => link.getAttribute('href'))

      expect(unnamed, `${route} links with no accessible name`).toEqual([])
    }
  })

  it('gives every button an accessible name', async () => {
    for (const route of ROUTES) {
      const { document } = await serve(route)
      const buttons = Array.from(document.querySelectorAll('button')) as any[]

      expect(buttons.length, `${route} has buttons to check`).toBeGreaterThan(0)

      const unnamed = buttons
        .filter(button => !isDecorative(button) && !isNamedOnTheClient(button) && accessibleNameOf(button) === '')
        .map(button => button.outerHTML.slice(0, 80))

      expect(unnamed, `${route} buttons with no accessible name`).toEqual([])
    }
  })

  it('gives every image an alt, or marks it decorative', async () => {
    for (const route of ROUTES) {
      const { document } = await serve(route)
      const images = Array.from(document.querySelectorAll('img')) as any[]

      expect(images.length, `${route} has images to check`).toBeGreaterThan(0)

      // An empty alt is a deliberate "decorative"; a missing one is an omission.
      const missing = images
        .filter(image => !isDecorative(image) && image.getAttribute('alt') === null)
        .map(image => image.getAttribute('src'))

      expect(missing, `${route} images with no alt attribute`).toEqual([])
    }
  })
})

describe.skipIf(!qa)('references that have to resolve', () => {
  it('has no duplicate ids', async () => {
    // aria-labelledby and aria-describedby resolve by id, so a duplicate makes
    // an accessible name silently wrong rather than absent.
    for (const route of ROUTES) {
      const { document } = await serve(route)
      const ids = Array.from(document.querySelectorAll('[id]')).map((e: any) => e.getAttribute('id'))

      expect(ids.length, `${route} has ids to check`).toBeGreaterThan(0)

      const seen = new Set<string>()
      const duplicates = ids.filter(id => seen.size === seen.add(id).size)

      expect(Array.from(new Set(duplicates)), `${route} duplicate ids`).toEqual([])
    }
  })

  it('points every aria-labelledby and aria-describedby at something real', async () => {
    let checked = 0

    for (const route of ROUTES) {
      const { document } = await serve(route)

      for (const attribute of ['aria-labelledby', 'aria-describedby']) {
        for (const element of Array.from(document.querySelectorAll(`[${attribute}]`)) as any[]) {
          const dangling = (element.getAttribute(attribute) ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .filter((id: string) => document.getElementById(id) === null)

          checked++
          expect(dangling, `${route} ${attribute}="${element.getAttribute(attribute)}" targets`).toEqual([])
        }
      }
    }

    // Reported rather than silently passing on zero: a page with no such
    // references would make this assertion vacuous, and that is worth knowing.
    console.log(`  aria reference attributes checked: ${checked}`)
  })
})

describe.skipIf(!qa)('social and crawler metadata', () => {
  it('carries the Open Graph and description tags a shared link needs', async () => {
    for (const route of ROUTES) {
      const { document } = await serve(route)
      const meta = (selector: string): string =>
        document.querySelector(selector)?.getAttribute('content')?.trim() ?? ''

      expect(meta('meta[name="description"]'), `${route} description`).not.toBe('')
      expect(meta('meta[property="og:title"]'), `${route} og:title`).not.toBe('')
      expect(meta('meta[property="og:description"]'), `${route} og:description`).not.toBe('')
      expect(meta('meta[property="og:image"]'), `${route} og:image`).not.toBe('')
    }
  })
})

describe.skipIf(!qa)('a dynamic route renders its subject', () => {
  it('renders the trail name somewhere a reader can reach it', async () => {
    // Not the h1: that one holds an unrendered `{{ trail.name }}` under
    // `display: none` (see the skipped case above). The name does reach the page
    // through other markup, and this asserts the part that is actually served.
    const { document } = await serve(trailPath)
    const text = String(document.body.innerText ?? '').replace(/\s+/g, ' ')

    expect(text.length, `${trailPath} server-rendered text`).toBeGreaterThan(500)

    // The failure mode this guards: the page shipping its not-found state to a
    // crawler while the client-rendered version looks fine.
    expect(text, `${trailPath} body`).not.toContain('Trail not found')
  })

  it('serves no unrendered template expression where a reader would see it', async () => {
    // `{{ ... }}` reaching a browser is always a defect. The ones on this page are
    // `display: none`, so they are invisible — asserted on the rendered text, which
    // is what a reader and a screen reader actually get.
    const { document } = await serve(trailPath)
    const rendered = String(document.body.innerText ?? '')

    expect(rendered, `${trailPath} rendered text`).not.toContain('{{')
  })

  it('has a title of its own, not the site default', async () => {
    const trail = await serve(trailPath)
    const home = await serve('/')

    expect(trail.document.title.trim(), 'trail page title').not.toBe('')
    expect(trail.document.title, 'a trail page must not reuse the home title').not.toBe(home.document.title)
  })

  // Asserting that a trail's title merely *differs* from the home page's is
  // satisfied by `Trail Details - Wildloop`, which is what every trail page used
  // to serve — the defect sat behind a passing test. These name the trail, which
  // is the property that matters.
  it('names the trail in its title and social metadata', async () => {
    const trailName = await fetch(`${API}/trails/${trailPath.split('/').pop()}`)
      .then(r => r.json())
      .then(payload => String(payload?.trail?.name ?? '').trim())
    expect(trailName, 'the API must give a name to compare against').not.toBe('')

    const { document } = await serve(trailPath)
    const meta = (selector: string): string =>
      document.querySelector(selector)?.getAttribute('content')?.trim() ?? ''

    expect(document.title, 'title names the trail').toContain(trailName)
    expect(meta('meta[property="og:title"]'), 'og:title names the trail').toContain(trailName)
    expect(meta('meta[name="description"]'), 'description names the trail').toContain(trailName)
    // The half a client-side helper cannot reach: a social scraper runs no
    // JavaScript, so this had to be in the served HTML or nowhere.
    expect(meta('meta[name="twitter:title"]'), 'twitter:title names the trail').toContain(trailName)
  })

  it('gives two different trails different metadata', async () => {
    // What the render cache would have broken: one render answering for every
    // trail. Reading `params.id` in the server block opts this route out of the
    // shell cache, and this is the assertion that it worked.
    const listed = await fetch(`${API}/trails?limit=2&sort=featured`).then(r => r.json())
    const ids = (listed.trails ?? []).map((t: any) => t.id).slice(0, 2)
    expect(ids.length, 'need two trails to compare').toBe(2)

    const [first, second] = await Promise.all(ids.map((id: number) => serve(`/trail/${id}`)))

    expect(first.document.title, 'two trails must not share a title').not.toBe(second.document.title)
  })

  it('does not ask a crawler to index a trail that does not exist', async () => {
    // Otherwise every bad id a crawler tries is indexed as a generic page,
    // competing with the real ones.
    const { document } = await serve('/trail/999999999')
    const robots = document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? ''

    expect(robots, 'a missing trail is noindex').toContain('noindex')
  })
})

describe.skipIf(!qa)('a detail page names its own record, and withholds a private one', () => {
  /**
   * Both halves of the server blocks added to the `club`, `activity`, `athlete`,
   * `event`, `effort` and `territory` detail pages.
   *
   * The naming half is the ordinary SEO defect the trail page had: every record
   * served one generic title, so every shared link previewed identically and a
   * crawler saw no difference between them.
   *
   * The withholding half is why these are not the same test as the trail's. A
   * club, an activity and an event each carry a visibility the application
   * enforces per viewer, and a server render has no viewer and is shared by
   * everyone who asks — so it may only ever contain what a signed-out stranger
   * is allowed to see. Rendering a private record's name into a `<meta>` tag
   * would publish it further than the page itself ever goes, into every link
   * preview that scrapes it.
   *
   * The fixtures come in pairs for that reason: asserting only that a public
   * record is named would pass just as well with the gate removed.
   */
  const meta = (document: any, selector: string): string =>
    document.querySelector(selector)?.getAttribute('content')?.trim() ?? ''

  /**
   * The seeded pair at ids 1 and 2, split into the one that names `subject` and
   * the one that does not.
   *
   * Located by probing rather than by asking an API for ids, because the pairs
   * are the first and only rows the QA seed writes to a freshly migrated
   * database. Asserting that *exactly* one of the two is named is what makes
   * this a test of the gate: both named, or neither, fails.
   */
  async function pair(route: string, subject: string): Promise<{ open: Served, shut: Served }> {
    const [first, second] = await Promise.all([serve(`/${route}/1`), serve(`/${route}/2`)])
    const named = [first, second].filter(s => s.document.title.includes(subject))

    expect(named.length, `exactly one ${route} fixture may name "${subject}"`).toBe(1)

    return { open: named[0], shut: [first, second].find(s => !s.document.title.includes(subject))! }
  }

  it('names a public club, and never a private one', async () => {
    const { open, shut } = await pair('club', 'Torrey Pines Striders')

    expect(meta(open.document, 'meta[property="og:title"]'), 'og:title names the public club')
      .toContain('Torrey Pines Striders')

    expect(shut.html, 'a private club appears nowhere in the served HTML').not.toContain('Cove Night Owls')
    expect(shut.html, 'nor does its description').not.toContain('Invite-only dawn patrol')
    expect(meta(shut.document, 'meta[name="robots"]'), 'and it is not offered for indexing').toContain('noindex')
  })

  it('names a public activity, and never a private one', async () => {
    // Activities have no `name` column: the title is assembled from the type and
    // either the trail it is attached to or its distance. Both fixtures sit on
    // Torrey Pines Loop, so the trail name is the thing that must appear for one
    // and not the other.
    const { shut } = await pair('activity', 'Torrey Pines Loop')

    expect(shut.document.title, 'the private one falls back to the generic title')
      .toBe('Activity Details - Wildloop')
    expect(meta(shut.document, 'meta[name="robots"]'), 'and is not offered for indexing').toContain('noindex')
  })

  it('names a public event, and never a members-only one', async () => {
    const { shut } = await pair('event', 'Torrey Pines Sunrise 10K')

    expect(shut.html, 'a members-only event appears nowhere in the served HTML').not.toContain('Cove Night Owls Time Trial')
    expect(meta(shut.document, 'meta[name="robots"]'), 'and it is not offered for indexing').toContain('noindex')
  })

  it('names an athlete, whose name is already public', async () => {
    // The one page in the set with nothing to withhold: `user_privacy_settings`
    // governs activity defaults, home-location masking and territory precision,
    // not whether a profile exists, and a name already appears in leaderboards
    // and event standings. Only the name is rendered — stats and location are
    // not, because those are governed by per-activity visibility the server
    // cannot resolve for an anonymous reader.
    const { document } = await serve('/athlete/1')

    expect(document.title, 'an athlete is named in their title').toContain('Dana Fixture')
    expect(meta(document, 'meta[property="og:type"]'), 'a profile says so').toBe('profile')
  })

  it('names a public record attempt, and never a rejected one', async () => {
    // An effort has no name of its own — the route it was run on is what
    // identifies it, so the trail name is what must appear for one and not the
    // other. The withheld one is 'rejected', which `PUBLIC_STATUSES` excludes.
    const { shut } = await pair('effort', 'Torrey Pines Loop')

    expect(shut.document.title, 'a rejected attempt falls back to the generic title')
      .toBe('Record Attempt - Wildloop')
    expect(shut.html, 'a rejected attempt names no route in the served HTML').not.toContain('Torrey Pines Loop')
    expect(meta(shut.document, 'meta[name="robots"]'), 'and is not offered for indexing').toContain('noindex')
  })

  it('names a territory and resolves its holder', async () => {
    // No visibility to withhold: the game's map, leaderboard and battle reads
    // are all public. What this guards is the resolution — the row carries
    // `user_id` and not a name, so a server block that skipped the lookup would
    // describe every held territory as unclaimed.
    const { document } = await serve('/territory/1')

    expect(document.title, 'a territory is named in its title').toContain('Torrey Pines Bluff Territory')
    expect(meta(document, 'meta[name="description"]'), 'its holder is resolved to a name')
      .toContain('Held by Dana Fixture')
    expect(meta(document, 'meta[name="description"]'), 'a held territory is never described as unclaimed')
      .not.toContain('Unclaimed')
  })

  it('does not ask a crawler to index a record that does not exist', async () => {
    // The same failure the trail page had, on each of the new routes: without
    // this, every bad id a crawler tries is indexed as a generic page competing
    // with the real ones.
    for (const route of [
      '/club/999999999',
      '/activity/999999999',
      '/event/999999999',
      '/athlete/999999999',
      '/effort/999999999',
      '/territory/999999999',
    ]) {
      const { document } = await serve(route)
      expect(
        meta(document, 'meta[name="robots"]'),
        `${route} must be noindex`,
      ).toContain('noindex')
    }
  })
})
