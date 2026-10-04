/** Dedicated local/CI database. Never starts against the developer's database. */
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGazetteerFile } from 'ts-maps/gazetteer'
import { QA_ADMIN } from '../tests/browser/qa-admin'
import { QA_PORTS } from '../tests/browser/qa-ports'
import { QA_SOCIAL_ACCOUNT } from '../tests/browser/qa-social-account'

const directory = await mkdtemp(join(tmpdir(), 'wildloop-browser-qa-'))

// Place search from a five-town GeoNames extract, so the planning tests
// search real data without CI downloading the 60 MB dump.
const gazetteer = join(directory, 'gazetteer.sqlite')
buildGazetteerFile(gazetteer, { cities: await readFile('tests/browser/fixtures/geonames-sample.txt', 'utf8') })
const env = {
  ...process.env,
  APP_ENV: 'local',
  APP_URL: `http://127.0.0.1:${QA_PORTS.app}`,
  PORT: String(QA_PORTS.app),
  PORT_API: String(QA_PORTS.api),
  PORT_BACKEND: String(QA_PORTS.api),
  PORT_DOCS: String(QA_PORTS.docs),
  STACKS_NO_NATIVE: '1',
  DB_CONNECTION: 'sqlite',
  DB_DATABASE_PATH: join(directory, 'qa.sqlite'),
  MAIL_MAILER: 'log',
  BUGHQ_ENABLED: 'false',
  GAZETTEER_PATH: gazetteer,
  // Uploaded photos and avatars land in this run's own folder, never in the
  // developer's storage/app/photos.
  PHOTOS_DISK: 'local',
  PHOTOS_LOCAL_ROOT: join(directory, 'photos'),
}
const migrate = Bun.spawn(['./buddy', 'migrate', '--no-generate'], { env, stdout: 'inherit', stderr: 'inherit' })
if (await migrate.exited !== 0) throw new Error('Isolated recording database migration failed')

// One trail to plan a visit to — Torrey Pines, near the San Diego the
// gazetteer knows about.
const db = new Database(env.DB_DATABASE_PATH)
db.run(`INSERT INTO trails (name, location, state, country, distance, elevation, difficulty, latitude, longitude)
  VALUES ('Torrey Pines Loop', 'San Diego, CA', 'CA', 'US', 2.4, 300, 'easy', 32.9209, -117.2528)`)
// Public NPS rows shown in the Santa Monica screenshot. Keep their source IDs
// and coordinates intact so the browser suite catches a namesake photo match.
const islandTrail = db.query(`INSERT INTO trails
  (name, location, state, country, distance, elevation, difficulty, latitude, longitude, source, source_id, image)
  VALUES (?, 'Channel Islands National Park, CA', 'CA', 'US', ?, 0, 'easy', ?, ?, 'nps', ?, ?)`)
for (const [name, distance, latitude, longitude, sourceId, image] of [
  ['Arch Point Loop Trail', 2.1, 33.48291, -119.033499, 'nps/CHIS|ARCH POINT LOOP TRAIL', 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=800&h=600&fit=crop'],
  ['Cave Canyon Nature Trail', 0.3, 33.479722, -119.029021, 'nps/CHIS|CAVE CANYON NATURE TRAIL', 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800&h=600&fit=crop'],
  ['Elephant Seal Cove Loop Trail', 2.8, 33.480336, -119.03819, 'nps/CHIS|ELEPHANT SEAL COVE LOOP TRAIL', 'https://images.unsplash.com/photo-1476231682828-37e571bc172f?w=800&h=600&fit=crop'],
  ['Signal Peak Loop', 2.9, 33.471806, -119.037228, 'nps/CHIS|SIGNAL PEAK LOOP', 'https://images.unsplash.com/photo-1476231682828-37e571bc172f?w=800&h=600&fit=crop'],
] as const)
  islandTrail.run(name, distance, latitude, longitude, sourceId, image)
// A trail of its own for the condition reports, so a warning raised by that
// suite cannot turn up in another one's catalog assertions.
db.run(`INSERT INTO trails (name, location, state, country, distance, elevation, difficulty, latitude, longitude)
  VALUES ('Condition Report Loop', 'Ojai, CA', 'CA', 'US', 3.1, 250, 'easy', 34.4480, -119.2429)`)
// More than one country, so the filter row offers the Country dropdown at
// all — it appears only past one — and so the regions inside a country are a
// real choice. A region outside the US is ISO 3166-2 (DE-BY), which the API
// used to ignore, quietly answering with the whole catalog.
const alpineTrail = db.query(`INSERT INTO trails
  (name, location, state, state_name, country, distance, elevation, difficulty, latitude, longitude)
  VALUES (?, ?, ?, ?, ?, ?, 400, 'moderate', ?, ?)`)
for (const [name, location, state, stateName, country, distance, latitude, longitude] of [
  ['Partnachklamm Loop', 'Garmisch-Partenkirchen, Bayern', 'DE-BY', 'Bayern', 'DE', 4.2, 47.4924, 11.1103],
  ['Isarwinkel Ridge', 'Bad Tölz, Bayern', 'DE-BY', 'Bayern', 'DE', 8.1, 47.7608, 11.5556],
  ['Eifel Forest Way', 'Monschau, Nordrhein-Westfalen', 'DE-NW', 'Nordrhein-Westfalen', 'DE', 11.4, 50.5556, 6.2447],
  ['Nordkette Panorama Trail', 'Innsbruck, Tirol', 'AT-7', 'Tirol', 'AT', 6.5, 47.3126, 11.3803],
] as const)
  alpineTrail.run(name, location, state, stateName, country, distance, latitude, longitude)
// Trails around one point, for ranking "near me". Boulder, so that nothing
// another suite searches near can reach them: the nearest other seed is more
// than 300 miles away, the widest a near-me search ever goes. Shaped like the
// catalog around Los Angeles: a destination, a scenic walk, pieces of one
// trail from two sources, a fire road at the end of the street, and a trail
// nobody should be sent down.
const nearbyTrail = db.query(`INSERT INTO trails
  (name, location, state, state_name, country, distance, elevation, difficulty, latitude, longitude, source, source_id)
  VALUES (?, ?, 'CO', 'Colorado', 'US', ?, 0, 'easy', ?, ?, ?, ?)`)
for (const [name, location, distance, latitude, longitude, source, sourceId] of [
  ['Royal Arch Trail', 'Chautauqua Park, CO', 3.4, 39.9890, -105.2830, 'nps', 'qa/royal-arch'],
  ['Royal Arch Trail', 'Colorado', 0.3, 39.9881, -105.2826, 'osm', 'qa/royal-arch-way'],
  ['Mesa Trail', 'Colorado', 6.7, 39.9600, -105.2700, 'osm', 'qa/mesa'],
  ['Flagstaff Road', 'Boulder Mountain Parks, CO', 2.2, 39.9998, -105.2801, 'osm', 'qa/flagstaff-road'],
  ['Proposed Gregory Spur', 'Colorado', 1.2, 39.9999, -105.2800, 'osm', 'qa/proposed'],
  ['Walker Ranch Loop', 'Boulder County Open Space, CO', 7.6, 39.9520, -105.3380, 'osm', 'qa/walker-ranch'],
] as const)
  nearbyTrail.run(name, location, distance, latitude, longitude, source, sourceId)
// Two trails nobody else looks at, for counting page views. Bend, Oregon, more
// than 600 miles from every other seed, so views here move no other suite's
// rankings. Alike in every way that ranking reads but distance: Tumalo is the
// closer, so it leads "most popular" until somebody looks at Shevlin.
const viewedTrail = db.query(`INSERT INTO trails
  (name, location, state, state_name, country, distance, elevation, difficulty, latitude, longitude, source, source_id)
  VALUES (?, 'Deschutes National Forest, OR', 'OR', 'Oregon', 'US', 3.2, 0, 'easy', ?, ?, 'osm', ?)`)
for (const [name, latitude, longitude, sourceId] of [
  ['Tumalo Creek Trail', 44.0650, -121.3100, 'qa/tumalo-creek'],
  ['Shevlin Creek Trail', 44.0950, -121.3600, 'qa/shevlin-creek'],
] as const)
  viewedTrail.run(name, latitude, longitude, sourceId)
// One trail drawn as three rows, the way OpenStreetMap delivers most of the
// catalog: the park's record and two short ways continuing it, sharing its
// name and its endpoints. Plus the same name in Maine, a different trail that
// must stay one. On the Blue Ridge Parkway near Asheville, more than 300 miles
// from every other seed, so no near-me search reaches in or out. The fold
// below records the two ways as pieces of the park's trail (#1002).
const pieceTrail = db.query(`INSERT INTO trails
  (name, location, state, state_name, country, distance, elevation, difficulty, latitude, longitude, geometry, source, source_id)
  VALUES ('Craggy Gardens Trail', ?, ?, ?, 'US', ?, 0, 'easy', ?, ?, ?, ?, ?)`)
for (const [location, state, stateName, distance, line, source, sourceId] of [
  ['Blue Ridge Parkway, NC', 'NC', 'North Carolina', 1.6, [[35.6990, -82.3800], [35.7100, -82.3800], [35.7220, -82.3800]], 'nps', 'qa/craggy-gardens'],
  ['North Carolina', 'NC', 'North Carolina', 0.3, [[35.7220, -82.3800], [35.7260, -82.3790]], 'osm', 'qa/craggy-gardens-way-north'],
  ['North Carolina', 'NC', 'North Carolina', 0.2, [[35.6960, -82.3805], [35.6990, -82.3800]], 'osm', 'qa/craggy-gardens-way-south'],
  ['Maine', 'ME', 'Maine', 0.5, [[44.3500, -68.2200], [44.3570, -68.2200]], 'osm', 'qa/craggy-gardens-maine'],
] as const)
  pieceTrail.run(location, state, stateName, distance, line[0][0], line[0][1], JSON.stringify(line), source, sourceId)
// One record of each kind the detail pages render, in a public and a withheld
// variant, so the suite can assert both halves of each page's server block:
// that a public record reaches the HTML, and that a private one does not.
//
// Without the private twin the gates would be untested — every seeded record
// would be public, every assertion would pass, and a gate that had stopped
// withholding would look exactly the same. These exist to be withheld.
db.run(`INSERT INTO users (name, email, password) VALUES ('Dana Fixture', 'dana@qa.invalid', 'x')`)
const qaUserId = Number((db.query(`SELECT id FROM users WHERE email = 'dana@qa.invalid'`).get() as any).id)

const qaClub = db.query(`INSERT INTO clubs (creator_id, name, club_type, description, location, is_private) VALUES (?, ?, 'Running', ?, 'San Diego, CA', ?)`)
qaClub.run(qaUserId, 'Torrey Pines Striders', 'Weekly tempo on the coast road, all paces welcome.', 0)
qaClub.run(qaUserId, 'Cove Night Owls', 'Invite-only dawn patrol.', 1)

// The notes are what distinguishes these two. An activity is titled by its
// note when it has one — the rule the page's own heading and metadata follow —
// so a pair without notes would title identically and no test could tell which
// one it was looking at.
// The public club gets its founder as a member, so its description states a
// real count and exercises the singular branch of "1 member" / "N members".
// Without this the fixture read "0 members", which is true of the row and true
// of nothing a reader would ever see.
db.run(`INSERT INTO club_members (club_id, user_id, role) VALUES ((SELECT id FROM clubs WHERE name = 'Torrey Pines Striders'), ${qaUserId}, 'owner')`)

const qaActivity = db.query(`INSERT INTO activities (user_id, trail_id, activity_type, distance, duration, visibility, notes) VALUES (?, (SELECT id FROM trails WHERE name = 'Torrey Pines Loop'), 'Trail Run', ?, '00:21:30', ?, ?)`)
qaActivity.run(qaUserId, 2.4, 'public', 'Sunrise loop, legs felt good.')
qaActivity.run(qaUserId, 2.6, 'private', 'Kept this one to myself.')

const qaEvent = db.query(`INSERT INTO events (host_id, name, start_time, description, location, visibility) VALUES (?, ?, '2030-06-01T07:00:00Z', ?, 'San Diego, CA', ?)`)
qaEvent.run(qaUserId, 'Torrey Pines Sunrise 10K', 'Two loops from the gliderport, chip timed.', 'public')
qaEvent.run(qaUserId, 'Cove Night Owls Time Trial', 'Members only.', 'club')
// A record attempt in a status a stranger may see, and one in the status that
// has to stay hidden. `PUBLIC_STATUSES` excludes 'rejected' because publishing
// "we did not believe this person" is a reputational act the site does not
// perform automatically — and an og:title would perform it in every link
// preview, so the pair exists to prove the effort page withholds it.
const qaEffort = db.query(`INSERT INTO route_efforts (trail_id, user_id, started_at, status, style, category, direction, elapsed_seconds) VALUES ((SELECT id FROM trails WHERE name = 'Torrey Pines Loop'), ?, '2030-05-01T13:00:00Z', ?, 'unsupported', 'mens', 'standard', ?)`)
qaEffort.run(qaUserId, 'verified', 1290)
qaEffort.run(qaUserId, 'rejected', 1180)

// A territory to name, with a holder to resolve. There is no visibility to
// withhold here — the game's map, leaderboard and battle reads are all public
// — so this one is a naming fixture only.
db.run(`INSERT INTO territories (name, user_id, polygon_data, center_lat, center_lng, area_size, status, claimed_at)
  VALUES ('Torrey Pines Bluff Territory', ${qaUserId}, '{"type":"Polygon","coordinates":[[[-117.2528,32.9209],[-117.2520,32.9209],[-117.2520,32.9215],[-117.2528,32.9215],[-117.2528,32.9209]]]}', 32.9212, -117.2524, 580000, 'active', '2030-05-01T13:00:00Z')`)
// An administrator, so the `role:admin` routes can be tested from the side
// that is let in as well as the side that is refused. No API grants the role,
// so it is written here; see tests/browser/qa-admin.ts.
db.run(`INSERT OR IGNORE INTO roles (name, guard_name, description) VALUES ('admin', 'web', 'QA administrator')`)
db.query(`INSERT INTO users (name, email, password) VALUES (?, ?, ?)`)
  .run(QA_ADMIN.name, QA_ADMIN.email, await Bun.password.hash(QA_ADMIN.password, { algorithm: 'bcrypt', cost: 4 }))
db.run(`INSERT INTO user_roles (user_id, role_id)
  SELECT (SELECT id FROM users WHERE email = '${QA_ADMIN.email}'), (SELECT id FROM roles WHERE name = 'admin' AND guard_name = 'web')`)
// An account a Google sign-in created, with no password of its own, so
// deleting one can be tested from a real server; see
// tests/browser/qa-social-account.ts.
const { id: socialUserId } = db.query(`INSERT INTO users (name, email, password) VALUES (?, ?, ?) RETURNING id`)
  .get(QA_SOCIAL_ACCOUNT.name, QA_SOCIAL_ACCOUNT.email, await Bun.password.hash(QA_SOCIAL_ACCOUNT.sessionSecret, { algorithm: 'bcrypt', cost: 4 })) as { id: number }
db.query(`INSERT INTO user_identities (user_id, provider, provider_user_id, email, created_account) VALUES (?, 'google', ?, ?, 1)`)
  .run(socialUserId, QA_SOCIAL_ACCOUNT.providerUserId, QA_SOCIAL_ACCOUNT.email)
// Photo candidates waiting for review (#1006), from a recorded-shape Commons
// geosearch rather than the network: tests/browser/fixtures holds the
// answer, and the same parsing and licence rules the nightly job uses write
// the rows. Two trails near Sedona, more than 300 miles from every other
// seed, with no cover of their own, so approving one visibly changes what the
// trail serves. The fixture carries a non-commercial file the queue must
// refuse and a tree it must not offer at all.
const photoTrail = db.query(`INSERT INTO trails
  (name, location, state, state_name, country, distance, elevation, difficulty, latitude, longitude, source, source_id)
  VALUES (?, 'Coconino National Forest, AZ', 'AZ', 'Arizona', 'US', ?, 0, 'moderate', ?, ?, 'osm', ?) RETURNING id`)
const { candidatesFrom } = await import('../app/Support/trailPhotoCandidates')
const { storeCandidates } = await import('../app/Support/trailPhotoQueue')
const commons = JSON.parse(await readFile('tests/browser/fixtures/commons-geosearch-sedona.json', 'utf8'))
const seedSql = async (strings: TemplateStringsArray, ...values: unknown[]) => db.query(strings.join('?')).all(...(values as any[])) as any[]
for (const [name, distance, latitude, longitude, sourceId, priority] of [
  ['Cathedral Rock Trail', 1.2, 34.8256, -111.7880, 'qa/cathedral-rock', 3],
  ['Devils Bridge Trail', 4.2, 34.8946, -111.8120, 'qa/devils-bridge', 2],
] as const) {
  const { id } = photoTrail.get(name, distance, latitude, longitude, sourceId) as { id: number }
  await storeCandidates(id, candidatesFrom(commons, name), priority, seedSql)
}
// Every trail above went in by plain INSERT, and the search index is
// external-content FTS5, which does not see writes to its table — production
// keeps it in step from the ingest (app/Ingest/ingest.ts). Without this every
// text search on the QA stack matched nothing.
db.run(`INSERT INTO trails_fts(trails_fts) VALUES ('rebuild')`)
db.close()
// Fold way fragments with the nightly command itself, so the suite sees what
// production would after a pass (tests/browser/trail-fragments.test.ts). Only
// the Craggy Gardens rows carry a line, so nothing else is touched. It writes
// trail_parts and the place suggestions, never the search index above.
const fold = Bun.spawn(['./buddy', 'trails:fold-fragments'], { env, stdout: 'inherit', stderr: 'inherit' })
if (await fold.exited !== 0) throw new Error('Folding the QA way fragments failed')
const server = Bun.spawn(['./buddy', 'dev'], { env, stdout: 'inherit', stderr: 'inherit' })
// Exercise the dashboard's independent route runtime too (stacksjs/stacks#2789).
// localhost avoids the dashboard's custom-domain certificate/proxy setup.
const dashboard = Bun.spawn(['bun', '--no-env-file', 'node_modules/@stacksjs/actions/dist/dev/dashboard.js'], {
  env: { ...env, APP_URL: `localhost:${QA_PORTS.app}`, PORT_ADMIN: String(QA_PORTS.dashboard), STACKS_DEV_SERVER: '1' },
  stdout: 'inherit',
  stderr: 'inherit',
})
/**
 * Every process under `pid`, deepest last.
 *
 * `buddy dev` starts the API watcher, the docs server and more as children of
 * its own. Signalling `buddy dev` alone left those running after every test
 * run, still holding the QA ports: the next run found them "already up",
 * reused servers with spent rate-limit budgets and stale code, and failed in
 * ways that had nothing to do with the tests. pgrep is on every Mac and Linux
 * box this runs on; CI also kills the whole process group itself.
 */
function descendants(pid: number): number[] {
  const children = Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString()
    .split('\n').map(Number).filter(child => Number.isInteger(child) && child > 0)
  return children.flatMap(child => [child, ...descendants(child)])
}

let stopping = false
function stopAll(signal: NodeJS.Signals = 'SIGTERM'): void {
  if (stopping)
    return
  stopping = true
  // Found before anything is signalled: once a parent goes, its children are
  // re-parented and can no longer be found under it.
  const tree = [...descendants(server.pid), ...descendants(dashboard.pid)]
  server.kill(signal)
  dashboard.kill(signal)
  for (const pid of tree) {
    try {
      process.kill(pid, signal)
    }
    catch {}
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stopAll(signal)
    process.exit(0)
  })
}
/*
 * Go when whatever started us goes.
 *
 * `bun test` starts this from tests/browser/qa-servers.ts and does not signal
 * it on the way out — its exit handlers do not run the way Node's do — so the
 * whole stack outlived every run. The parent is watched instead: once it is
 * gone, nothing is left to talk to these servers.
 */
const parent = process.ppid
const watchParent = setInterval(() => {
  try {
    process.kill(parent, 0)
  }
  catch {
    clearInterval(watchParent)
    stopAll()
    process.exit(0)
  }
}, 1000)

const exitCode = await Promise.race([server.exited, dashboard.exited])
clearInterval(watchParent)
stopAll()
process.exit(exitCode)
