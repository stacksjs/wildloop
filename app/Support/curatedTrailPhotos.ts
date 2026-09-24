import { haversineDistance } from '../../resources/functions/geo'
import { isStockTrailPhoto } from '../../resources/functions/stock-photos'

/**
 * Small, reviewed seed of photographs depicting named trails.
 *
 * These are not generic search hits or pictures of a nearby park. Each Commons
 * file page describes the exact trail, identifies its creator, and confirms a
 * reusable license. Additions must be checked in the same way. The match also
 * requires a nearby coordinate so another trail with the same name cannot
 * inherit the photo. Database images chosen by an editor are never replaced.
 */
export const CURATED_TRAIL_PHOTOS = [
  {
    names: ['Emerald Lake Trail'],
    state: 'CO',
    lat: 40.3097,
    lng: -105.6459,
    file: 'Trail Along Dream Lake - Rocky Mountain National Park (52573617220).jpg',
    credit: 'Andrew Parlette',
    license: 'CC BY 2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
  },
  {
    names: ['Mist Trail to Vernal Fall', 'Mist Trail'],
    state: 'CA',
    lat: 37.7327,
    lng: -119.5580,
    file: 'Vernal Fall from Mist Trail, Yosemite (28920533334).jpg',
    credit: 'Fabio Achilli',
    license: 'CC BY 2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
  },
  {
    names: ['Dipsea Trail'],
    state: 'CA',
    lat: 37.8916,
    lng: -122.5460,
    file: 'Stinson Beach from Dipsea Trail in Mount Tamalpais State Park.jpg',
    credit: 'Miguel Vieira',
    license: 'CC BY 2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
  },
] as const

export interface CuratedPhotoTrail {
  name?: string | null
  state?: string | null
  latitude?: number | null
  longitude?: number | null
  image?: string | null
  [key: string]: unknown
}

function commonsFilePath(file: string): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replaceAll(' ', '_'))}?width=960`
}

function commonsFilePage(file: string): string {
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replaceAll(' ', '_'))}`
}

/** Add reviewed media only when the row still has an empty or stock cover. */
export function applyCuratedTrailPhoto<T extends CuratedPhotoTrail>(trail: T): T {
  const lat = Number(trail.latitude)
  const lng = Number(trail.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    return trail

  const name = String(trail.name ?? '').trim().toLowerCase()
  const state = String(trail.state ?? '').trim().toUpperCase()
  const seed = CURATED_TRAIL_PHOTOS.find(photo =>
    photo.state === state
    && photo.names.some(candidate => candidate.toLowerCase() === name)
    && haversineDistance({ lat, lng }, { lat: photo.lat, lng: photo.lng }) <= 8 * 1609.344,
  )
  if (!seed)
    return trail

  const seededUrl = commonsFilePath(seed.file)
  // The demo seeder stores this exact URL in the database. Attach the credit
  // again on read, but never overwrite a different image chosen by an editor.
  if (trail.image && !isStockTrailPhoto(trail.image) && trail.image !== seededUrl)
    return trail

  return {
    ...trail,
    image: seededUrl,
    coverCredit: seed.credit,
    coverSourceUrl: commonsFilePage(seed.file),
    coverLicense: seed.license,
    coverLicenseUrl: seed.licenseUrl,
  }
}
