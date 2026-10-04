/**
 * The territory game, end to end, against the isolated QA app only.
 *
 * Two fresh accounts play one round in Los Angeles through the same endpoints
 * the recorder calls: a claim, a refused overlapping claim, a run that cuts
 * the claim in two, an attack that only contests, and the owner's defence.
 * Then every read the game screens make is checked against what happened: the
 * map (and that it answers for the area asked about, not the whole world),
 * the leaderboard, the battle feed and the defender's notifications.
 *
 * Run `bun scripts/start-recording-qa.ts` first (temporary SQLite database).
 * Never point this at a real server: it registers accounts and writes runs.
 */
import { strict as assert } from 'node:assert'
import { QA_PORTS } from '../tests/browser/qa-ports'

const base = process.env.QA_API ?? `http://127.0.0.1:${QA_PORTS.api}/api`
assert(/^http:\/\/(?:127\.0\.0\.1|localhost)[:/]/.test(base), 'The game QA only runs against a local QA server')

const bootstrap = await fetch(`${base}/activities`)
const cookies = bootstrap.headers.getSetCookie().map(cookie => cookie.split(';')[0])
const csrfCookie = cookies.find(cookie => cookie.startsWith('X-CSRF-Token='))
assert(csrfCookie, 'QA server did not provide the CSRF cookie')
const headers = {
  'Content-Type': 'application/json',
  'Origin': `http://127.0.0.1:${QA_PORTS.app}`,
  'Cookie': cookies.join('; '),
  'X-CSRF-Token': decodeURIComponent(csrfCookie.slice('X-CSRF-Token='.length)),
}

async function call(path: string, method = 'GET', body?: unknown, token?: string): Promise<{ status: number, body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function account(name: string) {
  const email = `game-qa-${crypto.randomUUID()}@example.test`
  // Test-only credentials for a throwaway QA database.
  const password = `Local-QA-${crypto.randomUUID()}`
  const registered = await call('/register', 'POST', { name, email, password })
  assert(registered.status < 300, `Registration returned ${registered.status}`)
  const login = await call('/login', 'POST', { email, password })
  assert.equal(login.status, 200, 'Fresh account login')
  return { id: Number(registered.body.user.id), name, token: String(login.body.token) }
}

interface Point { lat: number, lng: number }

const METRES_PER_DEG_LAT = 111_320
function offset(origin: Point, northMetres: number, eastMetres: number): Point {
  return {
    lat: origin.lat + northMetres / METRES_PER_DEG_LAT,
    lng: origin.lng + eastMetres / (METRES_PER_DEG_LAT * Math.cos(origin.lat * Math.PI / 180)),
  }
}

function metresBetween(a: Point, b: Point): number {
  const dLat = (b.lat - a.lat) * METRES_PER_DEG_LAT
  const dLng = (b.lng - a.lng) * METRES_PER_DEG_LAT * Math.cos(a.lat * Math.PI / 180)
  return Math.hypot(dLat, dLng)
}

/**
 * A recording the way a phone produces one: fixes a few seconds apart at an
 * irregular interval, a pace that wanders, an accuracy that moves, and an
 * altitude in metres with a little noise.
 */
function recording(path: Point[], endMs: number, metresPerSecond = 2.6): string {
  // Resample the path every ~8 m, so the recording follows its shape.
  const points: Point[] = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1]
    const to = path[i]
    const steps = Math.max(1, Math.round(metresBetween(from, to) / 8))
    for (let s = 1; s <= steps; s++)
      points.push({ lat: from.lat + (to.lat - from.lat) * s / steps, lng: from.lng + (to.lng - from.lng) * s / steps })
  }
  const times: number[] = [0]
  for (let i = 1; i < points.length; i++) {
    const speed = metresPerSecond * (0.85 + 0.3 * Math.abs(Math.sin(i * 1.7)))
    times.push(times[i - 1] + Math.max(1000, Math.round(metresBetween(points[i - 1], points[i]) / speed * 1000)))
  }
  const startMs = endMs - times[times.length - 1]
  return JSON.stringify({
    type: 'LineString',
    coordinates: points.map(point => [Number(point.lng.toFixed(7)), Number(point.lat.toFixed(7))]),
    properties: {
      samples: points.map((_, index) => ({
        time: startMs + times[index],
        accuracy: 4 + ((index * 7) % 9),
        altitude: 80 + Math.sin(index / 6) * 3 + ((index * 13) % 5) * 0.3,
      })),
    },
  })
}

function circle(center: Point, radius: number, points = 48): Point[] {
  const ring: Point[] = []
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * 2 * Math.PI
    ring.push(offset(center, radius * Math.sin(angle), radius * Math.cos(angle)))
  }
  return ring
}

async function save(user: { token: string }, path: Point[], endMs: number, label: string) {
  const saved = await call('/activities', 'POST', {
    activity_type: 'Trail Run',
    distance: 1,
    duration: '10:00',
    visibility: 'public',
    game_mode: 'capture',
    recording_source: 'web_gps',
    completed_at: new Date(endMs).toISOString(),
    upload_id: `game-qa:${crypto.randomUUID()}`,
    gpx_data: recording(path, endMs),
  }, user.token)
  assert.equal(saved.status, 201, `${label}: save returned ${saved.status} ${JSON.stringify(saved.body)}`)
  assert.equal(saved.body.activity.captureEligible, true, `${label}: capture refused: ${saved.body.activity.integrityReason}`)
  return Number(saved.body.activity.id)
}

const claim = (user: { token: string }, activityId: number) =>
  call('/territories/claim', 'POST', { activity_id: activityId }, user.token)
const battle = (user: { token: string }, activityId: number) =>
  call('/territories/process-conquest', 'POST', { activity_id: activityId }, user.token)

function bbox(center: Point, metres: number): string {
  const sw = offset(center, -metres, -metres)
  const ne = offset(center, metres, metres)
  return `min_lat=${sw.lat}&min_lng=${sw.lng}&max_lat=${ne.lat}&max_lng=${ne.lng}`
}

const passed: string[] = []
function pass(message: string) {
  passed.push(message)
  console.log(`  ok  ${message}`)
}

// Somewhere in Los Angeles nobody else in the QA database plays, so the round
// is the only thing on this part of the map. Each run gets its own centre.
const center = offset({ lat: 34.0522, lng: -118.2437 }, Math.round(Math.random() * 20_000), Math.round(Math.random() * 20_000))
const now = Date.now()
const hour = 3_600_000

const alice = await account('Alice Loop')
const bob = await account('Bob Cutter')

// 1. Alice runs a 120 m loop: a new territory.
const loopRun = await save(alice, circle(center, 120), now - 5 * hour, 'Alice loop')
const claimed = await claim(alice, loopRun)
assert.equal(claimed.status, 200, `Claim returned ${claimed.status} ${JSON.stringify(claimed.body)}`)
assert(claimed.body.territory.areaSize > 40_000 && claimed.body.territory.areaSize < 50_000, `Unexpected area ${claimed.body.territory.areaSize}`)
const territoryId = Number(claimed.body.territory.id)
pass(`a closed loop claims ${Math.round(claimed.body.territory.areaSize)} m² (+${claimed.body.xpGained} XP)`)

const again = await claim(alice, loopRun)
assert.equal(again.body.alreadyProcessed, true, 'A repeated claim must be idempotent')
pass('claiming the same run twice is idempotent')

// The conquest pass over the claiming run only patrols the new land.
const ownPass = await battle(alice, loopRun)
assert.equal(ownPass.status, 200, `Own conquest pass returned ${ownPass.status}`)
assert.equal(ownPass.body.conqueredCount, 0)
pass('the claiming run does not battle its own territory')

// 2. A second, overlapping loop cannot claim on top of it.
const overlapRun = await save(alice, circle(offset(center, 60, 0), 120), now - 4.5 * hour, 'Alice overlap')
const overlap = await claim(alice, overlapRun)
assert.equal(overlap.status, 409, `Overlapping claim returned ${overlap.status}`)
pass(`an overlapping loop is refused: ${overlap.body.error}`)

// 3. Bob runs straight across it: the land is split.
const crossing = [offset(center, 0, -220), offset(center, 0, 220)]
const crossRun = await save(bob, crossing, now - 4 * hour, 'Bob crossing')
const notALoop = await claim(bob, crossRun)
assert.equal(notALoop.status, 400, 'A straight run cannot claim')
pass(`a straight run is not a claim: ${notALoop.body.error}`)
const split = await battle(bob, crossRun)
assert.equal(split.status, 200, `Conquest returned ${split.status} ${JSON.stringify(split.body)}`)
assert.equal(split.body.conqueredCount, 1, `Expected a split: ${JSON.stringify(split.body)}`)
const piece = split.body.territories[0]
assert(piece.newTerritoryId, 'A split hands the attacker a new territory')
assert(piece.remainingArea >= piece.conqueredArea, 'The defender keeps the larger part')
pass(`crossing the territory splits it: ${Math.round(piece.conqueredArea)} m² taken, ${Math.round(piece.remainingArea)} m² kept`)

const replay = await battle(bob, crossRun)
assert.equal(replay.body.conqueredCount, 0, 'A replayed conquest must not split twice')
pass('replaying the conquest does nothing')

// 4. The map answers for the area asked about.
const localMap = await call(`/territories/map?${bbox(center, 2_000)}&limit=500`)
const localIds = new Set(localMap.body.features.map((feature: any) => feature.properties.id))
assert(localIds.has(territoryId) && localIds.has(piece.newTerritoryId), 'Both halves are on the local map')
const kept = localMap.body.features.find((feature: any) => feature.properties.id === territoryId)
assert.equal(kept.properties.ownerId, alice.id)
const elsewhere = await call(`/territories/map?${bbox({ lat: 40.7128, lng: -74.006 }, 2_000)}&limit=500`)
const elsewhereIds = new Set(elsewhere.body.features.map((feature: any) => feature.properties.id))
assert(!elsewhereIds.has(territoryId), 'A map of New York must not answer with Los Angeles')
pass('the map returns the territories inside the requested bounds, and only those')

// 5. Bob runs into the part Alice kept and stops inside it: contested.
const keptCenter = { lat: kept.properties.centerLat, lng: kept.properties.centerLng }
const awayNorth = keptCenter.lat > center.lat ? 1 : -1
const contestRun = await save(bob, [offset(center, awayNorth * 400, 30), offset(center, awayNorth * 50, 30)], now - 3 * hour, 'Bob contest')
const contest = await battle(bob, contestRun)
assert.equal(contest.status, 200, `Contest returned ${contest.status} ${JSON.stringify(contest.body)}`)
assert.deepEqual(contest.body.contested.map((row: any) => row.id), [territoryId], `Expected a contest: ${JSON.stringify(contest.body)}`)
pass('running into territory without cutting it contests it')

// 6. Alice runs through her contested land: defended.
const defendRun = await save(alice, [offset(center, awayNorth * 380, -30), offset(center, awayNorth * 40, -30)], now - 2 * hour, 'Alice defence')
const defence = await battle(alice, defendRun)
assert.equal(defence.status, 200, `Defence returned ${defence.status}`)
assert.deepEqual(defence.body.defended.map((row: any) => row.id), [territoryId], `Expected a defence: ${JSON.stringify(defence.body)}`)
pass(`the owner running through contested land defends it (+${defence.body.xpGained} XP)`)

// 7. What the game screens read.
const feed = await call('/territories/battles?limit=200')
const events = feed.body.battles.filter((row: any) => row.territory_id === territoryId || row.territory_id === piece.newTerritoryId)
assert(events.some((row: any) => row.status === 'conquered' && row.attacker_id === bob.id && row.defender_id === alice.id), 'The feed shows Bob taking land from Alice')
assert(events.some((row: any) => row.status === 'defended' && row.defender_id === alice.id && row.attacker_id === bob.id), 'The feed shows Alice defending against Bob')
assert(events.every((row: any) => row.attacker_id !== row.defender_id), `Someone fought themselves on the feed: ${JSON.stringify(events)}`)
assert.equal(events.filter((row: any) => row.status === 'conquered').length, 1, `The split should be one battle: ${JSON.stringify(events)}`)
pass('the battle feed names the attacker and the defender of each event, once')

// A player's own feed is every battle they fought, not the newest in the game.
for (const player of [alice, bob]) {
  const own = await call('/territories/battles?mine=1&limit=1000', 'GET', undefined, player.token)
  assert.equal(own.status, 200, `Own battles returned ${own.status}`)
  const theirs = own.body.battles as any[]
  assert(theirs.some(row => row.status === 'conquered' && row.attacker_id === bob.id && row.defender_id === alice.id), `${player.id} is missing the split from their own feed`)
  assert(theirs.some(row => row.status === 'defended' && row.defender_id === alice.id), `${player.id} is missing the defence from their own feed`)
  assert(theirs.every(row => row.attacker_id === player.id || row.defender_id === player.id), `${player.id}'s own feed holds somebody else's battle: ${JSON.stringify(theirs)}`)
}
pass('each player\'s own feed holds every battle they fought, and only those')

const notes = await call('/notifications', 'GET', undefined, alice.token)
const bodies: string[] = (notes.body.notifications ?? []).map((row: any) => row.body)
assert(bodies.some(text => text.includes('conquered')), `Alice was not told about the split: ${JSON.stringify(bodies)}`)
assert(bodies.some(text => text.includes('attacking')), `Alice was not told about the attack: ${JSON.stringify(bodies)}`)
pass('the defender is notified of the conquest and of the attack')

const board = await call('/territories/leaderboard?type=area&limit=200')
const rows = board.body.leaderboard as any[]
const aliceRow = rows.find(row => row.userId === alice.id)
const bobRow = rows.find(row => row.userId === bob.id)
assert(aliceRow && bobRow, 'Both players are on the leaderboard')
assert.equal(aliceRow.totalTerritoriesOwned, 1)
assert.equal(bobRow.totalTerritoriesOwned, 1)
assert(Math.abs(aliceRow.totalAreaOwned - piece.remainingArea) < 1, 'Alice holds what she kept')
assert(Math.abs(bobRow.totalAreaOwned - piece.conqueredArea) < 1, 'Bob holds what he took')
assert(rows.every(row => row.userId && row.userName !== 'Unknown'), 'Nobody on the board is a deleted account')
pass('the leaderboard holds exactly what each player owns')

// 8. A territory's own page can fetch it directly, with the map's privacy.
const asStranger = await call(`/territories/${territoryId}`)
assert.equal(asStranger.status, 200, `Territory show returned ${asStranger.status}`)
assert.equal(asStranger.body.territory.properties.ownerId, alice.id)
assert.equal(asStranger.body.territory.properties.preciseGeometry, false, 'A stranger sees a coarse outline')
assert.equal(asStranger.body.territory.geometry.coordinates[0].length, 5, 'A coarse outline is the bounding box')
const asOwner = await call(`/territories/${territoryId}`, 'GET', undefined, alice.token)
assert.equal(asOwner.body.territory.properties.preciseGeometry, true, 'The owner sees the real outline')
assert.equal((await call('/territories/999999999')).status, 404)
pass('a territory page can load its territory directly, coarse for strangers')

// 9. Two laps of one loop claim the loop once.
const lapsCenter = offset(center, 0, 1_500)
const lapsRun = await save(alice, [...circle(lapsCenter, 120), ...circle(lapsCenter, 117).slice(1)], now - 1.5 * hour, 'Alice two laps')
const laps = await claim(alice, lapsRun)
assert.equal(laps.status, 200, `Two-lap claim returned ${laps.status} ${JSON.stringify(laps.body)}`)
assert(laps.body.territory.areaSize < 50_000, `Two laps claimed ${laps.body.territory.areaSize} m², the loop twice`)
pass(`two laps of a loop claim it once: ${Math.round(laps.body.territory.areaSize)} m²`)

// 10. A protected home zone keeps the game away from home.
const homeCenter = offset(center, 0, -1_500)
const privacy = await call('/privacy-settings', 'PATCH', {
  default_activity_visibility: 'public',
  hide_start_end_meters: 0,
  home_lat: homeCenter.lat,
  home_lng: homeCenter.lng,
  home_radius_meters: 300,
  exclude_home_from_game: true,
}, bob.token)
assert(privacy.status < 300, `Privacy update returned ${privacy.status} ${JSON.stringify(privacy.body)}`)
const homeRun = await save(bob, circle(offset(homeCenter, 0, 350), 150), now - hour, 'Bob near home')
const homeClaim = await claim(bob, homeRun)
assert.equal(homeClaim.status, 422, `A loop inside the home zone returned ${homeClaim.status}`)
assert.equal(homeClaim.body.code, 'privacy_zone')
pass('a loop reaching into a protected home zone draws no territory')

// Nor does winning land there: Alice holds a loop at the edge of Bob's home
// zone, and Bob's run across it only contests it.
const edgeCenter = offset(homeCenter, 0, 400)
const edgeRun = await save(alice, circle(edgeCenter, 120), now - 0.75 * hour, 'Alice by Bob\'s home')
const edgeClaim = await claim(alice, edgeRun)
assert.equal(edgeClaim.status, 200, `Alice's claim near Bob's home returned ${edgeClaim.status} ${JSON.stringify(edgeClaim.body)}`)
const homeCross = await save(bob, [offset(edgeCenter, 0, -250), offset(edgeCenter, 0, 250)], now - 0.5 * hour, 'Bob across from home')
const homeBattle = await battle(bob, homeCross)
assert.equal(homeBattle.status, 200)
assert.equal(homeBattle.body.conqueredCount, 0, `Land in Bob's home zone changed hands: ${JSON.stringify(homeBattle.body)}`)
assert.deepEqual(homeBattle.body.contested.map((row: any) => row.id), [edgeClaim.body.territory.id])
pass('an attack whose spoils would reach into the attacker\'s home zone only contests')

const nearBoard = await call(`/territories/leaderboard?type=area&${bbox(center, 2_000)}`)
assert.deepEqual(
  (nearBoard.body.leaderboard as any[]).map(row => row.userId).sort(),
  [alice.id, bob.id].sort(),
  `The local leaderboard should be exactly this round's players: ${JSON.stringify(nearBoard.body)}`,
)
pass('the leaderboard near this area ranks only the players who hold land in it')

console.log(`PASS: ${passed.length} territory game checks`)
