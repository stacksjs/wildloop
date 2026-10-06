#!/usr/bin/env bun
/**
 * Builds Wildloop's planet basemap on a server rented for the job, and
 * publishes it to R2 behind https://tiles.wildloop.org.
 *
 * The map is one PMTiles archive of the whole planet in the OpenMapTiles
 * schema, the schema ts-maps' styles are written against. Building one needs
 * about 128 GB of memory, 300+ GB of fast disk and two to three hours of 32
 * cores, which no CI runner and none of our boxes has to spare. So this rents
 * a Hetzner CCX53 for the afternoon, builds there, uploads from there (a
 * datacentre link, not a laptop's), and deletes it.
 *
 *   1. delete any build server an earlier run left behind
 *   2. make a one-off SSH key, rent the server with it
 *   3. hand it remote-build.sh, publish.ts and the R2 credentials over SSH
 *      (never in user data, which Hetzner keeps)
 *   4. watch STATUS until DONE or FAILED
 *   5. delete the server and the key, whatever happened
 *
 * The server also schedules its own power-off after eight hours, so even a CI
 * runner that dies mid-build cannot leave one billing.
 *
 * Credentials come from .env.production through buddy, like every other
 * Wildloop script: HCLOUD_TOKEN for the server, and CLOUDFLARE_API_TOKEN +
 * CLOUDFLARE_ACCOUNT_ID, from which ts-cloud derives the R2 S3 keys.
 *
 * Run: bun scripts/tiles/build-planet.ts [--type=ccx53] [--location=fsn1] [--keep] [--smoke]
 *
 * `--smoke` rehearses everything but the build, on the smallest server: rent,
 * SSH, hand over the scripts and credentials, prove R2 is writable from the
 * datacentre, delete. A cent, and two minutes, before trusting it with hours.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { R2Provider, r2Endpoint, r2S3Credentials } from '@stacksjs/ts-cloud'

const ROOT = join(import.meta.dir, '../..')
const BUCKET = 'wildloop-tiles'
const PUBLIC_URL = 'https://tiles.wildloop.org'
const LABEL = 'wildloop-role=tiles-build'
const HOURS_LIMIT = 6.5

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=')
  return [key!, value ?? 'true'] as const
}))
const smoke = args.has('smoke')
const serverType = args.get('type') ?? (smoke ? 'cx23' : 'ccx53')
// Falkenstein, Nuremberg and Helsinki price a CCX53 the same; the first with
// capacity wins.
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

function ssh(ip: string, keyPath: string, command: string, input?: string): { code: number, out: string } {
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
    '-o',
    'ServerAliveInterval=30',
    `root@${ip}`,
    command,
  ], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) })
  return { code: result.exitCode ?? 1, out: `${result.stdout.toString()}${result.stderr.toString()}` }
}

async function deleteStaleServers(): Promise<void> {
  const { servers } = await hetzner<{ servers: Array<{ id: number, name: string }> }>('GET', `/servers?label_selector=${encodeURIComponent(LABEL)}`)
  for (const server of servers) {
    console.log(`removing leftover build server ${server.name}`)
    await hetzner('DELETE', `/servers/${server.id}`)
  }
}

async function main(): Promise<void> {
  const version = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const apiToken = envValue('CLOUDFLARE_API_TOKEN')
  const accountId = envValue('CLOUDFLARE_ACCOUNT_ID')

  // Before renting anything: the bucket deploy provisions must exist. A build
  // that only finds out at upload time has already paid for three hours of a
  // 32-core machine.
  const bucket = await new R2Provider({ apiToken, accountId }).getBucket(BUCKET)
  if (!bucket)
    throw new Error(`R2 bucket ${BUCKET} does not exist yet. Deploy Wildloop (it is declared in config/cloud.ts) and run this again.`)

  const credentials = await r2S3Credentials({ apiToken, accountId })

  await deleteStaleServers()

  const keyDir = mkdtempSync(join(tmpdir(), 'tiles-build-'))
  const keyPath = join(keyDir, 'id_ed25519')
  Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `tiles-build-${version}`, '-f', keyPath])
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()

  let serverId: number | undefined
  let sshKeyId: number | undefined
  const started = Date.now()
  try {
    const key = await hetzner<{ ssh_key: { id: number } }>('POST', '/ssh_keys', { name: `tiles-build-${version}-${Date.now()}`, public_key: publicKey, labels: { 'wildloop-role': 'tiles-build' } })
    sshKeyId = key.ssh_key.id

    let ip: string | undefined
    let lastError: unknown
    for (const location of locations) {
      try {
        const created = await hetzner<{ server: { id: number, public_net: { ipv4: { ip: string } } } }>('POST', '/servers', {
          name: `tiles-build-${version}`,
          server_type: serverType,
          image: 'ubuntu-24.04',
          location,
          ssh_keys: [sshKeyId],
          labels: { 'wildloop-role': 'tiles-build' },
          start_after_create: true,
        })
        serverId = created.server.id
        ip = created.server.public_net.ipv4.ip
        console.log(`rented ${serverType} in ${location} (${ip})`)
        break
      }
      catch (error) {
        lastError = error
        console.log(`no ${serverType} in ${location}: ${(error as Error).message}`)
      }
    }
    if (!serverId || !ip)
      throw lastError ?? new Error(`could not rent a ${serverType}`)

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
    ssh(ip, keyPath, 'cat > /root/tiles/remote-build.sh && chmod +x /root/tiles/remote-build.sh', readFileSync(join(import.meta.dir, 'remote-build.sh'), 'utf8'))
    ssh(ip, keyPath, 'cat > /root/tiles/publish.ts', readFileSync(join(import.meta.dir, 'publish.ts'), 'utf8'))
    const launch = ssh(ip, keyPath, 'cd /root/tiles && nohup ./remote-build.sh > build.log 2>&1 < /dev/null & echo launched')
    if (!launch.out.includes('launched'))
      throw new Error(`could not start the build: ${launch.out}`)
    console.log(smoke ? 'smoke run: preflight only' : `building planet ${version}...`)

    let lastLine = ''
    for (;;) {
      await sleep(smoke ? 15_000 : 120_000)
      const elapsed = (Date.now() - started) / 3_600_000
      const probe = ssh(ip, keyPath, 'cat /root/tiles/STATUS 2>/dev/null; echo ---; tail -n 1 /root/tiles/build.log 2>/dev/null')
      const [status = '', line = ''] = probe.out.split('---').map(part => part.trim())
      if (line && line !== lastLine) {
        console.log(`[${elapsed.toFixed(1)}h] ${line.slice(0, 200)}`)
        lastLine = line
      }
      if (status === 'DONE')
        break
      if (status === 'FAILED') {
        console.log(ssh(ip, keyPath, 'tail -n 60 /root/tiles/build.log').out)
        throw new Error('the planet build failed (log above)')
      }
      if (elapsed > HOURS_LIMIT)
        throw new Error(`the planet build ran past ${HOURS_LIMIT} hours`)
    }

    console.log(ssh(ip, keyPath, 'tail -n 12 /root/tiles/build.log').out)
    console.log(smoke
      ? 'smoke run passed: the build server can reach R2 and write to the bucket'
      : `published ${PUBLIC_URL}/tiles.json → planet/${version}.pmtiles in ${((Date.now() - started) / 3_600_000).toFixed(1)} h`)
  }
  finally {
    if (serverId && !args.has('keep')) {
      await hetzner('DELETE', `/servers/${serverId}`).then(() => console.log('build server deleted')).catch(error => console.error(`could not delete the build server: ${error.message}`))
    }
    if (sshKeyId)
      await hetzner('DELETE', `/ssh_keys/${sshKeyId}`).catch(() => {})
    rmSync(keyDir, { recursive: true, force: true })
  }
}

await main()
