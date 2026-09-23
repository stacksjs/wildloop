/** Local-only proxy for testing the real recorder with controlled GPS and outages. */
const upstream = 'http://127.0.0.1:4320'
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 4322,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/__qa/device.js') {
      const build = await Bun.build({ entrypoints: ['./tests/browser/recording-device.ts'], target: 'browser' })
      if (!build.success) return new Response(String(build.logs), { status: 500 })
      return new Response(build.outputs[0], { headers: { 'Content-Type': 'text/javascript' } })
    }
    const upstreamRequest = new Request(`${upstream}${url.pathname}${url.search}`, request)
    upstreamRequest.headers.set('accept-encoding', 'identity')
    const response = await fetch(upstreamRequest)
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    if (!response.headers.get('content-type')?.includes('text/html'))
      return new Response(response.body, { status: response.status, headers })
    headers.delete('content-security-policy')
    headers.set('cache-control', 'no-store')
    const html = await response.text()
    return new Response(html.replace('</body>', '<script type="module" src="/__qa/device.js"></script></body>'), { status: response.status, headers })
  },
})
console.log(`Local recording QA (synthetic GPS): ${server.url}`)
