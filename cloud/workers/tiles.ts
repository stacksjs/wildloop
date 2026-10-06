/**
 * https://tiles.wildloop.org: the map's tiles, cut out of the planet archive
 * in the wildloop-tiles R2 bucket and cached at Cloudflare's edge one tile at
 * a time.
 *
 * Without this the browser read the 84 GB archive with range requests straight
 * from R2, and nothing could cache pieces of a file that size: every tile went
 * back to the bucket. Here each `/{archive}/{z}/{x}/{y}.pbf` is answered once
 * from R2 and from the edge cache after that, and the archive's name (its
 * build date) is in the path, so a tile URL never changes meaning.
 *
 * Deployed by `buddy deploy` from config/cloud.ts `infrastructure.workers`.
 */
import { createTileWorker } from 'ts-maps/worker'

// A tile cut once is stored back in the bucket, and every other data center
// fetches it from tiles-origin through the CDN (tiered cache) rather than
// cutting it out of the archive again.
export default createTileWorker({
  binding: 'TILES',
  tileStore: { origin: 'https://tiles-origin.wildloop.org' },
})
