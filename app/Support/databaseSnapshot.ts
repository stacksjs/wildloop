import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
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
 * against the database going wrong, not against the disk going: for that,
 * point `DB_SNAPSHOT_RESTIC_ENV` at an env file holding a restic repository
 * (RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE and the storage credentials) and
 * each snapshot is also sent off the box. The file is sourced by the shell;
 * its secrets never pass through this process.
 */

export const SNAPSHOT_PREFIX = 'stacks-'

/** `stacks-2026-10-04T03-20-00Z.sqlite.zst`: sortable, and safe in any filesystem. */
export function snapshotName(at: Date, extension: string): string {
  return `${SNAPSHOT_PREFIX}${at.toISOString().slice(0, 19).replace(/:/g, '-')}Z.sqlite.${extension}`
}

/** Snapshots past the newest `keep`, oldest first. Anything not ours is never touched. */
export function snapshotsToPrune(files: string[], keep: number): string[] {
  const ours = files
    .filter(file => file.startsWith(SNAPSHOT_PREFIX) && /\.sqlite\.(?:zst|gz)$/.test(file))
    .sort()
  return ours.slice(0, Math.max(0, ours.length - Math.max(1, keep)))
}

export interface SnapshotReport {
  file: string
  bytes: number
  pruned: string[]
  offsite: 'sent' | 'not configured'
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

/** Take, check, compress, rotate and (when configured) send one snapshot. */
export function snapshotDatabase(options: { keep?: number, directory?: string, at?: Date } = {}): SnapshotReport {
  const source = databasePath()
  if (!existsSync(source))
    throw new Error(`No database at ${source}`)
  if (!has('sqlite3'))
    throw new Error('sqlite3 is not installed')

  const directory = resolve(options.directory || process.env.DB_SNAPSHOT_DIR || join(dirname(source), 'snapshots'))
  mkdirSync(directory, { recursive: true })

  const zstd = has('zstd')
  const extension = zstd ? 'zst' : 'gz'
  const name = snapshotName(options.at ?? new Date(), extension)
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
    renameSync(compressed, finished)
  }
  finally {
    // Opening the copy for its check leaves SQLite's -shm and -wal beside it.
    for (const leftover of [raw, `${raw}-shm`, `${raw}-wal`, `${raw}.zst`, `${raw}.gz`]) {
      if (existsSync(leftover))
        unlinkSync(leftover)
    }
  }

  const pruned = snapshotsToPrune(readdirSync(directory), options.keep ?? 7)
  for (const file of pruned)
    unlinkSync(join(directory, file))

  let offsite: SnapshotReport['offsite'] = 'not configured'
  const resticEnv = process.env.DB_SNAPSHOT_RESTIC_ENV
  if (resticEnv && existsSync(resticEnv)) {
    if (!has('restic'))
      throw new Error('DB_SNAPSHOT_RESTIC_ENV is set but restic is not installed')
    // Sourced by the shell, so the repository's secrets never pass through here.
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
    run(['bash', '-c', [
      'set -euo pipefail',
      `set -a; source ${quote(resticEnv)}; set +a`,
      `restic backup --quiet --tag wildloop-db ${quote(finished)}`,
      'restic forget --quiet --tag wildloop-db --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune',
    ].join('\n')])
    offsite = 'sent'
  }

  return { file: basename(finished), bytes: statSync(finished).size, pruned, offsite }
}
