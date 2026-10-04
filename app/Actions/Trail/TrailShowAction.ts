import { decodeRouteParts } from '../../../resources/functions/trail-geometry'
import { withBestTrailCovers } from '../../Support/trailCovers'

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
    return response.json({
      success: true,
      trail: {
        ...trailWithCover,
        lat: trail.latitude,
        lng: trail.longitude,
        hasGeometry: decodeRouteParts(trail.geometry).length > 0,
        partOf,
      },
    })
  },
})
