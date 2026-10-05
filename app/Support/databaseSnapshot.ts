import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

/**
 * Nightly copies of the production database.
 *
 * Until this, nothing backed up wildloop's SQLite file: 1.6 GB of trails,
 * runs, territories and accounts on one disk, with two hand-made copies from
 * August beside it on the same disk. A bad migration, a corrupted page or a
 * mistyped DELETE had nothing to go back to.
 *
 * Each snapshot is taken with SQLite's online backup API (`.backup`), which is
 * consistent while the app keeps writing, checked with `PRAGMA quick_check`,
 * compressed, and kept for `keep` nights. Snapshots on the same disk protect
 * against the database going wrong, not against the disk going: the command
 * then sends each one to Hetzner Object Storage (app/Support/snapshotOffsite.ts).
 */

export const SNAPSHOT_PREFIX = 'stacks-'

/**
 * A snapshot taken for a reason other than the night, kept in its own
 * rotation: `stacks-pre-migration-2026-10-05T03-20-00Z.sqlite.zst`. Nightly
 * snapshots have no label, so a busy day of deploys cannot push last night's
 * copy out, and the nightly job cannot prune the copy taken before a deploy.
 */
export type SnapshotLabel = 'pre-migration'

/** `stacks-2026-10-04T03-20-00Z.sqlite.zst`: sortable, and safe in any filesystem. */
export function snapshotName(at: Date, extension: string, label?: SnapshotLabel): string {
  return `${SNAPSHOT_PREFIX}${label ? `${label}-` : ''}${at.toISOString().slice(0, 19).replace(/:/g, '-')}Z.sqlite.${extension}`
}

/** Snapshots of one rotation past the newest `keep`, oldest first. Anything not ours is never touched. */
export function snapshotsToPrune(files: string[], keep: number, label?: SnapshotLabel): string[] {
  const rotation = label
    ? new RegExp(`^${SNAPSHOT_PREFIX}${label}-\\d{4}-`)
    : new RegExp(`^${SNAPSHOT_PREFIX}\\d{4}-`)
  const ours = files
    .filter(file => rotation.test(file) && /\.sqlite\.(?:zst|gz)$/.test(file))
    .sort()
  return ours.slice(0, Math.max(0, ours.length - Math.max(1, keep)))
}

/**
 * Migrations on disk the database has not run, by file name: the same ledger
 * `buddy migrate` keeps (the `migrations` table, one row per file run).
 *
 * A deploy migrates before its new release has proven anything, and a
 * release that is then rolled back leaves the database migrated. When there
 * is something to migrate, the deploy takes a snapshot first (`db:snapshot
 * --before-migrations`), so there is a copy from before the schema moved.
 */
export function pendingMigrations(databaseFile: string, migrationsDir: string): string[] {
  if (!existsSync(migrationsDir))
    return []
  const onDisk = readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort()
  if (!existsSync(databaseFile))
    return onDisk
  const db = new Database(databaseFile, { readonly: true })
  try {
    const hasLedger = db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrations'`).get()
    if (!hasLedger)
      return onDisk
    const ran = new Set((db.query('SELECT migration FROM migrations').all() as Array<{ migration: string }>).map(row => row.migration))
    return onDisk.filter(file => !ran.has(file))
  }
  finally {
    db.close()
  }
}

export interface SnapshotReport {
  file: string
  bytes: number
  /** Absolute path of the snapshot written. */
  path: string
  pruned: string[]
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(`${command[0]} failed (${result.exitCode}): ${result.stderr.toString().trim() || result.stdout.toString().trim()}`)
}

function has(binary: string): boolean {
  return Bun.spawnSync(['sh', '-c', `command -v ${binary}`]).exitCode === 0
}

export function databasePath(): string {
  return resolve(process.env.DB_DATABASE_PATH || 'database/stacks.sqlite')
}

/** Take, check, compress and rotate one snapshot. */
export function snapshotDatabase(options: { keep?: number, directory?: string, at?: Date, label?: SnapshotLabel } = {}): SnapshotReport {
  const source = databasePath()
  if (!existsSync(source))
    throw new Error(`No database at ${source}`)
  if (!has('sqlite3'))
    throw new Error('sqlite3 is not installed')

  const directory = resolve(options.directory || process.env.DB_SNAPSHOT_DIR || join(dirname(source), 'snapshots'))
  // A snapshot is every account's email and password hash: readable by the
  // owner alone, whatever the umask, and the directory listing too.
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)

  const zstd = has('zstd')
  const extension = zstd ? 'zst' : 'gz'
  const name = snapshotName(options.at ?? new Date(), extension, options.label)
  const raw = join(directory, `.${name}.partial.sqlite`)
  const finished = join(directory, name)

  try {
    // The online backup API: consistent at one instant while the app writes on.
    run(['sqlite3', source, `.backup '${raw.replace(/'/g, `''`)}'`])
    const check = Bun.spawnSync(['sqlite3', raw, 'PRAGMA quick_check'], { stdout: 'pipe' }).stdout.toString().trim()
    if (check !== 'ok')
      throw new Error(`The snapshot failed its integrity check: ${check.slice(0, 200)}`)

    const compressed = `${raw}.${extension}`
    run(zstd ? ['zstd', '-q', '-3', '--rm', '-f', raw, '-o', compressed] : ['gzip', '-6', '-f', raw])
    chmodSync(compressed, 0o600)
    renameSync(compressed, finished)
  }
  finally {
    // Opening the copy for its check leaves SQLite's -shm and -wal beside it.
    for (const leftover of [raw, `${raw}-shm`, `${raw}-wal`, `${raw}.zst`, `${raw}.gz`]) {
      if (existsSync(leftover))
        unlinkSync(leftover)
    }
  }

  const pruned = snapshotsToPrune(readdirSync(directory), options.keep ?? 7, options.label)
  for (const file of pruned)
    unlinkSync(join(directory, file))

  return { file: basename(finished), path: finished, bytes: statSync(finished).size, pruned }
}
