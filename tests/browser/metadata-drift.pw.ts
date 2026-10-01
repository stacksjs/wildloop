import { expect, test } from '@playwright/test'

/**
 * The served metadata and the metadata the page sets for itself, compared.
 *
 * Every detail page says who it is twice: once in a `<script server>` block, for
 * the readers that run no JavaScript, and once in a client effect, for the
 * viewer. Those are two separate pieces of code that have to agree, and for a
 * long time they did not — a shared link previewed as "Trail Run on Emerald Lake
 * Trail — Wildloop" and opened saying the athlete's note instead. Aligning them
 * fixed today's drift; nothing stopped tomorrow's, because every suite checks the
 * served half in isolation and passes however far the two have moved apart.
 *
 * So this reads both halves of the same page and compares them. The served half
 * comes from a separate request rather than from the document before hydration,
 * which is a race: a capture taken a moment too early reads the layout's default
 * title and reports a drift that is not there. That mistake is why this test
 * exists in this shape.
 */

const origin = 'http://127.0.0.1:4322'
const API = 'http://127.0.0.1:4321/api'

interface Meta {
  title: string
  description: string
}

/** The metadata in the HTML as served, with no script having run. */
async function served(request: any, path: string): Promise<Meta> {
  const response = await request.get(`${origin}${path}`, { headers: { accept: 'text/html' } })
  expect(response.status(), `GET ${path}`).toBe(200)
  const html = await response.text()
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? ''
  const description = /<meta name="description" content="([\s\S]*?)"/.exec(html)?.[1] ?? ''

  return { title: decode(title), description: decode(description) }
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .trim()
}

/**
 * The metadata once the page has settled.
 *
 * Settling is detected by reading twice and waiting for the two to agree, rather
 * than by a fixed pause. When the two halves are aligned the title does not
 * change at hydration, so the title cannot be the signal that hydration
 * happened — which is the trap in writing this test.
 */
async function hydrated(page: any): Promise<Meta> {
  const read = async (): Promise<Meta> => ({
    title: await page.title(),
    description: await page.locator('meta[name="description"]').getAttribute('content') ?? '',
  })

  await page.waitForLoadState('networkidle')
  let previous = await read()
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.waitForTimeout(250)
    const current = await read()
    if (current.title === previous.title && current.description === previous.description)
      return current
    previous = current
  }

  return previous
}

test('the served metadata is the metadata each page sets for itself', async ({ page, request }) => {
  const trailId = await request.get(`${API}/trails?limit=1&sort=featured`)
    .then(r => r.json())
    .then((payload: any) => Number(payload?.trails?.[0]?.id ?? 0))
  expect(trailId, 'a trail id to test the dynamic route with').toBeGreaterThan(0)

  // The public fixture of each kind. A withheld record is not interesting here:
  // both halves fall back to the generic shell, so they agree trivially.
  const routes = [
    `/trail/${trailId}`,
    '/club/1',
    '/activity/1',
    '/event/1',
    '/territory/1',
    '/effort/1',
  ]

  for (const route of routes) {
    const before = await served(request, route)
    await page.goto(`${origin}${route}`)
    const after = await hydrated(page)

    expect(before.title, `${route} served a title`).not.toBe('')
    expect(after.title, `${route} title: served vs set by the page`).toBe(before.title)
    expect(after.description, `${route} description: served vs set by the page`).toBe(before.description)
  }
})

test('an athlete page agrees on its title, and may say more once it knows the viewer', async ({ page, request }) => {
  /*
   * The one page where the two halves are meant to differ, and the reason is
   * privacy rather than oversight.
   *
   * The client's description states counts, and `activityCount` is filtered
   * through `canViewActivity` against whoever is asking — so the number a
   * follower sees is not the number a stranger may be told. A served render has
   * no viewer and would have to publish the stranger's figure as if it were the
   * whole truth, so it states no counts at all and the client adds them once it
   * knows who is asking.
   *
   * What must still hold: the title is the same, and both descriptions open by
   * naming the same athlete. A served description that named a different person,
   * or that had started quoting counts, would fail this.
   */
  const before = await served(request, '/athlete/1')
  await page.goto(`${origin}/athlete/1`)
  const after = await hydrated(page)

  expect(after.title, 'athlete title: served vs set by the page').toBe(before.title)

  const athlete = before.title.replace(/ \| Wildloop$/, '')
  expect(athlete, 'the served title names the athlete').not.toBe('')
  expect(before.description, 'the served description opens by naming the athlete').toContain(`${athlete} on Wildloop`)
  expect(after.description, 'and so does the one the page sets').toContain(`${athlete} on Wildloop`)
  expect(before.description, 'the served description states no counts').not.toMatch(/\d+ (activit|follower|territor)/)
})
