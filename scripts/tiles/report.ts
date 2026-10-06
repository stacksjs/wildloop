/**
 * Runs ON the build server: writes the build's state to the bucket, where the
 * hourly check job reads it back through https://tiles.wildloop.org.
 *
 * _builds/<version>/status.json — { state, version, line, updatedAt }, where
 * `line` is the last line of the build log. Nothing secret: planetiler's
 * progress lines and this script's own `==>` steps.
 *
 * Usage: bun report.ts RUNNING|DONE|FAILED
 */
import { S3Client } from 'bun'

const state = process.argv[2] ?? 'RUNNING'
const version = process.env.VERSION ?? 'unknown'

let line = ''
try {
  const log = await Bun.file('/root/tiles/build.log').text()
  line = log.trimEnd().split('\n').pop()?.slice(0, 300) ?? ''
}
catch { /* no log yet */ }

const s3 = new S3Client({
  endpoint: process.env.R2_ENDPOINT,
  region: 'auto',
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
})

await s3.file(`_builds/${version}/status.json`).write(JSON.stringify({ state, version, line, updatedAt: new Date().toISOString() }), { type: 'application/json' })
