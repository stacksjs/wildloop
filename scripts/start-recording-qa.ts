/** Dedicated local/CI database. Never starts against the developer's database. */
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGazetteerFile } from 'ts-maps/gazetteer'

const directory = await mkdtemp(join(tmpdir(), 'wildloop-browser-qa-'))

// Place search from a five-town GeoNames extract, so the planning tests
// search real data without CI downloading the 60 MB dump.
const gazetteer = join(directory, 'gazetteer.sqlite')
buildGazetteerFile(gazetteer, { cities: await readFile('tests/browser/fixtures/geonames-sample.txt', 'utf8') })
const env = {
  ...process.env,
  APP_ENV: 'local',
  APP_URL: 'http://127.0.0.1:4320',
  PORT: '4320',
  PORT_API: '4321',
  PORT_BACKEND: '4321',
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
db.close()
const server = Bun.spawn(['./buddy', 'dev'], { env, stdout: 'inherit', stderr: 'inherit' })
// Exercise the dashboard's independent route runtime too (stacksjs/stacks#2789).
// localhost avoids the dashboard's custom-domain certificate/proxy setup.
const dashboard = Bun.spawn(['bun', '--no-env-file', 'node_modules/@stacksjs/actions/dist/dev/dashboard.js'], {
  env: { ...env, APP_URL: 'localhost:4320', PORT_ADMIN: '4332', STACKS_DEV_SERVER: '1' },
  stdout: 'inherit',
  stderr: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.kill(signal)
    dashboard.kill(signal)
  })
const exitCode = await Promise.race([server.exited, dashboard.exited])
server.kill()
dashboard.kill()
process.exit(exitCode)
