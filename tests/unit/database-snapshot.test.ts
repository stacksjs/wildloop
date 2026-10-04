import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
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
    }
    finally {
      if (previous === undefined)
        delete process.env.DB_DATABASE_PATH
      else
        process.env.DB_DATABASE_PATH = previous
    }
  })
})
