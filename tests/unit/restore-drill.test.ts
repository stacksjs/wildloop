import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newestSnapshot, runRestoreDrill } from '../../app/Support/restoreDrill'

const NOW = new Date('2026-10-11T05:40:00Z')

/** A database with the drill's tables, gzipped as a snapshot would be. */
function snapshot(dir: string, rows: { trails: number, users: number, activities: number }, name = 'stacks-2026-10-11T03-20-00Z.sqlite'): string {
  const file = join(dir, name)
  const db = new Database(file)
  for (const [table, n] of Object.entries(rows)) {
    db.run(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`)
    const insert = db.prepare(`INSERT INTO ${table} DEFAULT VALUES`)
    for (let i = 0; i < n; i++) insert.run()
  }
  db.close()
  Bun.spawnSync(['gzip', '-f', file])
  return `${file}.gz`
}

function bucket(files: Record<string, { path?: string, lastModified: Date }>) {
  return {
    list: async () => ({ contents: Object.entries(files).map(([key, f]) => ({ key, lastModified: f.lastModified.toISOString() })) }),
    async download(key: string, path: string) {
      const source = files[key].path
      if (!source)
        throw new Error('missing')
      await Bun.write(path, Bun.file(source))
    },
  }
}

function live(dir: string, rows: { trails: number, users: number, activities: number }): string {
  const file = join(dir, 'live.sqlite')
  const db = new Database(file)
  for (const [table, n] of Object.entries(rows)) {
    db.run(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`)
    const insert = db.prepare(`INSERT INTO ${table} DEFAULT VALUES`)
    for (let i = 0; i < n; i++) insert.run()
  }
  db.close()
  return file
}

describe('restore drill', () => {
  it('picks the newest nightly snapshot, ignoring pre-migration copies and strangers', () => {
    const newest = newestSnapshot([
      { key: 'wildloop/database/stacks-2026-10-10T03-20-00Z.sqlite.zst' },
      { key: 'wildloop/database/stacks-2026-10-11T03-20-00Z.sqlite.zst' },
      { key: 'wildloop/database/stacks-pre-migration-2026-10-12T10-00-00Z.sqlite.zst' },
      { key: 'wildloop/database/notes.txt' },
    ], 'wildloop/database')
    expect(newest?.key).toBe('wildloop/database/stacks-2026-10-11T03-20-00Z.sqlite.zst')
  })

  it('restores a sound snapshot, checks it, and leaves nothing behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wildloop-drill-'))
    const work = join(dir, 'work')
    const path = snapshot(dir, { trails: 50, users: 5, activities: 10 })
    const report = await runRestoreDrill({}, {
      bucket: bucket({ 'wildloop/database/stacks-2026-10-11T03-20-00Z.sqlite.gz': { path, lastModified: new Date('2026-10-11T03:21:00Z') } }),
      liveDatabase: live(dir, { trails: 52, users: 5, activities: 10 }),
      workDir: work,
      now: NOW,
    })
    expect(report.integrity).toBe('ok')
    expect(report.rows.trails).toEqual({ restored: 50, live: 52 })
    expect(report.ageHours).toBeCloseTo(2.3, 1)
    expect(existsSync(work)).toBe(false)
  })

  it('fails a snapshot that has lost most of a table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wildloop-drill-'))
    const path = snapshot(dir, { trails: 10, users: 5, activities: 10 })
    await expect(runRestoreDrill({}, {
      bucket: bucket({ 'wildloop/database/stacks-2026-10-11T03-20-00Z.sqlite.gz': { path, lastModified: new Date('2026-10-11T03:21:00Z') } }),
      liveDatabase: live(dir, { trails: 50, users: 5, activities: 10 }),
      workDir: join(dir, 'work'),
      now: NOW,
    })).rejects.toThrow('has 10 trails, the live database 50')
  })

  it('fails when the newest snapshot is too old: the nightly job has stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wildloop-drill-'))
    const path = snapshot(dir, { trails: 50, users: 5, activities: 10 })
    await expect(runRestoreDrill({}, {
      bucket: bucket({ 'wildloop/database/stacks-2026-10-07T03-20-00Z.sqlite.gz': { path, lastModified: new Date('2026-10-07T03:21:00Z') } }),
      workDir: join(dir, 'work'),
      now: NOW,
    })).rejects.toThrow('hours old')
  })

  it('fails a snapshot that is not a database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wildloop-drill-'))
    const junk = join(dir, 'junk.sqlite')
    writeFileSync(junk, 'this is not a database'.repeat(100))
    Bun.spawnSync(['gzip', '-f', junk])
    const work = join(dir, 'work')
    await expect(runRestoreDrill({}, {
      bucket: bucket({ 'wildloop/database/stacks-2026-10-11T03-20-00Z.sqlite.gz': { path: `${junk}.gz`, lastModified: new Date('2026-10-11T03:21:00Z') } }),
      workDir: work,
      now: NOW,
    })).rejects.toThrow()
    expect(existsSync(work) ? readdirSync(work) : []).toEqual([])
  })

  it('fails when there is nothing to restore, or nowhere to look', async () => {
    await expect(runRestoreDrill({}, { bucket: bucket({}), now: NOW })).rejects.toThrow('no snapshot under')
    await expect(runRestoreDrill({}, { now: NOW })).rejects.toThrow('no off-box destination configured')
  })
})
