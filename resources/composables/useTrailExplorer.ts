import { useEventListener, useFullscreen } from '@stacksjs/composables'
import { onUnmounted, state } from 'stx'
import { apiFetch } from '../assets/scripts/auth'
import { qrSvgMarkup } from '../functions/qr'
import { trailGpx } from '../functions/trail-map'
import { trailProfilePath, trailProfileRange, type TrailProfilePoint as ProfilePoint } from '../functions/trail-profile'
import type { LatLng, TrailMapHandle } from './useTrailMap'

export function useTrailExplorer(handle: () => TrailMapHandle | null, route: () => LatLng[][], trail: () => { id: number, name: string } | null) {
  const mapMode = state<'outdoors' | 'topographic' | 'satellite' | 'street'>('outdoors')
  const layersOpen = state(false)
  const map3D = state(false)
  const reliefVisible = state(true)
  const mapMessage = state('')
  const phoneOpen = state(false)
  const profileOpen = state(true)
  const printPreparing = state(false)
  const { isFullscreen, isSupported: fullscreenSupported, toggle: toggleFullscreen } = useFullscreen(() => document.getElementById('trail-map-explorer'))
  const profileStatus = state<'loading' | 'ready' | 'unavailable'>('loading')
  const profile = state<ProfilePoint[]>([])
  const activePoint = state<ProfilePoint | null>(null)
  let controller: AbortController | null = null
  let profileTrail = 0
  let printCamera: { lat: number, lng: number, zoom: number, pitch: number, bearing: number } | null = null
  let disposed = false

  const printTarget = typeof window === 'undefined' ? null : window
  function preparePrintCamera() {
    const map = handle()?.map
    if (!map) return
    const center = map.getCenter()
    printCamera ??= { lat: center.lat, lng: center.lng, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }
    map.setPitch(0)
    map.setBearing(0)
    map.invalidateSize({ animate: false })
    const points = route().flat()
    const height = document.getElementById('trail-elevation-card')?.getBoundingClientRect().height ?? 180
    if (points.length > 1) map.fitBounds(points, { paddingTopLeft: [36, 36], paddingBottomRight: [36, height + 36], animate: false })
  }
  function restorePrintCamera() {
    const camera = printCamera
    printCamera = null
    printPreparing.set(false)
    requestAnimationFrame(() => {
      const map = handle()?.map
      if (disposed || !map || !camera) return
      map.invalidateSize({ animate: false })
      map.setView([camera.lat, camera.lng], camera.zoom, { animate: false })
      map.setPitch(camera.pitch)
      map.setBearing(camera.bearing)
    })
  }
  useEventListener(printTarget, 'beforeprint', () => {
    // The toolbar/keyboard flow already fitted and loaded this viewport.
    // Resetting it inside beforeprint restarts tile loading during capture.
    if (!printPreparing()) preparePrintCamera()
  })
  useEventListener(printTarget, 'afterprint', restorePrintCamera)
  useEventListener(printTarget, 'keydown', (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      void printMap()
    }
  })

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
    activePoint.set(null)
    handle()?.highlightPoint(null)
    fitRouteViewport()
  }

  function fitRouteViewport() {
    const points = route().flat()
    if (points.length < 2) {
      mapMessage.set('This trail has no recorded route to fit. The map shows its trailhead.')
      return
    }
    const card = document.getElementById('trail-elevation-card')
    const height = card?.getBoundingClientRect().height ?? 180
    handle()?.fitPoints(points, { topLeft: [56, 60], bottomRight: [56, height + 56] })
  }

  async function fullscreenMap() {
    mapMessage.set('')
    if (!fullscreenSupported.value) {
      mapMessage.set('Full screen is unavailable in this browser.')
      return
    }
    const wasFullscreen = isFullscreen.value
    await toggleFullscreen()
    if (isFullscreen.value === wasFullscreen)
      mapMessage.set('Full screen could not be changed. Try again from the map button.')
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

  async function printMap() {
    if (printPreparing()) return
    mapMessage.set('')
    printPreparing.set(true)
    try {
      // Lay out the actual print viewport before opening the blocking browser
      // dialog. beforeprint cannot await newly requested map tiles.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (disposed || !handle()) return
      preparePrintCamera()
      const deadline = Date.now() + 15000
      let ready = false
      while (!disposed && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
        const map = handle()?.map
        if (!map) break
        let loading = !map.isStyleLoaded()
        map.eachLayer(layer => {
          if ('isLoading' in layer && typeof layer.isLoading === 'function' && layer.isLoading()) loading = true
        })
        if (!loading) { ready = true; break }
      }
      if (disposed) return
      if (!ready) throw new Error('The map is still loading. Please try printing again.')
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      window.print()
    }
    catch (cause) { mapMessage.set(cause instanceof Error ? cause.message : 'The map could not be prepared for printing.') }
    finally { restorePrintCamera() }
  }

  function phoneCode(): string {
    const current = trail()
    return current ? qrSvgMarkup(`https://wildloop.org/trail/${current.id}`, { title: 'Scan to open this trail on your phone', class: 'h-40 w-40 sm:h-52 sm:w-52' }) : ''
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
      requestAnimationFrame(fitRoute)
    }
    catch {
      if (!request.signal.aborted)
        profileStatus.set('unavailable')
    }
  }

  function profileRange() {
    return trailProfileRange(profile())
  }

  function profilePath(): string {
    return trailProfilePath(profile())
  }

  function toggleProfile() {
    profileOpen.set(!profileOpen())
    requestAnimationFrame(fitRouteViewport)
  }

  function showProfilePoint(index: number) {
    const point = profile()[Math.max(0, Math.min(profile().length - 1, Math.round(index)))]
    if (!point) return
    activePoint.set(point)
    handle()?.highlightPoint([point.lat, point.lng])
  }

  function hoverProfile(event: PointerEvent) {
    if (event.pointerType !== 'mouse') return
    const box = (event.currentTarget as SVGElement).getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * 1000 - 8) / 984))
    const mi = ratio * profileRange().miles
    let closest = 0
    for (let i = 1; i < profile().length; i++) {
      if (Math.abs(profile()[i].mi - mi) < Math.abs(profile()[closest].mi - mi)) closest = i
    }
    showProfilePoint(closest)
  }

  function profileCursor() {
    const point = activePoint()
    const range = profileRange()
    return point ? { x: 8 + point.mi / (range.miles || 1) * 984, y: point.ft === null ? null : 92 - (point.ft - range.low) / (range.high - range.low || 1) * 76 } : null
  }

  function inspectProfile(event: Event) {
    const index = Number((event.target as HTMLInputElement).value)
    showProfilePoint(index)
  }

  onUnmounted(() => { disposed = true; controller?.abort() })
  return { profileOpen, printPreparing, toggleProfile, hoverProfile, profileCursor, isFullscreen, mapMode, layersOpen, map3D, reliefVisible, mapMessage, phoneOpen, profileStatus, profile, activePoint, chooseMapMode, toggle3D, toggleRelief, fitRoute, fullscreenMap, downloadGpx, printMap, phoneCode, loadProfile, profileRange, profilePath, inspectProfile }
}
