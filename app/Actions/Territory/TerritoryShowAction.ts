// Auth is imported explicitly: it is not in the API server bundle's
// auto-imports (see ActivityStoreAction). Everything else is auto-imported.
//
// GET /api/territories/{id} - one live territory, shaped exactly like a
// feature from /api/territories/map.
//
// A territory page used to find its record only in whatever the map had
// last loaded. Opened from a notification, a shared link or a search result,
// the territory was usually not in that set, and the page said "Territory
// not found" for land that exists.

import { Auth } from '@stacksjs/auth'
import UserPrivacySetting from '../../Models/UserPrivacySetting'
import { territoryFeature } from '../../Support/territoryFeatures'

export default new Action({
  name: 'Territory Show',
  description: 'One live territory, as a map feature',
  method: 'GET',

  async handle(request) {
    const id = positiveInt(request.get('id'))
    if (!id)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'must be a positive integer territory id' } }, 422)

    try {
      const viewerId = (await Auth.user().catch(() => null))?.id ?? null
      const territory = await Territory.find(id)
      // Expired land is off the map, and so off this endpoint. A block hides a
      // holder's land in both directions, as it does on the map.
      const blockedIds = await blockedUserIdsFor(viewerId)
      if (!territory || !['active', 'contested'].includes(territory.status) || blockedIds.has(territory.user_id))
        return response.json({ success: false, error: 'Territory not found' }, 404)

      const [owner, ownerSettings, defences] = await Promise.all([
        territory.user_id ? User.find(territory.user_id) : null,
        territory.user_id ? UserPrivacySetting.where('user_id', '=', territory.user_id).first().catch(() => null) : null,
        TerritoryHistory.where('event_type', '=', 'defended').where('territory_id', '=', id).get(),
      ])

      const feature = territoryFeature(territory, {
        viewerId,
        owner,
        ownerSettings,
        defendCount: (defences ?? []).length,
      })
      if (!feature.geometry)
        return response.json({ success: false, error: 'Territory not found' }, 404)

      return response.json({ success: true, territory: feature })
    }
    catch (error) {
      console.error('Error fetching territory:', error)
      return response.json({ success: false, error: 'Failed to fetch territory' }, 500)
    }
  },
})
