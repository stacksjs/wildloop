/** Dedicated local/CI database. Never starts against the developer's database. */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'wildloop-browser-qa-'))
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
}
const migrate = Bun.spawn(['./buddy', 'migrate', '--no-generate'], { env, stdout: 'inherit', stderr: 'inherit' })
if (await migrate.exited !== 0) throw new Error('Isolated recording database migration failed')
const server = Bun.spawn(['./buddy', 'dev'], { env, stdout: 'inherit', stderr: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.kill(signal))
process.exit(await server.exited)
