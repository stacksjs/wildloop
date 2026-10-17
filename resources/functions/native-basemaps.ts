/** The same topographic provider used by the web trail map. */
export const nativeOutdoorTiles = {
  urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Topography: Esri, USGS, NOAA, OpenStreetMap contributors',
}

export const nativeBasemapOptions = [
  { label: 'Outdoors', value: 'outdoors' },
  { label: 'Street', value: 'standard' },
  { label: 'Satellite', value: 'satellite' },
  { label: 'Hybrid', value: 'hybrid' },
]

export function nativeBasemap(value: string): { mapType: 'standard' | 'satellite' | 'hybrid', tileOverlay: typeof nativeOutdoorTiles | null } {
  return {
    mapType: value === 'satellite' || value === 'hybrid' ? value : 'standard',
    tileOverlay: value === 'outdoors' ? nativeOutdoorTiles : null,
  }
}
