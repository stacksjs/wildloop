import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { S3Client } from 'bun'
import { databasePath } from './databaseSnapshot'
import { offsiteDestination } from './snapshotOffsite'

/**
 * Restore last night's off-box snapshot somewhere harmless, and see that it is
 * a database.
 *
 * A backup nobody has restored is a hypothesis. The nightly job checks each
 * copy before it compresses it and checks the size after uploading, which
 * proves the bytes arrived; it does not prove they come back as a database
 * the app could run on. Once a week this downloads the newest snapshot from
 * Hetzner, decompresses it, runs SQLite's integrity check on it, and compares
 * its row counts with the live database. Any failure fails the job, which
 * reports to its own StatusHQ monitor, so a backup that has quietly stopped
 * being restorable is found on a Sunday morning rather than on the day it is
 * needed.
 *
 * The restored copy is written beside the snapshots (owner-only, like them)
 * and deleted however the drill ends.
 */

type Env = Record<string, string | undefined>

/** A snapshot this old means the nightly job has stopped. */
export const MAX_SNAPSHOT_AGE_HOURS = 48

/** The copy may trail the live database by a night, never by most of it. */
export const MIN_ROW_SHARE = 0.9

/** Tables whose row counts must survive a restore. */
export const DRILL_TABLES = ['trails', 'users', 'activities'] as const

export interface DrillReport {
  key: string
  bytes: number
  ageHours: number
  integrity: string
  rows: Record<string, { restored: number, live: number }>
}

export interface DrillBucket {
  list: (options: { prefix: string, maxKeys?: number }) => Promise<{ contents?: Array<{ key?: string, lastModified?: string | Date, size?: number }> }>
  /** Writes the object to a local path. */
  download: (key: string, path: string) => Promise<void>
}

/** The newest snapshot in the folder: names sort by time, nightly ones only. */
export function newestSnapshot(objects: Array<{ key?: string, lastModified?: string | Date }>, prefix: string): { key: string, lastModified?: string | Date } | null {
  const nightly = objects
    .filter(o => o.key && o.key.startsWith(`${prefix}/stacks-`) && /\/stacks-\d{4}-[^/]*\.sqlite\.(?:zst|gz)$/.test(o.key))
    .sort((a, b) => (a.key! < b.key! ? 1 : -1))
  return nightly[0] ? { key: nightly[0].key!, lastModified: nightly[0].lastModified } : null
}

function counts(file: string, tables: readonly string[]): Record<string, number> {
  const db = new Database(file, { readonly: true })
  try {
    const out: Record<string, number> = {}
    for (const table of tables) {
      const exists = db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
      out[table] = exists ? Number((db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n) : -1
    }
    return out
  }
  finally {
    db.close()
  }
}

function decompress(file: string): string {
  const out = file.replace(/\.(?:zst|gz)$/, '')
  const command = file.endsWith('.zst') ? ['zstd', '-q', '-d', '-f', file, '-o', out] : ['sh', '-c', `gunzip -c '${file.replace(/'/g, `'\\''`)}' > '${out.replace(/'/g, `'\\''`)}'`]
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(`could not decompress ${file}: ${result.stderr.toString().trim()}`)
  return out
}

function bucketFor(env: Env): { bucket: DrillBucket, prefix: string } | null {
  const destination = offsiteDestination(env)
  if (!destination)
    return null
  const client = new S3Client({
    bucket: destination.bucket,
    region: destination.region,
    endpoint: destination.endpoint,
    accessKeyId: destination.credentials.accessKeyId,
    secretAccessKey: destination.credentials.secretAccessKey,
  })
  return {
    prefix: destination.prefix,
    bucket: {
      list: options => client.list(options),
      async download(key, path) {
        await Bun.write(path, client.file(key))
      },
    },
  }
}

/**
 * Run the drill. Throws, with the reason, when the snapshot is missing, old,
 * damaged, or short of rows; returns what it checked when it is sound.
 */
export async function runRestoreDrill(
  env: Env,
  options: { bucket?: DrillBucket, prefix?: string, liveDatabase?: string, workDir?: string, now?: Date } = {},
): Promise<DrillReport> {
  const configured = options.bucket ? { bucket: options.bucket, prefix: options.prefix ?? 'wildloop/database' } : bucketFor(env)
  if (!configured)
    throw new Error('no off-box destination configured (HETZNER_S3_ACCESS_KEY / HETZNER_S3_SECRET_KEY)')

  const listing = await configured.bucket.list({ prefix: `${configured.prefix}/`, maxKeys: 1000 })
  const newest = newestSnapshot(listing.contents ?? [], configured.prefix)
  if (!newest)
    throw new Error(`no snapshot under ${configured.prefix}/`)

  const now = options.now ?? new Date()
  const modified = newest.lastModified ? new Date(newest.lastModified).getTime() : Number.NaN
  const ageHours = Number.isFinite(modified) ? (now.getTime() - modified) / 3_600_000 : Number.POSITIVE_INFINITY
  if (ageHours > MAX_SNAPSHOT_AGE_HOURS)
    throw new Error(`the newest snapshot, ${newest.key}, is ${Math.round(ageHours)} hours old`)

  const live = resolve(options.liveDatabase ?? databasePath())
  const work = resolve(options.workDir ?? join(dirname(live), 'snapshots', '.restore-drill'))
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true, mode: 0o700 })

  try {
    const downloaded = join(work, newest.key.split('/').pop() as string)
    await configured.bucket.download(newest.key, downloaded)
    const bytes = statSync(downloaded).size
    const restored = decompress(downloaded)
    rmSync(downloaded, { force: true })

    const check = Bun.spawnSync(['sqlite3', restored, 'PRAGMA quick_check'], { stdout: 'pipe', stderr: 'pipe' })
    const integrity = check.stdout.toString().trim() || check.stderr.toString().trim()
    if (integrity !== 'ok')
      throw new Error(`the restored copy failed its integrity check: ${integrity.slice(0, 200)}`)

    const restoredRows = counts(restored, DRILL_TABLES)
    const liveRows = existsSync(live) ? counts(live, DRILL_TABLES) : {}
    const rows: DrillReport['rows'] = {}
    for (const table of DRILL_TABLES) {
      const r = restoredRows[table]
      const l = liveRows[table] ?? -1
      rows[table] = { restored: r, live: l }
      if (r < 0)
        throw new Error(`the restored copy has no ${table} table`)
      if (l > 0 && r < l * MIN_ROW_SHARE)
        throw new Error(`the restored copy has ${r} ${table}, the live database ${l}`)
    }

    return { key: newest.key, bytes, ageHours: Math.round(ageHours * 10) / 10, integrity, rows }
  }
  finally {
    // The copy, and the -shm/-wal that opening it leaves: nothing stays.
    rmSync(work, { recursive: true, force: true })
  }
}
