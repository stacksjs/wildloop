/**
 * Runs ON the build server: writes the build's state to the bucket, where the
 * hourly check job reads it back through https://tiles.wildloop.org.
 *
 * _builds/<version>/status.json holds { state, version, line, tail, machine,
 * updatedAt }. `tail` is the last sixty lines of the build log and `machine`
 * is disk, memory and load, so a build that dies can be diagnosed after its
 * server is gone. Nothing secret: planetiler's progress and this pipeline's
 * own `==>` steps.
 *
 * Writes nothing to local disk. The first planet build went silent when its
 * disk filled: the status file could not be written, and with it every report
 * after. This only reads.
 *
 * Usage: bun report.ts RUNNING|DONE|FAILED|auto
 *   auto  the heartbeat's mode: DONE or FAILED if the build said so, FAILED if
 *         its process is gone without saying anything, RUNNING otherwise.
 */
import { S3Client } from 'bun'

const DIR = '/root/tiles'
const version = process.env.VERSION ?? 'unknown'
const workdir = process.env.WORKDIR ?? DIR

async function read(path: string): Promise<string> {
  try {
    return await Bun.file(path).text()
  }
  catch {
    return ''
  }
}

function run(command: string[]): string {
  try {
    return Bun.spawnSync(command).stdout.toString().trim()
  }
  catch {
    return ''
  }
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n')

let state = process.argv[2] ?? 'auto'
if (state === 'auto') {
  const said = (await read(`${DIR}/STATUS`)).trim()
  const pid = Number((await read(`${DIR}/build.pid`)).trim())
  const alive = Number.isFinite(pid) && pid > 0 && Bun.spawnSync(['kill', '-0', String(pid)]).exitCode === 0
  state = said === 'DONE' || said === 'FAILED' ? said : alive ? 'RUNNING' : 'FAILED'
}

const lines = stripAnsi(await read(`${DIR}/build.log`)).split('\n').map(line => line.trimEnd()).filter(Boolean)
const tail = lines.slice(-60)

const status = {
  state,
  version,
  line: tail.at(-1)?.slice(0, 300) ?? '',
  tail,
  machine: {
    disk: run(['df', '-h', workdir, '/']),
    memory: run(['free', '-g']),
    load: run(['cat', '/proc/loadavg']),
  },
  updatedAt: new Date().toISOString(),
}

const s3 = new S3Client({
  endpoint: process.env.R2_ENDPOINT,
  region: 'auto',
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
})

await s3.file(`_builds/${version}/status.json`).write(JSON.stringify(status), { type: 'application/json' })
