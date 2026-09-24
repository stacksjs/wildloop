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
        hasGeometry: parseTrailGeometryForApi(trail.geometry).length >= 2,
      },
    })
  },
})

function parseTrailGeometryForApi(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}
