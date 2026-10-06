#!/usr/bin/env bun
/**
 * Builds Wildloop's planet basemap on an EC2 machine rented for the job, and
 * publishes it to R2 behind https://tiles.wildloop.org.
 *
 * The map is one PMTiles archive of the whole planet in the OpenMapTiles
 * schema, the schema ts-maps' styles are written against. Building one in a
 * couple of hours needs the whole node map (~100 GB) in memory, fast local
 * disk for planetiler's feature storage, and many cores. So this rents a
 * Graviton m7gd.16xlarge in us-west-2 (64 cores, 256 GB, 3.8 TB NVMe), next
 * to the AWS Open Data copy of planet.osm.pbf, builds there, uploads from
 * there, and the machine terminates itself.
 *
 * Two commands, because nothing should wait hours on a build:
 *
 *   launch  rent the machine with a key pair and a security group made for
 *           it (SSH from this runner's address only), hand it remote-build.sh,
 *           report.ts, publish.ts and the R2 credentials over SSH (never in
 *           user data, which EC2 keeps), start the build, and leave. The key
 *           pair is deleted again before this returns.
 *   check   for every build machine: read _builds/<version>/status.json from
 *           tiles.wildloop.org, which the machine rewrites every five minutes,
 *           and terminate it once it is DONE, FAILED, silent for an hour or
 *           older than eight hours. The machine terminates itself on DONE and
 *           FAILED; this is the net. Also removes security groups left over.
 *
 * `smoke` rehearses both on the smallest machine, a cent and a few minutes.
 *
 * Credentials come from .env.production through buddy, like every other
 * Wildloop script: TILES_AWS_ACCESS_KEY_ID / TILES_AWS_SECRET_ACCESS_KEY (the
 * Stacks AWS account) for EC2, and CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID,
 * from which ts-cloud derives the R2 S3 keys.
 *
 * Run: bun scripts/tiles/build-planet.ts launch|check|smoke [--type=m7gd.16xlarge]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { EC2Client, R2Provider, r2Endpoint, r2S3Credentials, SSMClient } from '@stacksjs/ts-cloud'

const ROOT = join(import.meta.dir, '../..')
const BUCKET = 'wildloop-tiles'
const PUBLIC_URL = 'https://tiles.wildloop.org'
const ROLE = 'tiles-build'
const REGION = 'us-west-2'
/** Canonical's current Ubuntu 24.04 for Graviton, published as an SSM parameter. */
const AMI_PARAMETER = '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id'
/** The AWS Open Data mirror of the weekly planet file, in the same region. */
const PLANET_MIRROR = 'https://osm-planet-us-west-2.s3.amazonaws.com'
/** A build machine older than this is terminated, whatever it says. */
const MAX_AGE_HOURS = 8
/** A machine whose status has not moved in this long has stopped reporting. */
const SILENCE_MINUTES = 60

const [command = 'launch', ...rest] = process.argv.slice(2)
const args = new Map(rest.map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=')
  return [key!, value ?? 'true'] as const
}))

function envValue(key: string): string {
  // `buddy env:get` decrypts with DOTENV_PRIVATE_KEY_PRODUCTION in CI and
  // .env.keys locally. The value is never printed.
  const result = Bun.spawnSync(['./buddy', 'env:get', key, '--file', '.env.production'], { cwd: ROOT })
  const value = result.stdout.toString().trim().split('\n').pop()?.trim() ?? ''
  if (!value || result.exitCode !== 0)
    throw new Error(`${key} is not available from .env.production`)
  return value
}

// ts-cloud's AWS clients read the standard variables.
process.env.AWS_ACCESS_KEY_ID = envValue('TILES_AWS_ACCESS_KEY_ID')
process.env.AWS_SECRET_ACCESS_KEY = envValue('TILES_AWS_SECRET_ACCESS_KEY')
process.env.AWS_REGION = REGION
delete process.env.AWS_PROFILE
delete process.env.AWS_SESSION_TOKEN
const ec2 = new EC2Client(REGION)

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
    // Only the key made for this build. A machine with keys in its SSH agent
    // offers those first, and sshd hangs up after six failures.
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ConnectTimeout=15',
    `ubuntu@${ip}`,
    remote,
  ], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) })
  return { code: result.exitCode ?? 1, out: `${result.stdout.toString()}${result.stderr.toString()}` }
}

interface BuildMachine {
  id: string
  type: string
  state: string
  ip?: string
  launched: number
  tags: Record<string, string>
}

async function buildMachines(): Promise<BuildMachine[]> {
  const result = await ec2.describeInstances({
    Filters: [
      { Name: 'tag:wildloop-role', Values: [ROLE] },
      { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
    ],
  })
  return (result.Reservations ?? []).flatMap(reservation => reservation.Instances ?? []).map(instance => ({
    id: instance.InstanceId!,
    type: instance.InstanceType ?? '',
    state: instance.State?.Name ?? '',
    ip: instance.PublicIpAddress,
    launched: Date.parse(instance.LaunchTime ?? '') || Date.now(),
    tags: Object.fromEntries((instance.Tags ?? []).map(tag => [tag.Key ?? '', tag.Value ?? ''])),
  }))
}

interface BuildStatus {
  state: 'RUNNING' | 'DONE' | 'FAILED'
  version: string
  line: string
  tail?: string[]
  machine?: { disk?: string, memory?: string, load?: string }
  updatedAt: string
}

async function readStatus(version: string): Promise<BuildStatus | null> {
  // Through the public domain rather than the S3 endpoint: a plain GET from
  // anywhere, and a query string so no cache answers for the machine.
  const response = await fetch(`${PUBLIC_URL}/_builds/${version}/status.json?t=${Date.now()}`).catch(() => null)
  if (!response?.ok)
    return null
  return await response.json().catch(() => null) as BuildStatus | null
}

/** The newest planet.osm.pbf in the AWS Open Data mirror. */
async function latestPlanet(): Promise<string> {
  const year = new Date().getUTCFullYear()
  let keys: string[] = []
  for (const prefix of [`planet/pbf/${year}/`, `planet/pbf/${year - 1}/`]) {
    const listing = await (await fetch(`${PLANET_MIRROR}/?list-type=2&prefix=${prefix}`)).text()
    keys = [...listing.matchAll(/<Key>([^<]+\.osm\.pbf)<\/Key>/g)].map(match => match[1]!)
    if (keys.length)
      break
  }
  const newest = keys.sort().at(-1)
  if (!newest)
    throw new Error(`no planet.osm.pbf found in ${PLANET_MIRROR}`)
  return `${PLANET_MIRROR}/${newest}`
}

async function launch(smoke: boolean): Promise<string> {
  const version = smoke ? `smoke-${Date.now()}` : new Date().toISOString().slice(0, 10).replaceAll('-', '')
  const apiToken = envValue('CLOUDFLARE_API_TOKEN')
  const accountId = envValue('CLOUDFLARE_ACCOUNT_ID')

  const inFlight = (await buildMachines()).filter(machine => machine.tags['tiles-smoke'] !== 'true')
  if (!smoke && inFlight.length > 0)
    throw new Error(`a build is already running (${inFlight.map(machine => machine.id).join(', ')}); the hourly check will finish it`)

  // Before renting anything: the bucket deploy provisions must exist. A build
  // that only finds out at upload time has already paid for hours of a machine.
  const bucket = await new R2Provider({ apiToken, accountId }).getBucket(BUCKET)
  if (!bucket)
    throw new Error(`R2 bucket ${BUCKET} does not exist yet. Deploy Wildloop (it is declared in config/cloud.ts) and run this again.`)
  const credentials = await r2S3Credentials({ apiToken, accountId })
  const planet = smoke ? '' : await latestPlanet()
  if (planet)
    console.log(`planet: ${planet}`)

  const ami = (await new SSMClient(REGION).getParameter({ Name: AMI_PARAMETER }))?.Parameter?.Value
  if (!ami)
    throw new Error(`could not resolve ${AMI_PARAMETER}`)

  const types = args.has('type') ? [args.get('type')!] : smoke ? ['t4g.small'] : ['m7gd.16xlarge', 'm6gd.16xlarge', 'r7gd.16xlarge']
  const tags = [{ Key: 'wildloop-role', Value: ROLE }, { Key: 'tiles-version', Value: version }, { Key: 'Name', Value: `tiles-build-${version}` }, ...(smoke ? [{ Key: 'tiles-smoke', Value: 'true' }] : [])]

  const keyDir = mkdtempSync(join(tmpdir(), 'tiles-build-'))
  const keyPath = join(keyDir, 'id_ed25519')
  Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `tiles-build-${version}`, '-f', keyPath])
  const keyName = `tiles-build-${version}-${Date.now()}`

  let instanceId: string | undefined
  let launched = false
  try {
    await ec2.importKeyPair({ KeyName: keyName, PublicKeyMaterial: readFileSync(`${keyPath}.pub`, 'utf8') })

    // SSH from this machine only, for the minute it takes to hand over.
    const myIp = (await (await fetch('https://checkip.amazonaws.com')).text()).trim()
    const group = await ec2.createSecurityGroup({
      GroupName: `tiles-build-${version}-${Date.now()}`,
      Description: `Wildloop tiles build ${version}: SSH from the launcher`,
      TagSpecifications: [{ ResourceType: 'security-group', Tags: tags }],
    })
    await ec2.authorizeSecurityGroupIngress({
      GroupId: group.GroupId!,
      IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: `${myIp}/32`, Description: 'tiles build launcher' }] }],
    })

    const refusals: string[] = []
    for (const type of types) {
      try {
        const run = await ec2.runInstances({
          ImageId: ami,
          InstanceType: type,
          MinCount: 1,
          MaxCount: 1,
          KeyName: keyName,
          SecurityGroupIds: [group.GroupId!],
          InstanceInitiatedShutdownBehavior: 'terminate',
          BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: 40, VolumeType: 'gp3', DeleteOnTermination: true } }],
          MetadataOptions: { HttpTokens: 'required' },
          TagSpecifications: [{ ResourceType: 'instance', Tags: tags }, { ResourceType: 'volume', Tags: tags }],
        })
        instanceId = run.Instances?.[0]?.InstanceId
        if (instanceId) {
          console.log(`rented ${type} in ${REGION} (${instanceId})`)
          break
        }
      }
      catch (error) {
        refusals.push(`${type}: ${(error as Error).message.slice(0, 200)}`)
      }
    }
    if (!instanceId)
      throw new Error(`could not rent a build machine:\n  ${refusals.join('\n  ')}`)
    for (const refusal of refusals) console.log(`  (skipped ${refusal})`)

    let ip: string | undefined
    for (let attempt = 0; attempt < 60 && !ip; attempt++) {
      await sleep(5_000)
      ip = (await buildMachines()).find(machine => machine.id === instanceId && machine.state === 'running')?.ip
    }
    if (!ip)
      throw new Error('the build machine never got a public address')

    // SSH answers a little after the instance reports running.
    for (let attempt = 0; ; attempt++) {
      if (ssh(ip, keyPath, 'true').code === 0)
        break
      if (attempt > 40)
        throw new Error(`the build machine never answered SSH: ${ssh(ip, keyPath, 'true').out.trim().slice(0, 300)}`)
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
      `OSM_URL=${planet}`,
    ].join('\n')
    ssh(ip, keyPath, 'sudo mkdir -p /root/tiles && sudo sh -c "umask 077 && cat > /root/tiles/tiles.env"', `${env}\n`)
    for (const file of ['remote-build.sh', 'report.ts', 'publish.ts'])
      ssh(ip, keyPath, `sudo sh -c "cat > /root/tiles/${file}"`, readFileSync(join(import.meta.dir, file), 'utf8'))
    // Only the build is backgrounded, not a list before it: a backgrounded
    // and-list runs in a subshell that keeps this SSH session open until the
    // build ends, which once held a CI job for half an hour.
    const started = ssh(ip, keyPath, 'sudo sh -c "cd /root/tiles; chmod +x remote-build.sh; setsid nohup ./remote-build.sh > build.log 2>&1 < /dev/null &" ; echo launched')
    if (!started.out.includes('launched'))
      throw new Error(`could not start the build: ${started.out}`)
    launched = true
    console.log(`build ${version} started; it reports to ${PUBLIC_URL}/_builds/${version}/status.json`)
    return version
  }
  finally {
    // The key only ever let us in to start the build. Gone either way.
    await ec2.deleteKeyPair(keyName).catch(() => {})
    if (args.has('keep') && !launched)
      console.log(`kept for debugging: ssh -i ${keyPath} ubuntu@<ip> (key dir not removed)`)
    if (instanceId && !launched && !args.has('keep'))
      await ec2.terminateInstances([instanceId]).then(() => console.log('build machine terminated (launch failed)')).catch(() => {})
    if (!(args.has('keep') && !launched))
      rmSync(keyDir, { recursive: true, force: true })
  }
}

/**
 * Delete the security groups of builds that are over. A group can only go
 * once its instance has fully terminated, so one that is still attached is
 * left for the next check.
 */
async function deleteLeftoverGroups(): Promise<void> {
  const live = new Set((await buildMachines()).map(machine => machine.tags['tiles-version']))
  const listing = await (ec2 as any).describeSecurityGroups({ Filters: [{ Name: 'tag:wildloop-role', Values: [ROLE] }] }).catch(() => null)
  for (const group of listing?.SecurityGroups ?? []) {
    const version = (group.Tags ?? []).find((tag: { Key?: string }) => tag.Key === 'tiles-version')?.Value
    if (version && live.has(version))
      continue
    await ec2.deleteSecurityGroup(group.GroupId).then(() => console.log(`  security group ${group.GroupName} deleted`)).catch(() => {})
  }
}

/** Returns false when a build ended in failure, so CI goes red. */
async function check(): Promise<boolean> {
  const machines = await buildMachines()
  let ok = true
  for (const machine of machines) {
    const version = machine.tags['tiles-version'] ?? ''
    const ageHours = (Date.now() - machine.launched) / 3_600_000
    const status = await readStatus(version)
    const silentMinutes = status ? (Date.now() - Date.parse(status.updatedAt)) / 60_000 : Infinity
    console.log(`${machine.tags.Name ?? machine.id} (${machine.type}, ${machine.state}): ${status?.state ?? 'no status yet'}, ${ageHours.toFixed(1)} h old${status?.line ? `\n  ${status.line}` : ''}`)

    let reason: string | null = null
    if (status?.state === 'DONE')
      reason = 'finished'
    else if (status?.state === 'FAILED')
      reason = 'failed'
    else if (ageHours > MAX_AGE_HOURS)
      reason = `older than ${MAX_AGE_HOURS} h`
    // A fresh machine has not reported yet; give it the same hour of grace.
    else if (ageHours * 60 > SILENCE_MINUTES && silentMinutes > SILENCE_MINUTES)
      reason = `silent for ${Number.isFinite(silentMinutes) ? Math.round(silentMinutes) : '60+'} min`

    if (!reason)
      continue
    if (status?.tail?.length && reason !== 'finished')
      console.log(`  last lines:\n    ${status.tail.slice(-25).join('\n    ')}\n  machine:\n    ${[status.machine?.disk, status.machine?.memory].filter(Boolean).join('\n').split('\n').join('\n    ')}`)
    await ec2.terminateInstances([machine.id])
    console.log(`  terminated (${reason})`)
    if (reason !== 'finished')
      ok = false
    else if (!machine.tags['tiles-smoke'])
      console.log(`  published ${PUBLIC_URL}/tiles.json → planet/${version}.pmtiles`)
  }
  if (machines.length === 0)
    console.log('no build in flight')
  await deleteLeftoverGroups()
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
  let final: BuildStatus | null = null
  for (let attempt = 0; attempt < 40 && !final; attempt++) {
    await sleep(15_000)
    const status = await readStatus(version)
    if (status && status.state !== 'RUNNING')
      final = status
  }
  if (final?.state !== 'DONE') {
    console.log(`smoke run ended ${final?.state ?? 'without a final status'}`)
    console.log(final?.tail?.slice(-20).join('\n') ?? '')
  }
  const ok = await check()
  if (!ok || final?.state !== 'DONE')
    process.exit(1)
  console.log('smoke run passed: rented, handed over, wrote to R2, reported, terminated')
}
else {
  console.error('usage: bun scripts/tiles/build-planet.ts launch|check|smoke')
  process.exit(1)
}
