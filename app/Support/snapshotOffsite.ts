import { S3Client } from 'bun'
import { createObjectStorageClient, providerEndpoint } from '@stacksjs/ts-cloud'

/**
 * The nightly snapshot, sent off the box to Hetzner Object Storage.
 *
 * A snapshot on the same disk as the database survives a bad migration and
 * not the loss of the disk. This copies each one to a bucket in another
 * Hetzner location (Helsinki by default, while the box is in Falkenstein), so
 * losing the box, or its whole site, leaves last night's copy.
 *
 * Layout follows the mail backup (stacks-production-s3-backups/restic-mail on
 * AWS): one bucket for the stack's backups, a folder per thing backed up.
 *
 *   HETZNER_S3_ACCESS_KEY      the project's S3 credential (Hetzner Console,
 *   HETZNER_S3_SECRET_KEY      Security > S3 credentials). Both, or nothing
 *                              is sent and the command says so.
 *   DB_SNAPSHOT_S3_BUCKET      default stacks-production-backups
 *   DB_SNAPSHOT_S3_PREFIX      default wildloop/database
 *   DB_SNAPSHOT_S3_REGION      default hel1 (fsn1, nbg1, hel1)
 *   DB_SNAPSHOT_S3_KEEP_DAYS   default 30
 *
 * The keys are named for Hetzner on purpose. The environment already holds
 * AWS keys for photo uploads, and an S3 client left to find credentials on
 * its own would send those to Hetzner and be refused.
 *
 * The same shape as ts-backups' S3 destination (credentials, streamed
 * upload, size check, keepDays), which is where this belongs once ts-backups
 * is on npm. Until then ts-backups cannot be installed, so it is done here.
 */

export interface OffsiteDestination {
  bucket: string
  prefix: string
  region: string
  endpoint: string
  keepDays: number
  credentials: { accessKeyId: string, secretAccessKey: string }
}

export type OffsiteReport =
  | { status: 'not configured' }
  | { status: 'sent', target: string, bytes: number, pruned: string[] }

type Env = Record<string, string | undefined>

/** Where snapshots go, or null when no Hetzner credential is configured. */
export function offsiteDestination(env: Env): OffsiteDestination | null {
  const accessKeyId = env.HETZNER_S3_ACCESS_KEY?.trim()
  const secretAccessKey = env.HETZNER_S3_SECRET_KEY?.trim()
  if (!accessKeyId || !secretAccessKey)
    return null

  const region = env.DB_SNAPSHOT_S3_REGION?.trim() || 'hel1'
  const keepDays = Math.floor(Number(env.DB_SNAPSHOT_S3_KEEP_DAYS))
  return {
    bucket: env.DB_SNAPSHOT_S3_BUCKET?.trim() || 'stacks-production-backups',
    prefix: (env.DB_SNAPSHOT_S3_PREFIX?.trim() || 'wildloop/database').replace(/^\/+|\/+$/g, ''),
    region,
    endpoint: `https://${providerEndpoint('hetzner', region)}`,
    keepDays: keepDays > 0 ? keepDays : 30,
    credentials: { accessKeyId, secretAccessKey },
  }
}

/** Objects under the prefix older than keepDays, never the one just written. */
export function keysToPrune(
  objects: Array<{ key?: string, lastModified?: string | Date }>,
  destination: Pick<OffsiteDestination, 'prefix' | 'keepDays'>,
  options: { now: Date, keep: string },
): string[] {
  const prefix = `${destination.prefix}/`
  const cutoff = options.now.getTime() - destination.keepDays * 86_400_000
  return objects
    .filter(object => object.key && object.key !== options.keep && object.key.startsWith(prefix))
    .filter((object) => {
      const modified = object.lastModified ? new Date(object.lastModified).getTime() : Number.NaN
      return Number.isFinite(modified) && modified < cutoff
    })
    .map(object => object.key as string)
}

export interface OffsiteClients {
  /** Bun's S3 client for the bucket: streamed writes, size, list, delete. */
  bucket: Pick<S3Client, 'write' | 'size' | 'list' | 'delete'>
  /** Creates the bucket the first time. */
  ensureBucket: () => Promise<void>
}

function clientsFor(destination: OffsiteDestination): OffsiteClients {
  return {
    bucket: new S3Client({
      bucket: destination.bucket,
      region: destination.region,
      endpoint: destination.endpoint,
      accessKeyId: destination.credentials.accessKeyId,
      secretAccessKey: destination.credentials.secretAccessKey,
    }),
    async ensureBucket() {
      const admin = createObjectStorageClient({
        provider: 'hetzner',
        region: destination.region,
        credentials: destination.credentials,
      })
      if (!(await admin.bucketExists(destination.bucket)))
        await admin.createBucket(destination.bucket)
    },
  }
}

/**
 * Send one finished snapshot. Throws when the copy did not arrive whole: a
 * nightly job that reported success with nothing in the bucket is the belief
 * this exists to correct.
 */
export async function sendSnapshotOffsite(
  file: string,
  env: Env,
  options: { now?: Date, clients?: OffsiteClients } = {},
): Promise<OffsiteReport> {
  const destination = offsiteDestination(env)
  if (!destination)
    return { status: 'not configured' }

  const clients = options.clients ?? clientsFor(destination)
  await clients.ensureBucket()

  const name = file.split('/').pop() as string
  const key = `${destination.prefix}/${name}`
  const local = Bun.file(file)
  const bytes = local.size

  // The file, not its bytes: Bun streams it up in parts, so a 400 MB
  // snapshot never has to fit in the memory of the box taking it.
  await clients.bucket.write(key, local)
  const stored = await clients.bucket.size(key)
  if (stored !== bytes)
    throw new Error(`uploaded ${bytes} bytes but the bucket holds ${stored}`)

  const listing = await clients.bucket.list({ prefix: `${destination.prefix}/`, maxKeys: 1000 })
  const pruned = keysToPrune(listing.contents ?? [], destination, { now: options.now ?? new Date(), keep: key })
  for (const old of pruned)
    await clients.bucket.delete(old)

  return { status: 'sent', target: `s3://${destination.bucket}/${key}`, bytes, pruned }
}
