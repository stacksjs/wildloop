import { onDestroy, onMount } from 'stx'
import { deepLinks, device, isNativeMobile, onMobileReady, pushNotifications, secureStorage } from '@stacksjs/mobile'
import { beforeSignOut, readyToken } from '../assets/scripts/auth'
import { donateSiriPhrases, onAppShortcut, registerAppShortcuts } from './useNativeShortcuts'

const PUSH_ENABLED_KEY = 'wildloop_push_enabled'
const PUSH_TOKEN_KEY = 'wildloop_push_token'

type NativeDeepLink = string | { url?: unknown }

function deepLinkURL(value: NativeDeepLink): string | null {
  if (typeof value === 'string') return value
  return typeof value?.url === 'string' ? value.url : null
}

export function deepLinkPath(value: NativeDeepLink): string | null {
  try {
    const rawURL = deepLinkURL(value)
    if (!rawURL || (!rawURL.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(rawURL))) return null
    const url = new URL(rawURL, 'https://wildloop.org')
    if (url.hostname !== 'wildloop.org' && url.protocol !== 'wildloop:') return null
    if (url.protocol !== 'wildloop:') return `${url.pathname}${url.search}${url.hash}` || '/'

    const route = `${url.host}/${url.pathname}`.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
    return `/${route}${url.search}${url.hash}`
  }
  catch {
    return null
  }
}

function openDeepLink(value: NativeDeepLink): void {
  const path = deepLinkPath(value)
  if (!path || typeof location === 'undefined') return
  const current = `${location.pathname}${location.search}${location.hash}`
  if (current.replace(/\/$/, '') === path.replace(/\/$/, '')) return
  location.assign(path)
}

/** Register only after the person has opted in from Settings. */
export async function enableNativePushNotifications(): Promise<boolean> {
  if (!isNativeMobile()) return false
  const bearer = await readyToken()
  if (!bearer) return false
  const [pushToken, info] = await Promise.all([
    pushNotifications.register(),
    device.getInfo(),
  ])
  const response = await fetch('/api/notifications/push-token', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: pushToken,
      platform: info.platform,
      device_id: info.deviceId,
      environment: location.hostname === 'wildloop.org' ? 'production' : 'development',
    }),
  })
  if (!response.ok) return false
  await Promise.all([
    secureStorage.set(PUSH_ENABLED_KEY, 'true'),
    secureStorage.set(PUSH_TOKEN_KEY, pushToken),
  ])
  return true
}

/** Stop delivery to this device and clear the local opt-in. */
export async function disableNativePushNotifications(): Promise<boolean> {
  if (!isNativeMobile()) return false
  const [bearer, pushToken] = await Promise.all([
    readyToken(),
    secureStorage.get(PUSH_TOKEN_KEY),
  ])
  if (!bearer || !pushToken) {
    await Promise.all([
      secureStorage.delete(PUSH_ENABLED_KEY),
      secureStorage.delete(PUSH_TOKEN_KEY),
    ])
    return true
  }
  const response = await fetch('/api/notifications/push-token', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: pushToken }),
  })
  if (!response.ok) return false
  await Promise.all([
    secureStorage.delete(PUSH_ENABLED_KEY),
    secureStorage.delete(PUSH_TOKEN_KEY),
  ])
  return true
}

// Signing out stops this device receiving the athlete's notifications. It has
// to run before the token is revoked: unregistering needs the session.
beforeSignOut(() => disableNativePushNotifications())

async function syncOptedInNativePushNotifications(): Promise<void> {
  if (await secureStorage.get(PUSH_ENABLED_KEY).catch(() => null) !== 'true') return
  await enableNativePushNotifications().catch(() => false)
}

export function useNativeServices(): void {
  let removeReady: (() => void) | null = null
  let removeLink: (() => void) | null = null
  let removeNotification: (() => void) | null = null
  let removeShortcut: (() => void) | null = null

  onMount(() => {
    removeReady = onMobileReady(async () => {
      if (!isNativeMobile()) return
      const initial = await deepLinks.getInitialURL().catch(() => null)
      if (initial) openDeepLink(initial)
      removeLink = deepLinks.onLink(openDeepLink)
      removeNotification = pushNotifications.onNotification((payload) => {
        const link = typeof payload.link === 'string' ? payload.link : null
        if (link) openDeepLink(link)
      })

      // A tapped shortcut is a route, and `navigate` is the same trip a deep
      // link takes — the two paths cannot diverge.
      removeShortcut = onAppShortcut((route) => {
        if (typeof location !== 'undefined') location.assign(route)
      })

      // The home-screen menu is set per launch rather than per install: the
      // list can change with a release, and the Siri donations expire.
      // Neither is awaited before the rest of the app starts, and neither can
      // fail it — see useNativeShortcuts for the guards.
      void registerAppShortcuts()
      void donateSiriPhrases()

      await syncOptedInNativePushNotifications()
    })
  })

  onDestroy(() => {
    removeReady?.()
    removeLink?.()
    removeNotification?.()
    removeShortcut?.()
  })
}
