import { onUnmounted, state } from 'stx'
import { apiFetch } from '../assets/scripts/auth'
import { qrSvgMarkup } from '../functions/qr'
import { trailGpx } from '../functions/trail-map'
import type { LatLng, TrailMapHandle } from './useTrailMap'

interface ProfilePoint { mi: number, ft: number | null, lat: number, lng: number }

export function useTrailExplorer(handle: () => TrailMapHandle | null, route: () => LatLng[][], trail: () => { id: number, name: string } | null) {
  const mapMode = state<'outdoors' | 'topographic' | 'satellite' | 'street'>('outdoors')
  const layersOpen = state(false)
  const map3D = state(false)
  const reliefVisible = state(true)
  const mapMessage = state('')
  const phoneOpen = state(false)
  const profileStatus = state<'loading' | 'ready' | 'unavailable'>('loading')
  const profile = state<ProfilePoint[]>([])
  const activePoint = state<ProfilePoint | null>(null)
  let controller: AbortController | null = null
  let profileTrail = 0

  function chooseMapMode(mode: 'outdoors' | 'topographic' | 'satellite' | 'street') {
    mapMode.set(mode)
    handle()?.setBasemap(mode)
    reliefVisible.set(mode === 'outdoors')
    handle()?.setRelief(reliefVisible())
  }

  function toggle3D() {
    map3D.set(!map3D())
    handle()?.set3D(map3D())
  }

  function toggleRelief() {
    reliefVisible.set(!reliefVisible())
    handle()?.setRelief(reliefVisible())
  }

  function fitRoute() {
    handle()?.fitPoints(route().flat(), [48, 48])
  }

  async function fullscreenMap() {
    const element = document.getElementById('trail-map-explorer')
    try {
      if (document.fullscreenElement)
        await document.exitFullscreen()
      else if (element?.requestFullscreen)
        await element.requestFullscreen()
      else
        mapMessage.set('Full screen is unavailable in this browser.')
    }
    catch {
      mapMessage.set('Full screen could not be opened.')
    }
  }

  function downloadGpx() {
    const current = trail()
    if (!current || !route().some(part => part.length > 1)) {
      mapMessage.set('This trail has no recorded route to download.')
      return
    }
    const url = URL.createObjectURL(new Blob([trailGpx(current.name, route())], { type: 'application/gpx+xml' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${current.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.gpx`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function printMap() {
    window.print()
  }

  function phoneCode(): string {
    const current = trail()
    return current ? qrSvgMarkup(`https://wildloop.org/trail/${current.id}`, { title: 'Scan to open this trail on your phone', class: 'h-52 w-52' }) : ''
  }

  async function loadProfile(id: number) {
    if (profileTrail === id)
      return
    profileTrail = id
    controller?.abort()
    const request = new AbortController()
    controller = request
    profile.set([])
    activePoint.set(null)
    profileStatus.set('loading')
    try {
      const response = await apiFetch(`/api/trails/${id}/profile`, { signal: request.signal })
      const body = response.ok ? await response.json() : null
      if (request.signal.aborted)
        return
      if (!body?.success || !Array.isArray(body.points) || !body.points.some((p: ProfilePoint) => Number.isFinite(p.ft))) {
        profileStatus.set('unavailable')
        return
      }
      profile.set(body.points)
      profileStatus.set('ready')
    }
    catch {
      if (!request.signal.aborted)
        profileStatus.set('unavailable')
    }
  }

  function profileRange() {
    const values = profile().map(p => p.ft).filter((ft): ft is number => ft !== null && Number.isFinite(ft))
    return { low: Math.min(...values), high: Math.max(...values), miles: profile().at(-1)?.mi ?? 0 }
  }

  function profilePath(): string {
    const { low, high, miles } = profileRange()
    const paths: string[] = []
    let segment: string[] = []
    for (const point of profile()) {
      if (point.ft === null) {
        if (segment.length)
          paths.push(`M${segment.join(' L')}`)
        segment = []
        continue
      }
      const x = 8 + point.mi / (miles || 1) * 984
      const y = 92 - (point.ft - low) / (high - low || 1) * 76
      segment.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    if (segment.length)
      paths.push(`M${segment.join(' L')}`)
    return paths.join(' ')
  }

  function inspectProfile(event: Event) {
    const index = Number((event.target as HTMLInputElement).value)
    const point = profile()[index]
    if (!point)
      return
    activePoint.set(point)
    handle()?.map.panTo([point.lat, point.lng])
  }

  onUnmounted(() => controller?.abort())
  return { mapMode, layersOpen, map3D, reliefVisible, mapMessage, phoneOpen, profileStatus, profile, activePoint, chooseMapMode, toggle3D, toggleRelief, fitRoute, fullscreenMap, downloadGpx, printMap, phoneCode, loadProfile, profileRange, profilePath, inspectProfile }
}
