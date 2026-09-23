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
  GAZETTEER_PATH: gazetteer,
}
const migrate = Bun.spawn(['./buddy', 'migrate', '--no-generate'], { env, stdout: 'inherit', stderr: 'inherit' })
if (await migrate.exited !== 0) throw new Error('Isolated recording database migration failed')

// One trail to plan a visit to — Torrey Pines, near the San Diego the
// gazetteer knows about.
const db = new Database(env.DB_DATABASE_PATH)
db.run(`INSERT INTO trails (name, location, state, country, distance, elevation, difficulty, latitude, longitude)
  VALUES ('Torrey Pines Loop', 'San Diego, CA', 'CA', 'US', 2.4, 300, 'easy', 32.9209, -117.2528)`)
db.close()
const server = Bun.spawn(['./buddy', 'dev'], { env, stdout: 'inherit', stderr: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.kill(signal))
process.exit(await server.exited)
