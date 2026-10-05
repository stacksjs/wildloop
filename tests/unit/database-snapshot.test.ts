import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { snapshotDatabase, snapshotName, snapshotsToPrune } from '../../app/Support/databaseSnapshot'

describe('database snapshots', () => {
  it('names a snapshot so the names sort by time', () => {
    expect(snapshotName(new Date('2026-10-04T03:20:00Z'), 'zst')).toBe('stacks-2026-10-04T03-20-00Z.sqlite.zst')
  })

  it('keeps the newest, and never touches a file that is not a snapshot', () => {
    const files = [
      'stacks-2026-10-01T03-20-00Z.sqlite.zst',
      'stacks-2026-10-03T03-20-00Z.sqlite.zst',
      'stacks-2026-10-02T03-20-00Z.sqlite.gz',
      'backup-pre-events.sqlite',
      'stacks.sqlite',
    ]
    expect(snapshotsToPrune(files, 2)).toEqual(['stacks-2026-10-01T03-20-00Z.sqlite.zst'])
    // Keeping zero would delete the copy just made.
    expect(snapshotsToPrune(files, 0)).toHaveLength(2)
  })

  it('takes a checked, compressed copy and rotates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wildloop-snapshot-'))
    const db = new Database(join(dir, 'stacks.sqlite'))
    db.run('CREATE TABLE trails (id INTEGER PRIMARY KEY, name TEXT)')
    db.run(`INSERT INTO trails (name) VALUES ('Temescal Canyon Trail')`)
    db.close()
    writeFileSync(join(dir, 'snapshots-placeholder'), '')

    const previous = process.env.DB_DATABASE_PATH
    process.env.DB_DATABASE_PATH = join(dir, 'stacks.sqlite')
    try {
      const out = join(dir, 'snapshots')
      for (const day of ['01', '02', '03'])
        snapshotDatabase({ directory: out, keep: 2, at: new Date(`2026-10-${day}T03:20:00Z`) })
      const kept = readdirSync(out).sort()
      expect(kept).toHaveLength(2)
      expect(kept[0]).toStartWith('stacks-2026-10-02')
      // Nothing else left behind: no partial copy, no -shm or -wal.
      expect(kept.every(file => /^stacks-.*\.sqlite\.(?:zst|gz)$/.test(file))).toBe(true)
      // Every account's email and password hash: the owner's alone.
      expect(statSync(out).mode & 0o777).toBe(0o700)
      for (const file of kept)
        expect(statSync(join(out, file)).mode & 0o777).toBe(0o600)
    }
    finally {
      if (previous === undefined)
        delete process.env.DB_DATABASE_PATH
      else
        process.env.DB_DATABASE_PATH = previous
    }
  })
})

describe('pre-migration snapshots', () => {
  it('keep their own rotation, apart from the nightly ones', async () => {
    const { snapshotName, snapshotsToPrune } = await import('../../app/Support/databaseSnapshot')
    const nightly = ['01', '02', '03'].map(d => snapshotName(new Date(`2026-10-${d}T03:20:00Z`), 'zst'))
    const deploys = ['04', '05', '06'].map(d => snapshotName(new Date(`2026-10-${d}T12:00:00Z`), 'zst', 'pre-migration'))
    expect(deploys[0]).toBe('stacks-pre-migration-2026-10-04T12-00-00Z.sqlite.zst')
    const files = [...nightly, ...deploys, 'stacks.sqlite', 'notes.txt']
    // Three deploys in a day do not push last night out, nor the reverse.
    expect(snapshotsToPrune(files, 2)).toEqual([nightly[0]])
    expect(snapshotsToPrune(files, 2, 'pre-migration')).toEqual([deploys[0]])
  })

  it('are taken only when the ledger is missing a migration on disk', async () => {
    const { pendingMigrations } = await import('../../app/Support/databaseSnapshot')
    const { Database } = await import('bun:sqlite')
    const dir = mkdtempSync(join(tmpdir(), 'wildloop-pending-'))
    const migrations = join(dir, 'migrations')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(migrations)
    for (const file of ['0001-a.sql', '0002-b.sql', 'README.md'])
      writeFileSync(join(migrations, file), '')
    const dbFile = join(dir, 'db.sqlite')
    const db = new Database(dbFile)
    db.run('CREATE TABLE migrations (migration TEXT)')
    db.run(`INSERT INTO migrations VALUES ('0001-a.sql')`)
    db.close()
    expect(pendingMigrations(dbFile, migrations)).toEqual(['0002-b.sql'])

    const done = new Database(dbFile)
    done.run(`INSERT INTO migrations VALUES ('0002-b.sql')`)
    done.close()
    expect(pendingMigrations(dbFile, migrations)).toEqual([])
    // A fresh box: no database yet, everything is pending.
    expect(pendingMigrations(join(dir, 'none.sqlite'), migrations)).toEqual(['0001-a.sql', '0002-b.sql'])
  })
})
