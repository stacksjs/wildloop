/**
 * Put `.env.keys` on the server, where the app can decrypt `.env.production`.
 *
 * `.env.production` is committed on purpose: its sensitive values are
 * encrypted, so the file is safe in git and ships with every release.
 * `.env.keys` holds the private half that decrypts them, so it is gitignored
 * and must never be committed.
 *
 * That combination has a gap. ts-cloud builds the release tarball from
 * git-tracked files, so a gitignored file cannot ride along no matter what is
 * configured. The result on the box today is a `.env` whose APP_KEY is the
 * literal string `encrypted:…` — shipped, unreadable, and silently wrong.
 *
 * So the key file is copied out of band into each site's `shared/` directory,
 * which ts-cloud keeps across releases (it is where `.env` already lives), and
 * every release symlinks it in from `preStart`. One copy per site, replaced
 * only when the keys rotate.
 *
 * Run: `bun scripts/push-env-keys.ts [--env production]`
 * Or let `bun run deploy` do it, which runs this first.
 */

import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { tsCloud } from '../config/cloud'

const KEYS_FILE = '.env.keys'

interface HetznerServer {
  name: string
  public_net: { ipv4: { ip: string } | null }
}

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/**
 * The box to copy to.
 *
 * WildLoop provisions no server of its own (`cloud.attachTo`), so the target
 * is the owning project's `<owner>-<environment>-app`. Resolved through the
 * Hetzner API rather than hardcoded, so it follows a rebuild or a move.
 */
async function resolveServerIp(environment: string): Promise<string> {
  const token = process.env.HCLOUD_TOKEN
  if (!token)
    fail('HCLOUD_TOKEN is not set. It is needed to find the server this project attaches to.')

  const owner = tsCloud.cloud?.attachTo ?? tsCloud.project.slug
  const name = `${owner}-${environment}-app`

  const response = await fetch('https://api.hetzner.cloud/v1/servers', {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok)
    fail(`Hetzner API returned ${response.status} ${response.statusText}`)

  const body = await response.json() as { servers?: HetznerServer[] }
  const server = body.servers?.find(candidate => candidate.name === name)

  if (!server)
    fail(`No Hetzner server named "${name}". Found: ${(body.servers ?? []).map(s => s.name).join(', ')}`)

  const ip = server.public_net.ipv4?.ip
  if (!ip)
    fail(`Server "${name}" has no public IPv4 address.`)

  return ip
}

/**
 * Every site that runs a process. A redirect-only site has no app to read the
 * keys, and a bucket site has no server at all.
 */
function runtimeSiteDirectories(): string[] {
  const slug = tsCloud.project.slug

  return Object.entries(tsCloud.sites ?? {})
    .filter(([, site]) => Boolean((site as { start?: string }).start))
    .map(([key]) => `/var/www/${slug}-${key}`)
}

/**
 * A keys file that does not carry the target environment's private key is
 * worse than a missing one: the copy succeeds, the release symlinks it in, and
 * every `encrypted:v2:` value in `.env.production` quietly falls back to its
 * default — which is how an app boots with the wrong APP_KEY and signs out
 * everybody. `@stacksjs/env` looks up `DOTENV_PRIVATE_KEY_<ENVIRONMENT>` and
 * falls back to `DOTENV_PRIVATE_KEY`, so accept either, but require one of
 * them to be present and non-empty.
 */
function assertKeyFor(keys: string, environment: string): void {
  const names = [`DOTENV_PRIVATE_KEY_${environment.toUpperCase()}`, 'DOTENV_PRIVATE_KEY']

  for (const name of names) {
    const match = keys.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'm'))
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '')
    if (value)
      return
  }

  fail(
    `${KEYS_FILE} has no private key for "${environment}". Set ${names[0]} `
    + `(the GitHub secret of the same name) before deploying — without it the box `
    + `cannot decrypt .env.${environment} and every encrypted value falls back to its default.`,
  )
}

async function main(): Promise<void> {
  const environment = process.argv.includes('--env')
    ? process.argv[process.argv.indexOf('--env') + 1]
    : 'production'

  if (!existsSync(KEYS_FILE))
    fail(`${KEYS_FILE} not found. It is gitignored, so it has to exist locally before a deploy.`)

  const directories = runtimeSiteDirectories()
  if (directories.length === 0)
    fail('No sites with a `start` command are configured, so there is nothing to copy to.')

  const keys = await Bun.file(KEYS_FILE).text()
  assertKeyFor(keys, environment)

  const ip = await resolveServerIp(environment)
  console.log(`→ ${ip} (${environment})`)

  // Written over ssh rather than scp so the mode is set in the same step: the
  // file is only readable by root, and never exists world-readable even
  // momentarily.
  for (const dir of directories) {
    const proc = Bun.spawn([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      `root@${ip}`,
      `mkdir -p ${dir}/shared && cat > ${dir}/shared/.env.keys && chmod 600 ${dir}/shared/.env.keys`,
    ], { stdin: new Blob([Buffer.from(keys)]), stdout: 'inherit', stderr: 'inherit' })

    const code = await proc.exited
    if (code !== 0)
      fail(`Failed to write ${dir}/shared/.env.keys (ssh exited ${code}).`)

    console.log(`  ✓ ${dir}/shared/.env.keys`)
  }

  console.log(`\n${directories.length} site(s) updated. Releases symlink this in via preStart.`)
}

await main()
