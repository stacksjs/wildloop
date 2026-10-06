/**
 * Runs ON the build server, after planetiler: checks the archive, uploads it to
 * R2 and publishes the TileJSON that points the app at it.
 *
 * Order is the whole point. The archive goes up under a key named for this
 * build (`planet/<version>.pmtiles`) and nothing reads that key until it is
 * complete; only then is tiles.json rewritten to name it. A failed or partial
 * build never reaches a single map. The previous archive stays where it was,
 * and the bucket's lifecycle rule retires it once it is a few builds old.
 *
 * Usage: bun publish.ts /root/tiles/planet.pmtiles
 * Env:   R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET TILES_PUBLIC_URL VERSION
 */
import { S3Client } from 'bun'
import { Pbf, VectorTile } from 'ts-maps'
import { PMTiles } from 'ts-maps/pmtiles'
import { FileSource } from 'ts-maps/server'

const path = process.argv[2]
if (!path)
  throw new Error('usage: bun publish.ts <archive.pmtiles>')

const env = (name: string): string => {
  const value = process.env[name]
  if (!value)
    throw new Error(`${name} is not set`)
  return value
}

const version = env('VERSION')
const publicUrl = env('TILES_PUBLIC_URL').replace(/\/$/, '')
const key = `planet/${version}.pmtiles`

// ---------- verify ----------
//
// Read the archive back through the same reader the app uses, and decode a
// tile from somewhere dense. An archive planetiler wrote but ts-maps cannot
// read, or one missing the OpenMapTiles layers the styles draw, stops here.

const file = Bun.file(path)
const archive = new PMTiles(new FileSource(path))

const header = await archive.getHeader()
const metadata = await archive.getMetadata() as { vector_layers?: unknown[], attribution?: string } | null
console.log(`archive: z${header.minZoom}-${header.maxZoom}, ${header.numAddressedTiles} tiles addressed, ${(file.size / 1e9).toFixed(1)} GB`)

// Downtown San Diego at z14: coast, roads, places and buildings in one tile.
const tile = await archive.getTileData(14, 2859, 6614)
if (!tile)
  throw new Error('no tile at 14/2859/6614: the planet build is missing land it should have')
const layers = Object.keys(new VectorTile(new Pbf(tile)).layers)
for (const required of ['water', 'transportation', 'place', 'building']) {
  if (!layers.includes(required))
    throw new Error(`tile 14/2859/6614 has no "${required}" layer (has: ${layers.join(', ')})`)
}
console.log(`check: 14/2859/6614 decodes with ${layers.length} layers`)

// ---------- upload ----------

const s3 = new S3Client({
  endpoint: env('R2_ENDPOINT'),
  region: 'auto',
  accessKeyId: env('R2_ACCESS_KEY_ID'),
  secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  bucket: env('R2_BUCKET'),
})

// Streamed in 128 MB parts, eight in flight: a 90 GB file is ~700 parts, well
// under the 10,000-part ceiling, and never held in memory.
const started = Date.now()
const writer = s3.file(key).writer({ partSize: 128 * 1024 * 1024, queueSize: 8, retry: 3, type: 'application/vnd.pmtiles' })
let sent = 0
let lastReport = 0
for await (const chunk of file.stream()) {
  await writer.write(chunk)
  sent += chunk.byteLength
  if (sent - lastReport > 5e9) {
    lastReport = sent
    console.log(`upload: ${(sent / 1e9).toFixed(0)} / ${(file.size / 1e9).toFixed(0)} GB`)
  }
}
await writer.end()
const uploaded = await s3.file(key).stat()
if (uploaded.size !== file.size)
  throw new Error(`uploaded ${uploaded.size} bytes, expected ${file.size}`)
console.log(`upload: ${key} in ${Math.round((Date.now() - started) / 60000)} min`)

// ---------- publish ----------

const tilejson = {
  tilejson: '3.0.0',
  name: 'Wildloop',
  version,
  scheme: 'xyz',
  tiles: [`pmtiles://${publicUrl}/${key}`],
  minzoom: header.minZoom,
  maxzoom: header.maxZoom,
  bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
  center: [header.centerLon, header.centerLat, header.centerZoom],
  vector_layers: metadata?.vector_layers ?? [],
  attribution: '<a href="https://openmaptiles.org/">&copy; OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright">&copy; OpenStreetMap contributors</a>',
}
await s3.file('tiles.json').write(JSON.stringify(tilejson), { type: 'application/json' })
console.log(`publish: ${publicUrl}/tiles.json → ${key}`)
