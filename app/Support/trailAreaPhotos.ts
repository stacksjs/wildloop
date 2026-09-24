import { haversineDistance } from '../../resources/functions/geo'
import { isStockTrailPhoto } from '../../resources/functions/stock-photos'

/**
 * Reviewed imagery of a trail's immediate area, not the trail itself.
 * These matches are tied to upstream NPS IDs and nearby coordinates. Never
 * substitute an island photo for a namesake trail elsewhere or for a person's
 * own cover. The UI must label these as area photos.
 */
const AREA_PHOTOS = [
  {
    sourceId: 'nps/CHIS|ARCH POINT LOOP TRAIL',
    lat: 33.48291,
    lng: -119.033499,
    file: 'Santabarbara 300.jpg',
    credit: 'Shane Anderson/NOAA',
    license: 'Public domain',
    licenseUrl: '',
    place: 'Santa Barbara Island',
  },
  {
    sourceId: 'nps/CHIS|CAVE CANYON NATURE TRAIL',
    lat: 33.479722,
    lng: -119.029021,
    file: 'Seagulls - Santa Barbara Island.JPG',
    credit: 'Brian MacIntosh',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    place: 'Santa Barbara Island',
  },
  {
    sourceId: 'nps/CHIS|ELEPHANT SEAL COVE LOOP TRAIL',
    lat: 33.480336,
    lng: -119.03819,
    file: 'Santa-Barbara-Island-Sea-Lion-Rookery.jpg',
    credit: 'National Park Service',
    license: 'Public domain',
    licenseUrl: '',
    place: 'Santa Barbara Island',
  },
  {
    sourceId: 'nps/CHIS|SIGNAL PEAK LOOP',
    lat: 33.471806,
    lng: -119.037228,
    file: 'Sutil Island - Santa Barbara Island.JPG',
    credit: 'Brian MacIntosh',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    place: 'Santa Barbara Island',
  },
] as const

interface AreaPhotoTrail {
  source?: string | null
  source_id?: string | null
  latitude?: number | null
  longitude?: number | null
  image?: string | null
  [key: string]: unknown
}

export function applyTrailAreaPhoto<T extends AreaPhotoTrail>(trail: T): T {
  if (trail.source !== 'nps' || (trail.image && !isStockTrailPhoto(trail.image)))
    return trail

  const lat = Number(trail.latitude)
  const lng = Number(trail.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    return trail

  const photo = AREA_PHOTOS.find(candidate =>
    candidate.sourceId === trail.source_id
    && haversineDistance({ lat, lng }, { lat: candidate.lat, lng: candidate.lng }) <= 4 * 1609.344,
  )
  if (!photo)
    return trail

  const file = encodeURIComponent(photo.file.replaceAll(' ', '_'))
  const sourceUrl = `https://commons.wikimedia.org/wiki/File:${file}`
  return {
    ...trail,
    image: `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=960`,
    coverCredit: photo.credit,
    coverSourceUrl: sourceUrl,
    coverLicense: photo.license,
    coverLicenseUrl: photo.licenseUrl || sourceUrl,
    coverScope: 'area',
    coverPlace: photo.place,
  }
}
