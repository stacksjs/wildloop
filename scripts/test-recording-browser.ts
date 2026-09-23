/** Local-only, isolated-origin browser tests. No production accounts or data. */
import process from 'node:process'

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.RECORDING_TEST_PORT || 4319),
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === '/api/activities' && request.method === 'POST') {
      // Fault injection at the HTTP boundary, never a fake storage engine.
      const payload = await request.json() as { upload_id?: string }
      const status = payload.upload_id?.endsWith(':401') ? 401 : 422
      return Response.json({ error: status === 401 ? 'Unauthenticated' : 'Validation failed' }, { status })
    }
    if (pathname === '/tests.js') {
      const result = await Bun.build({
        entrypoints: ['./tests/browser/recording-storage.ts'],
        target: 'browser',
      })
      if (!result.success) return new Response(String(result.logs), { status: 500 })
      return new Response(result.outputs[0], { headers: { 'Content-Type': 'text/javascript' } })
    }
    if (pathname !== '/') return new Response('Not found', { status: 404 })
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Recording storage regression</title><h1>Recording storage regression</h1><p>Local test data only. Tests use this origin\'s real IndexedDB.</p><button>Run storage tests</button><pre>Ready</pre><script type="module" src="/tests.js"></script></html>', {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
    })
  },
})
console.log(`Recording regression browser: ${server.url}`)
