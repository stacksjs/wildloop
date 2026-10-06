#!/usr/bin/env bun
/**
 * Builds Wildloop's planet basemap on a server rented for the job, and
 * publishes it to R2 behind https://tiles.wildloop.org.
 *
 * The map is one PMTiles archive of the whole planet in the OpenMapTiles
 * schema, the schema ts-maps' styles are written against. Building one needs a
 * lot of memory, 500+ GB of fast disk and hours of many cores, which no CI
 * runner and none of our boxes has to spare. So this rents a Hetzner server,
 * builds there, uploads from there (a datacentre link, not a laptop's), and
 * deletes it.
 *
 * Two commands, because nothing should wait hours on a build:
 *
 *   launch  rent a server with a one-off SSH key, hand it remote-build.sh,
 *           report.ts, publish.ts and the R2 credentials over SSH (never in
 *           user data, which Hetzner keeps), start the build, and leave. The
 *           SSH key is deleted again before this returns.
 *   check   for every build server: read _builds/<version>/status.json from
 *           tiles.wildloop.org, which the server rewrites every five minutes,
 *           and delete the server once it is DONE, FAILED, silent for an hour,
 *           or a day old. Runs hourly; with no build in flight it is a no-op.
 *
 * `smoke` rehearses both on the smallest server, a cent and a few minutes:
 * rent, hand over, prove the server can write to R2, delete.
 *
 * Machines, in order of preference: a CCX53 (32 dedicated cores, 128 GB, two
 * to three hours), else a CPX62 (16 shared cores, 32 GB, 640 GB disk; several
 * times slower, but not subject to the project's dedicated-core limit).
 *
 * Credentials come from .env.production through buddy, like every other
 * Wildloop script: HCLOUD_TOKEN for the servers, and CLOUDFLARE_API_TOKEN +
 * CLOUDFLARE_ACCOUNT_ID, from which ts-cloud derives the R2 S3 keys.
 *
 * Run: bun scripts/tiles/build-planet.ts launch|check|smoke [--type=ccx53] [--location=fsn1]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { R2Provider, r2Endpoint, r2S3Credentials } from '@stacksjs/ts-cloud'

const ROOT = join(import.meta.dir, '../..')
const BUCKET = 'wildloop-tiles'
const PUBLIC_URL = 'https://tiles.wildloop.org'
const ROLE = 'tiles-build'
/** A build server older than this is deleted, whatever it says. */
const MAX_AGE_HOURS = 24
/** A server whose status has not moved in this long has stopped reporting. */
const SILENCE_MINUTES = 60

const [command = 'launch', ...rest] = process.argv.slice(2)
const args = new Map(rest.map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=')
  return [key!, value ?? 'true'] as const
}))
const locations = args.has('location') ? [args.get('location')!] : ['fsn1', 'nbg1', 'hel1']

function envValue(key: string): string {
  // `buddy env:get` decrypts with DOTENV_PRIVATE_KEY_PRODUCTION in CI and
  // .env.keys locally. The value is never printed.
  const result = Bun.spawnSync(['./buddy', 'env:get', key, '--file', '.env.production'], { cwd: ROOT })
  const value = result.stdout.toString().trim().split('\n').pop()?.trim() ?? ''
  if (!value || result.exitCode !== 0)
    throw new Error(`${key} is not available from .env.production`)
  return value
}

const hcloudToken = envValue('HCLOUD_TOKEN')

async function hetzner<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.hetzner.cloud/v1${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${hcloudToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : {}
  if (!response.ok)
    throw new Error(`Hetzner ${method} ${path}: ${response.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? text}`)
  return json as T
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function ssh(ip: string, keyPath: string, remote: string, input?: string): { code: number, out: string } {
  const result = Bun.spawnSync([
    'ssh',
    '-i',
    keyPath,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=15',
    `root@${ip}`,
    remote,
  ], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) })
  return { code: result.exitCode ?? 1, out: `${result.stdout.toString()}${result.stderr.toString()}` }
}

interface BuildServer {
  id: number
  name: string
  created: string
  status: string
  labels: Record<string, string>
}

async function buildServers(): Promise<BuildServer[]> {
  const { servers } = await hetzner<{ servers: BuildServer[] }>('GET', `/servers?label_selector=${encodeURIComponent(`wildloop-role=${ROLE}`)}`)
  return servers
}

interface BuildStatus {
  state: 'RUNNING' | 'DONE' | 'FAILED'
  version: string
  line: string
  updatedAt: string
}

async function readStatus(version: string): Promise<BuildStatus | null> {
  // Through the public domain rather than the S3 endpoint: a plain GET from
  // anywhere, and a query string so no cache answers for the server.
  const response = await fetch(`${PUBLIC_URL}/_builds/${version}/status.json?t=${Date.now()}`).catch(() => null)
  if (!response?.ok)
    return null
  return await response.json().catch(() => null) as BuildStatus | null
}

async function launch(smoke: boolean): Promise<string> {
  const version = smoke ? `smoke-${Date.now()}` : new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const apiToken = envValue('CLOUDFLARE_API_TOKEN')
  const accountId = envValue('CLOUDFLARE_ACCOUNT_ID')

  const inFlight = (await buildServers()).filter(server => server.labels['tiles-smoke'] !== 'true')
  if (!smoke && inFlight.length > 0)
    throw new Error(`a build is already running (${inFlight.map(server => server.name).join(', ')}); the hourly check will finish it`)

  // Before renting anything: the bucket deploy provisions must exist. A build
  // that only finds out at upload time has already paid for hours of a server.
  const bucket = await new R2Provider({ apiToken, accountId }).getBucket(BUCKET)
  if (!bucket)
    throw new Error(`R2 bucket ${BUCKET} does not exist yet. Deploy Wildloop (it is declared in config/cloud.ts) and run this again.`)
  const credentials = await r2S3Credentials({ apiToken, accountId })

  const types = args.has('type') ? [args.get('type')!] : smoke ? ['cx23'] : ['ccx53', 'cpx62']

  const keyDir = mkdtempSync(join(tmpdir(), 'tiles-build-'))
  const keyPath = join(keyDir, 'id_ed25519')
  Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `tiles-build-${version}`, '-f', keyPath])

  let sshKeyId: number | undefined
  let serverId: number | undefined
  let launched = false
  try {
    const key = await hetzner<{ ssh_key: { id: number } }>('POST', '/ssh_keys', {
      name: `tiles-build-${version}-${Date.now()}`,
      public_key: readFileSync(`${keyPath}.pub`, 'utf8').trim(),
      labels: { 'wildloop-role': ROLE },
    })
    sshKeyId = key.ssh_key.id

    let ip: string | undefined
    const refusals: string[] = []
    rent: for (const type of types) {
      for (const location of locations) {
        try {
          const created = await hetzner<{ server: { id: number, public_net: { ipv4: { ip: string } } } }>('POST', '/servers', {
            name: `tiles-build-${version}`,
            server_type: type,
            image: 'ubuntu-24.04',
            location,
            ssh_keys: [sshKeyId],
            labels: { 'wildloop-role': ROLE, 'tiles-version': version, ...(smoke ? { 'tiles-smoke': 'true' } : {}) },
            start_after_create: true,
          })
          serverId = created.server.id
          ip = created.server.public_net.ipv4.ip
          console.log(`rented ${type} in ${location} (${ip})`)
          break rent
        }
        catch (error) {
          refusals.push(`${type}@${location}: ${(error as Error).message.replace(/^Hetzner POST \/servers: /, '')}`)
        }
      }
    }
    if (!serverId || !ip)
      throw new Error(`could not rent a build server:\n  ${refusals.join('\n  ')}`)
    for (const refusal of refusals) console.log(`  (skipped ${refusal})`)

    // SSH answers a minute or so after the API says running.
    for (let attempt = 0; ; attempt++) {
      if (ssh(ip, keyPath, 'true').code === 0)
        break
      if (attempt > 40)
        throw new Error('the build server never answered SSH')
      await sleep(10_000)
    }

    const env = [
      `R2_ENDPOINT=${r2Endpoint(accountId)}`,
      `R2_ACCESS_KEY_ID=${credentials.accessKeyId}`,
      `R2_SECRET_ACCESS_KEY=${credentials.secretAccessKey}`,
      `R2_BUCKET=${BUCKET}`,
      `TILES_PUBLIC_URL=${PUBLIC_URL}`,
      `VERSION=${version}`,
      `SMOKE=${smoke ? '1' : ''}`,
    ].join('\n')
    ssh(ip, keyPath, 'mkdir -p /root/tiles && umask 077 && cat > /root/tiles/tiles.env', `${env}\n`)
    for (const file of ['remote-build.sh', 'report.ts', 'publish.ts'])
      ssh(ip, keyPath, `cat > /root/tiles/${file}`, readFileSync(join(import.meta.dir, file), 'utf8'))
    const started = ssh(ip, keyPath, 'cd /root/tiles && chmod +x remote-build.sh && nohup ./remote-build.sh > build.log 2>&1 < /dev/null & echo launched')
    if (!started.out.includes('launched'))
      throw new Error(`could not start the build: ${started.out}`)
    launched = true
    console.log(`build ${version} started; it reports to ${PUBLIC_URL}/_builds/${version}/status.json`)
    return version
  }
  finally {
    // The key only ever let us in to start the build. Gone either way.
    if (sshKeyId)
      await hetzner('DELETE', `/ssh_keys/${sshKeyId}`).catch(() => {})
    if (serverId && !launched)
      await hetzner('DELETE', `/servers/${serverId}`).then(() => console.log('build server deleted (launch failed)')).catch(() => {})
    rmSync(keyDir, { recursive: true, force: true })
  }
}

/** Returns false when a build ended in failure, so CI goes red. */
async function check(): Promise<boolean> {
  const servers = await buildServers()
  if (servers.length === 0) {
    console.log('no build in flight')
    return true
  }

  let ok = true
  for (const server of servers) {
    const version = server.labels['tiles-version'] ?? server.name.replace(/^tiles-build-/, '')
    const ageHours = (Date.now() - Date.parse(server.created)) / 3_600_000
    const status = await readStatus(version)
    const silentMinutes = status ? (Date.now() - Date.parse(status.updatedAt)) / 60_000 : Infinity
    console.log(`${server.name}: ${status?.state ?? 'no status yet'}, ${ageHours.toFixed(1)} h old${status?.line ? `\n  ${status.line}` : ''}`)

    let reason: string | null = null
    if (status?.state === 'DONE')
      reason = 'finished'
    else if (status?.state === 'FAILED')
      reason = 'failed'
    else if (ageHours > MAX_AGE_HOURS)
      reason = `older than ${MAX_AGE_HOURS} h`
    // A fresh server has not reported yet; give it the same hour of grace.
    else if (ageHours * 60 > SILENCE_MINUTES && silentMinutes > SILENCE_MINUTES)
      reason = `silent for ${Number.isFinite(silentMinutes) ? Math.round(silentMinutes) : '60+'} min`

    if (!reason)
      continue
    await hetzner('DELETE', `/servers/${server.id}`)
    console.log(`  deleted (${reason})`)
    if (reason !== 'finished')
      ok = false
    else if (!server.labels['tiles-smoke'])
      console.log(`  published ${PUBLIC_URL}/tiles.json → planet/${version}.pmtiles`)
  }
  return ok
}

if (command === 'launch') {
  await launch(false)
}
else if (command === 'check') {
  if (!await check())
    process.exit(1)
}
else if (command === 'smoke') {
  const version = await launch(true)
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(15_000)
    const status = await readStatus(version)
    if (status && status.state !== 'RUNNING')
      break
  }
  if (!await check())
    process.exit(1)
  console.log('smoke run passed: rented, handed over, wrote to R2, reported, deleted')
}
else {
  console.error('usage: bun scripts/tiles/build-planet.ts launch|check|smoke')
  process.exit(1)
}
