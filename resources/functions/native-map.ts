import type { MapRegion } from '@stacksjs/stx/native'
import type { RoutePair } from './trail-geometry'
/** Map overlays use flat latitude/longitude pairs; calculations preserve route gaps. */
export function nativeMapParts(parts: number[][]): RoutePair[][] {
  return parts.map(part => {
    const points: RoutePair[] = []
    for (let i=0;i+1<part.length;i+=2) {
      if (Number.isFinite(part[i]) && Number.isFinite(part[i+1])) points.push([part[i],part[i+1]])
    }
    return points
  }).filter(part=>part.length>0)
}
export function nativeRouteRegion(parts: number[][], trailhead: {lat:number,lng:number}): MapRegion {
  const points=nativeMapParts(parts).flat()
  if (!points.length) return {center:{latitude:trailhead.lat,longitude:trailhead.lng},span:{latitudeDelta:0.025,longitudeDelta:0.025}}
  const lats=points.map(point=>point[0]),lngs=points.map(point=>point[1])
  const south=Math.min(...lats),north=Math.max(...lats),west=Math.min(...lngs),east=Math.max(...lngs)
  const latSpan=Math.max(0.006,(north-south)*1.3)
  return {center:{latitude:(south+north)/2,longitude:(west+east)/2},span:{latitudeDelta:latSpan,longitudeDelta:Math.max(0.006,(east-west)*1.3)}}
}
export function nativeZoomRegion(current:MapRegion,factor:number):MapRegion {
  return {center:current.center,span:{latitudeDelta:Math.max(0.0002,Math.min(120,current.span.latitudeDelta*factor)),longitudeDelta:Math.max(0.0002,Math.min(300,current.span.longitudeDelta*factor))}}
}
