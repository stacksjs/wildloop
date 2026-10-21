/**
 * The layers a map offers to choose between, for a `Map`'s `basemap`.
 *
 * Craft draws each one natively and as well as the phone can (Apple's vector
 * map and terrain on iOS, a vector style on Android, topography with contours
 * for Outdoors), caches their tiles and shows their credit, so the app names
 * a layer and nothing more.
 */
export const nativeBasemapOptions = [
  { label: 'Outdoors', value: 'outdoors' },
  { label: 'Street', value: 'standard' },
  { label: 'Satellite', value: 'satellite' },
  { label: 'Hybrid', value: 'hybrid' },
]
