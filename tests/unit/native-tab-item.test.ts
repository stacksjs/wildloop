import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../resources/components/NativeTabItem.stx', import.meta.url), 'utf8')

/**
 * The file minus its comments. The comments quote the broken call on purpose,
 * to say what went wrong, and a naive search would find it there and pass or
 * fail for the wrong reason.
 */
const code = source
  .split('\n')
  .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
  .join('\n')

describe('native tab item', () => {
  it('reads the destination off the element, not from a prop the client scope cannot see', () => {
    // A component's client bundle is compiled into its own scope and does not
    // close over props declared in `<script>`. `navigate(href)` therefore threw
    // ReferenceError *after* preventDefault had cancelled the link, so on iOS
    // every tab tap did nothing: no navigation, and no error a user could see.
    expect(code).toContain('event.currentTarget')
    expect(code).toContain("getAttribute('href')")
    expect(code).not.toContain('navigate(href)')
  })

  it('lets the browser follow the link when the router is unavailable', () => {
    // preventDefault is only ever reached once there is somewhere to go and
    // something to go with. A tab that loads the document beats a dead tab.
    const handler = code.slice(code.indexOf('function followTab'))
    const guard = handler.indexOf("typeof navigate !== 'function'")
    const prevent = handler.indexOf('event.preventDefault()')

    expect(guard).toBeGreaterThan(-1)
    expect(prevent).toBeGreaterThan(guard)
  })

  it('still leaves the browser and Android on plain document navigation', () => {
    // Android's packaged fallback needs real document loads after a cold
    // start, and the web has no reason to intercept its own links.
    expect(code).toContain('if (!usesIosNativeRouting()) return')
    expect(code).toContain('href="{{ href }}"')
  })

  it('waits for the router instead of racing it with a page load', () => {
    // A 400ms timer called location.assign on any slow navigation. Two quick
    // taps on a slow server started two page loads, WebKit cancelled the
    // first, and Craft answers any cancelled load by switching the session to
    // its stale bundled copy of the site, which cannot reach the API.
    const handler = code.slice(code.indexOf('function followTab'))
    expect(handler).toContain('Promise.resolve(navigate(to))')
    expect(handler).toContain('if (settled)')
    expect(code).toContain('const ROUTER_STALL_MS = 8000')
    expect(code).not.toMatch(/\},\s*400\)/)
  })
})
