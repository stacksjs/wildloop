#!/usr/bin/env bun
/**
 * Copy wildloop.org's DNS from Porkbun into a Cloudflare zone.
 *
 * Moving the zone is what gives the app a visitor's approximate location:
 * Cloudflare adds `cf-iplatitude` / `cf-ipcity` to every proxied request, and
 * `app/Helpers/visitorCountry.ts` already reads them. Without an edge in front
 * `/api/geo/here` answers `located: false` and the catalog opens on the whole
 * country instead of somewhere you could drive to this weekend.
 *
 * The dangerous part of that move is not the web traffic, it is the mail.
 * wildloop.org serves its own SMTP, and the records that make mail work — MX,
 * SPF, DKIM, DMARC — have to arrive intact and with the right proxy flags, or
 * mail silently stops being delivered some hours after the nameservers change.
 * So this reads Porkbun as the source of truth rather than anybody retyping
 * seventeen records, and it is explicit about which of them may be proxied.
 *
 *   bun scripts/cloudflare-import-dns.ts              # dry run, writes nothing
 *   bun scripts/cloudflare-import-dns.ts --apply      # create the records
 *
 * Needs CLOUDFLARE_API_TOKEN in the environment (Edit zone DNS on this zone).
 * Porkbun credentials come from this project's own .env.
 *
 * Idempotent: a record that already exists in Cloudflare with the same type,
 * name and content is left alone, so re-running after a partial failure only
 * fills the gaps.
 */

import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { resolve } from 'node:path'

const DOMAIN = 'wildloop.org'
const APPLY = process.argv.includes('--apply')

/**
 * Hosts whose traffic goes through Cloudflare's edge.
 *
 * Everything NOT on this list stays DNS-only, which is the safe default and
 * the required one for `mail`: Cloudflare does not proxy SMTP, and proxying
 * would hide the origin address that this domain's own SPF record authorises.
 * A proxied mail host is a domain whose mail quietly stops arriving.
 */
const PROXIED_HOSTS = new Set([
  DOMAIN,
  `www.${DOMAIN}`,
  `dashboard.${DOMAIN}`,
  `www.dashboard.${DOMAIN}`,
])

/** Only address records can be proxied at all. */
const PROXYABLE_TYPES = new Set(['A', 'AAAA'])

interface PorkbunRecord {
  name: string
  type: string
  content: string
  ttl?: string
  prio?: string
}

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/** Read one key out of a plain `.env`, without pulling in a loader. */
function fromEnvFile(path: string, key: string): string | undefined {
  if (!existsSync(path))
    return undefined
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const match = line.match(new RegExp(`^${key}\\s*=\\s*(.*)$`))
    if (match)
      return match[1]?.trim().replace(/^["']|["']$/g, '')
  }
  return undefined
}

async function porkbunRecords(apiKey: string, secret: string): Promise<PorkbunRecord[]> {
  const res = await fetch(`https://api.porkbun.com/api/json/v3/dns/retrieve/${DOMAIN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: apiKey, secretapikey: secret }),
  })

  const body = await res.json() as { status?: string, records?: PorkbunRecord[], message?: string }
  if (body.status !== 'SUCCESS')
    fail(`Porkbun refused the record list: ${body.message ?? 'unknown error'}`)

  return body.records ?? []
}

async function cloudflare(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  return res.json()
}

async function main(): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token)
    fail('CLOUDFLARE_API_TOKEN is not set. It needs Edit zone DNS on this zone.')

  const root = resolve(import.meta.dir, '..')
  const apiKey = fromEnvFile(resolve(root, '.env'), 'PORKBUN_API_KEY')
  const secret = fromEnvFile(resolve(root, '.env'), 'PORKBUN_SECRET_KEY')
  if (!apiKey || !secret)
    fail('PORKBUN_API_KEY / PORKBUN_SECRET_KEY are missing from .env.')

  const zones = await cloudflare(token, `/zones?name=${DOMAIN}`)
  const zone = zones?.result?.[0]
  if (!zone)
    fail(`No Cloudflare zone for ${DOMAIN}. Add the site first, then re-run.`)

  console.log(`zone ${zone.id} (${zone.status})`)

  const existingResponse = await cloudflare(token, `/zones/${zone.id}/dns_records?per_page=200`)
  const existing = (existingResponse?.result ?? []) as any[]
  const seen = new Set(existing.map(r => `${r.type}|${r.name}|${r.content}`))

  const source = await porkbunRecords(apiKey, secret)
  console.log(`porkbun has ${source.length} record(s)\n`)

  let created = 0
  let skipped = 0

  for (const record of source) {
    // Cloudflare runs the zone's own nameservers; copying the registrar's
    // would be asserting the delegation we are in the middle of moving.
    if (record.type === 'NS') {
      console.log(`  skip  NS    ${record.name} (Cloudflare manages its own)`)
      continue
    }

    const proxied = PROXYABLE_TYPES.has(record.type) && PROXIED_HOSTS.has(record.name)
    const key = `${record.type}|${record.name}|${record.content}`

    if (seen.has(key)) {
      console.log(`  have  ${record.type.padEnd(5)} ${record.name}`)
      skipped++
      continue
    }

    const payload: Record<string, unknown> = {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: 1,
    }
    if (PROXYABLE_TYPES.has(record.type))
      payload.proxied = proxied
    if (record.type === 'MX')
      payload.priority = Number(record.prio ?? 10)

    const label = `${record.type.padEnd(5)} ${record.name.padEnd(32)} ${proxied ? 'proxied' : 'dns-only'}`

    if (!APPLY) {
      console.log(`  would ${label}`)
      continue
    }

    const result = await cloudflare(token, `/zones/${zone.id}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    if (result?.success) {
      console.log(`  add   ${label}`)
      created++
    }
    else {
      console.log(`  FAIL  ${label} — ${(result?.errors ?? []).map((e: any) => e.message).join('; ')}`)
    }
  }

  console.log(
    APPLY
      ? `\n${created} created, ${skipped} already present.`
      : '\nDry run — nothing was written. Re-run with --apply.',
  )

  if (APPLY) {
    console.log(
      '\nBefore switching nameservers, confirm mail is DNS-only:\n'
      + `  the A record for mail.${DOMAIN} must show a GREY cloud, and MX/TXT must be present.\n`
      + 'Proxying the mail host is what breaks delivery, and it breaks it silently.',
    )
  }
}

await main()
