import { decodeRouteParts } from '../../../resources/functions/trail-geometry'
import { listGeometry } from '../../Support/listGeometry'
import { withBestTrailCovers } from '../../Support/trailCovers'
import { withEdgeCache } from '../../Support/edgeCache'
import { wholeTrails, withWholeTrail } from '../../Support/wholeTrail'

/**
 * The most pieces whose lines a trail page draws. A trail folded from more is
 * drawn from the longest of them.
 */
const MAX_PIECE_ROUTES = 200

export default new Action({
  name: 'Trail Show',
  description: 'Get one trail with its authoritative route geometry and provenance',
  method: 'GET',
  async handle(request) {
    const trailId = positiveInt(request.get('id'))
    if (!trailId)
      return response.json({ success: false, error: 'Trail ID is required' }, 422)
    const trail = await Trail.find(trailId)
    if (!trail)
      return response.json({ success: false, error: 'Trail not found' }, 404)
    const [trailWithCover] = await withBestTrailCovers([{ ...trail }], 'display')
    // The trail this row is a piece of, when it is one (#1002). The row is
    // still answered as itself — a saved trail or an activity may point at it
    // — and a client that wants the whole trail follows this. The page does it
    // with a 301 (resources/views/trail/[id].stx).
    const parts = await db.sql`
      SELECT p.part_of FROM trail_parts p JOIN trails c ON c.id = p.part_of WHERE p.trail_id = ${trailId}
    `.execute().catch(() => []) as Array<{ part_of: number }>
    const partOf = Number(parts?.[0]?.part_of ?? 0) || null

    // A trail folded from pieces answers as the whole trail: its length and
    // ascent with the pieces', and the pieces' lines beside its own so the
    // page can draw all of it (app/Support/wholeTrail.ts). `geometry` stays
    // the row's own line, which navigation, records and downloads follow.
    const whole = (await wholeTrails([trailId])).get(trailId)
    const pieceRoutes = whole ? await pieceLines(trailId) : []

    // The same for every visitor, so the edge may keep it (app/Support/edgeCache.ts).
    return withEdgeCache(request, response.json({
      success: true,
      trail: {
        ...withWholeTrail(trailWithCover, whole),
        lat: trail.latitude,
        lng: trail.longitude,
        hasGeometry: decodeRouteParts(trail.geometry).length > 0,
        partOf,
        pieceRoutes,
      },
    }), 'detail')
  },
})

/** The lines of the rows folded into a trail, thinned as a list thins them. */
async function pieceLines(trailId: number): Promise<Array<Array<[number, number]>>> {
  const rows = await db.sql`
    SELECT t.geometry FROM trail_parts p JOIN trails t ON t.id = p.trail_id
    WHERE p.part_of = ${trailId}
    ORDER BY t.distance DESC, t.id ASC
    LIMIT ${MAX_PIECE_ROUTES}
  `.execute().catch(() => []) as Array<{ geometry: string | null }>
  return (rows ?? []).flatMap(row => decodeRouteParts(listGeometry(row.geometry)))
}
