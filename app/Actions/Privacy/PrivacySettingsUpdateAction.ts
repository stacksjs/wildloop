import { Auth } from '@stacksjs/auth'

import { settingsResponse } from './PrivacySettingsShowAction'
import UserPrivacySetting from '../../Models/UserPrivacySetting'

const VISIBILITIES = ['public', 'followers', 'private']

/** A field the request did not mention, as distinct from one it set to nothing. */
const ABSENT = Symbol('absent')
/** A field the request set to something it cannot be. */
const INVALID = Symbol('invalid')

function readNumber(value: unknown, min: number, max: number): number | null | typeof ABSENT | typeof INVALID {
  if (value === undefined)
    return ABSENT
  if (value === null || value === '')
    return null
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : INVALID
}

function readBoolean(value: unknown): boolean | typeof ABSENT | typeof INVALID {
  if (value === undefined)
    return ABSENT
  if (value === true || value === 'true' || value === 1 || value === '1')
    return true
  if (value === false || value === 'false' || value === 0 || value === '0')
    return false
  return INVALID
}

/**
 * PATCH /api/privacy-settings — change some of an athlete's privacy settings.
 *
 * A PATCH: what the request names changes, and nothing else does. It used to
 * answer 422 for any field left out, and — had it not — would have reset
 * every field left out to its default: a request that only turned on precise
 * territories would have cleared the athlete's home zone, which is what keeps
 * the game away from where they live.
 */
export default new Action({
  name: 'Privacy Settings Update',
  description: 'Update activity defaults, endpoint masking, and home-zone safety',
  method: 'PATCH',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const existing = await UserPrivacySetting.where('user_id', '=', user.id).first()
    // What is stored, or the defaults the show action reports for nobody yet.
    const current = settingsResponse(existing)

    const visibilityRaw = request.get<string>('default_activity_visibility')
    const hideMeters = readNumber(request.get('hide_start_end_meters'), 0, 5000)
    const homeLat = readNumber(request.get('home_lat'), -90, 90)
    const homeLng = readNumber(request.get('home_lng'), -180, 180)
    const homeRadius = readNumber(request.get('home_radius_meters'), 100, 5000)
    const excludeHome = readBoolean(request.get('exclude_home_from_game'))
    const precise = readBoolean(request.get('show_precise_territories'))

    const fields: Record<string, string> = {}
    if (visibilityRaw !== undefined && !VISIBILITIES.includes(visibilityRaw))
      fields.default_activity_visibility = 'must be public, followers, or private'
    if (hideMeters === INVALID || hideMeters === null)
      fields.hide_start_end_meters = 'must be between 0 and 5000 metres'
    if (homeLat === INVALID)
      fields.home_lat = 'must be a latitude between -90 and 90'
    if (homeLng === INVALID)
      fields.home_lng = 'must be a longitude between -180 and 180'
    if (homeRadius === INVALID || homeRadius === null)
      fields.home_radius_meters = 'must be between 100 and 5000 metres'
    if (excludeHome === INVALID)
      fields.exclude_home_from_game = 'must be true or false'
    if (precise === INVALID)
      fields.show_precise_territories = 'must be true or false'
    // A home is a point: one half of it moved or cleared without the other is
    // somewhere the athlete does not live.
    if ((homeLat === ABSENT) !== (homeLng === ABSENT) || (homeLat === null) !== (homeLng === null))
      fields.home = 'home latitude and longitude must be set or cleared together'
    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    const pick = <T>(value: T | typeof ABSENT | typeof INVALID, fallback: T): T =>
      value === ABSENT || value === INVALID ? fallback : value

    const values = {
      user_id: user.id,
      default_activity_visibility: visibilityRaw ?? current.defaultActivityVisibility,
      hide_start_end_meters: pick(hideMeters, current.hideStartEndMeters),
      home_lat: pick(homeLat, current.homeLat),
      home_lng: pick(homeLng, current.homeLng),
      home_radius_meters: pick(homeRadius, current.homeRadiusMeters),
      exclude_home_from_game: pick(excludeHome, current.excludeHomeFromGame),
      show_precise_territories: pick(precise, current.showPreciseTerritories),
    }
    const saved = existing
      ? await UserPrivacySetting.forceUpdate(existing.id, values)
      : await UserPrivacySetting.forceCreate(values)
    return response.json({ success: true, settings: settingsResponse(saved) })
  },
})
