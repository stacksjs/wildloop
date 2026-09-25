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
    return response.json({
      success: true,
      trail: {
        ...trailWithCover,
        lat: trail.latitude,
        lng: trail.longitude,
        hasGeometry: decodeRouteParts(trail.geometry).length > 0,
      },
    })
  },
})
