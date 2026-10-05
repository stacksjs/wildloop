/**
 * Verification harness for rate limiting (#980).
 *
 * The Throttle middleware runs in the HTTP router layer (in-process action
 * harnesses bypass it), so this suite calls the app's Throttle middleware
 * directly with synthetic requests - checking that a signed-in request spends
 * its user's budget and an anonymous one its client's, which a forged
 * X-Forwarded-For or CF-Connecting-IP cannot change - then statically asserts
 * the route tiers in routes/api.ts are wired the way the documentation block
 * says they are.
 *
 * Run:  bun scripts/verify-rate-limit.ts   (no seed required)
 */
/* eslint-disable ts/no-top-level-await */
import { readFileSync } from 'node:fs'
import process from 'node:process'

process.on('unhandledRejection', (err) => { console.error('UNHANDLED', err); process.exit(1) })

const { parseThrottleString } = await import('@stacksjs/router')

let failures = 0
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

// --- Part 1: throttle pattern parsing ----------------------------------------------

const game = parseThrottleString('30,1')
const sweep = parseThrottleString('10,1')
const social = parseThrottleString('60,1')
check('parses the three documented tiers', game.maxAttempts === 30 && game.windowMs === 60000
  && sweep.maxAttempts === 10 && sweep.windowMs === 60000
  && social.maxAttempts === 60 && social.windowMs === 60000)
const seconds = parseThrottleString('10,30s')
const hours = parseThrottleString('1000,1h')
check('parses seconds/hours windows', seconds.maxAttempts === 10 && seconds.windowMs === 30000
  && hours.maxAttempts === 1000 && hours.windowMs === 3600000)

// --- Part 2: enforcement, through the app's own Throttle middleware -----------------
//
// The same module the API resolves for `throttle:N,M` (the vendored defaults
// tree), driven with synthetic requests. Each scenario uses its own pattern,
// because limiters are registered process-wide by pattern.

const { default: Throttle } = await import('../storage/framework/defaults/app/Middleware/Throttle')

interface FakeRequest {
  headers: Headers
  url: string
  method: string
  _middlewareParams: { throttle: string }
  _authenticatedUser?: { id: number }
  _responseHeaders?: Record<string, string>
}

function fakeReq(pattern: string, headers: Record<string, string>, userId?: number): FakeRequest {
  return {
    headers: new Headers(headers),
    url: 'http://localhost/api/activities',
    method: 'POST',
    _middlewareParams: { throttle: pattern },
    ...(userId === undefined ? {} : { _authenticatedUser: { id: userId } }),
  }
}

/** The status Throttle answers with: 200 when it lets the request through. */
async function hit(req: FakeRequest): Promise<number> {
  try {
    await Throttle.handle(req as any)
    return 200
  }
  catch (thrown) {
    if (thrown instanceof Response)
      return thrown.status
    throw thrown
  }
}

async function statuses(make: (i: number) => FakeRequest, count: number): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < count; i++)
    out.push(await hit(make(i)))
  return out
}

// Every QA user is on 127.0.0.1, as are an office's or a carrier NAT's users.
const sameAddress = { 'x-forwarded-for': '203.0.113.20' }

const userOne = await statuses(() => fakeReq('3,1', sameAddress, 1), 5)
check('requests within the limit pass, the one over it is a 429, and it stays blocked', JSON.stringify(userOne) === JSON.stringify([200, 200, 200, 429, 429]), userOne.join(','))
check('another signed-in user on the same address has a budget of their own', await hit(fakeReq('3,1', sameAddress, 2)) === 200)

const firstOk = fakeReq('3,1', sameAddress, 3)
await hit(firstOk)
check('a request that gets through is told its remaining budget', firstOk._responseHeaders?.['X-RateLimit-Remaining'] === '2'
  && firstOk._responseHeaders?.['X-RateLimit-Limit'] === '3', JSON.stringify(firstOk._responseHeaders ?? {}))

let blocked: Response | undefined
try {
  await Throttle.handle(fakeReq('3,1', sameAddress, 1) as any)
}
catch (thrown) {
  blocked = thrown instanceof Response ? thrown : undefined
}
check('429 carries Retry-After + X-RateLimit headers', blocked !== undefined
  && Number(blocked.headers.get('Retry-After')) > 0
  && blocked.headers.get('X-RateLimit-Remaining') === '0', blocked?.headers.get('Retry-After') ?? 'no response')

const spoofed = await statuses(i => fakeReq('3,2', { 'x-forwarded-for': `198.18.0.${i}, 203.0.113.30` }), 4)
check('an anonymous client cannot buy a fresh budget by prefixing X-Forwarded-For', JSON.stringify(spoofed) === JSON.stringify([200, 200, 200, 429]), spoofed.join(','))
check('a different anonymous client is unaffected', await hit(fakeReq('3,2', { 'x-forwarded-for': '203.0.113.31' })) === 200)

// Production: rpx writes the Cloudflare edge it accepted the connection from
// into X-Forwarded-For; Cloudflare states the visitor in CF-Connecting-IP.
const edge = '172.70.1.9'
const viaCloudflare = await statuses(() => fakeReq('3,3', { 'x-forwarded-for': edge, 'cf-connecting-ip': '203.0.113.40' }), 4)
check('a visitor through Cloudflare is limited on their own address', JSON.stringify(viaCloudflare) === JSON.stringify([200, 200, 200, 429]), viaCloudflare.join(','))
check('another visitor through the same Cloudflare edge is unaffected', await hit(fakeReq('3,3', { 'x-forwarded-for': edge, 'cf-connecting-ip': '203.0.113.41' })) === 200)
const direct = await statuses(i => fakeReq('3,4', { 'x-forwarded-for': '203.0.113.50', 'cf-connecting-ip': `198.18.1.${i}` }), 4)
check('CF-Connecting-IP from a client that skipped Cloudflare is ignored', JSON.stringify(direct) === JSON.stringify([200, 200, 200, 429]), direct.join(','))

// --- Part 3: route wiring is what the docs say -----------------------------------------

const routes = readFileSync('routes/api.ts', 'utf-8')
function tierBody(tier: string): string {
  const start = routes.indexOf(`route.group({ middleware: 'throttle:${tier}' }, () => {`)
  if (start === -1)
    return ''
  const end = routes.indexOf('})', start)
  return routes.slice(start, end)
}

const gameTier = tierBody('30,1')
check('claim + conquest sit in the 30/min game tier', gameTier.includes('/territories/claim')
  && gameTier.includes('/territories/process-conquest'))
const sweepTier = tierBody('10,1')
check('all four sweeps sit in the 10/min tier', ['/territories/recompute-ranks', '/territories/decay-sweep', '/maintenance/recompute-counters', '/achievements/evaluate']
  .every(p => sweepTier.includes(p)))
const socialTier = tierBody('60,1')
check('interactive writes sit in the 60/min tier', ['/activities', '/kudos', '/comments', '/reviews', '/follow', '/notifications/read']
  .every(p => socialTier.includes(p)))
const authGroupStart = routes.indexOf('route.group({ middleware: \'auth\' }')
check('throttle tiers nest inside the auth group', authGroupStart !== -1
  && authGroupStart < routes.indexOf('throttle:30,1')
  && routes.indexOf('/territories/claim\'', authGroupStart) > authGroupStart)

console.log(failures === 0 ? '\n✅ all rate-limit checks passed' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
