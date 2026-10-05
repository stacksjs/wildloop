import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keysToPrune, offsiteDestination, sendSnapshotOffsite } from '../../app/Support/snapshotOffsite'

const CREDS = { HETZNER_S3_ACCESS_KEY: 'HETZNERKEY', HETZNER_S3_SECRET_KEY: 'hetzner-secret' }
const DAY = 86_400_000

describe('snapshot off-box destination', () => {
  it('is off without both Hetzner keys, whatever AWS keys the env holds', () => {
    expect(offsiteDestination({})).toBeNull()
    expect(offsiteDestination({ HETZNER_S3_ACCESS_KEY: 'k' })).toBeNull()
    expect(offsiteDestination({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's' })).toBeNull()
  })

  it('defaults to the stack bucket, a wildloop folder, Helsinki and 30 days', () => {
    expect(offsiteDestination(CREDS)).toEqual({
      bucket: 'stacks-production-backups',
      prefix: 'wildloop/database',
      region: 'hel1',
      endpoint: 'https://hel1.your-objectstorage.com',
      keepDays: 30,
      credentials: { accessKeyId: 'HETZNERKEY', secretAccessKey: 'hetzner-secret' },
    })
  })

  it('takes overrides, and trims slashes off the folder', () => {
    const d = offsiteDestination({ ...CREDS, DB_SNAPSHOT_S3_BUCKET: 'b', DB_SNAPSHOT_S3_PREFIX: '/x/y/', DB_SNAPSHOT_S3_REGION: 'nbg1', DB_SNAPSHOT_S3_KEEP_DAYS: '14' })
    expect(d?.bucket).toBe('b')
    expect(d?.prefix).toBe('x/y')
    expect(d?.endpoint).toBe('https://nbg1.your-objectstorage.com')
    expect(d?.keepDays).toBe(14)
  })
})

describe('pruning old snapshots in the bucket', () => {
  const now = new Date('2026-10-05T03:20:00Z')
  it('removes only old objects in its own folder, never the new one', () => {
    const keys = keysToPrune([
      { key: 'wildloop/database/old.sqlite.zst', lastModified: new Date(now.getTime() - 40 * DAY) },
      { key: 'wildloop/database/recent.sqlite.zst', lastModified: new Date(now.getTime() - 3 * DAY) },
      { key: 'wildloop/database/new.sqlite.zst', lastModified: new Date(now.getTime() - 40 * DAY) },
      { key: 'mail/old.tgz', lastModified: new Date(now.getTime() - 40 * DAY) },
      { key: 'wildloop/databases-other/old', lastModified: new Date(now.getTime() - 40 * DAY) },
      { key: 'wildloop/database/undated' },
    ], { prefix: 'wildloop/database', keepDays: 30 }, { now, keep: 'wildloop/database/new.sqlite.zst' })
    expect(keys).toEqual(['wildloop/database/old.sqlite.zst'])
  })
})

describe('sending a snapshot', () => {
  function snapshot(bytes: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'wildloop-offsite-'))
    const file = join(dir, 'stacks-2026-10-05T03-20-00Z.sqlite.zst')
    writeFileSync(file, Buffer.alloc(bytes, 7))
    return file
  }

  function fakeClients(stored: (written: number) => number, existing: Array<{ key: string, lastModified: Date }> = []) {
    const calls = { ensured: 0, written: [] as string[], deleted: [] as string[] }
    let size = 0
    return {
      calls,
      clients: {
        ensureBucket: async () => { calls.ensured++ },
        bucket: {
          write: async (key: string, data: any) => { calls.written.push(key); size = data.size; return size },
          size: async () => stored(size),
          list: async () => ({ contents: existing.map(o => ({ ...o, lastModified: o.lastModified.toISOString() })) }),
          delete: async (key: string) => { calls.deleted.push(key) },
        },
      } as any,
    }
  }

  it('does nothing without a credential', async () => {
    expect(await sendSnapshotOffsite(snapshot(10), {})).toEqual({ status: 'not configured' })
  })

  it('creates the bucket, uploads under the folder, checks the size and prunes', async () => {
    const now = new Date('2026-10-05T03:21:00Z')
    const { calls, clients } = fakeClients(n => n, [
      { key: 'wildloop/database/stacks-2026-08-01T03-20-00Z.sqlite.zst', lastModified: new Date(now.getTime() - 60 * DAY) },
    ])
    const report = await sendSnapshotOffsite(snapshot(2048), CREDS, { now, clients })
    expect(calls.ensured).toBe(1)
    expect(calls.written).toEqual(['wildloop/database/stacks-2026-10-05T03-20-00Z.sqlite.zst'])
    expect(report).toEqual({
      status: 'sent',
      target: 's3://stacks-production-backups/wildloop/database/stacks-2026-10-05T03-20-00Z.sqlite.zst',
      bytes: 2048,
      pruned: ['wildloop/database/stacks-2026-08-01T03-20-00Z.sqlite.zst'],
    })
    expect(calls.deleted).toEqual(report.status === 'sent' ? report.pruned : [])
  })

  it('fails when the bucket does not hold the whole file, and prunes nothing', async () => {
    const { calls, clients } = fakeClients(n => n - 1, [
      { key: 'wildloop/database/old.sqlite.zst', lastModified: new Date(0) },
    ])
    await expect(sendSnapshotOffsite(snapshot(100), CREDS, { clients })).rejects.toThrow('uploaded 100 bytes but the bucket holds 99')
    expect(calls.deleted).toEqual([])
  })
})
