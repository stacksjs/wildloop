import { onDestroy, useStore } from 'stx'
import { haptics } from '@stacksjs/mobile'
import { currentUser, initializeAuthSession, isSignedIn, signOut } from '../assets/scripts/auth'
import { useActivityCatalog } from './useActivityCatalog'
import { gateSignIn, gateSignUp, goToAuthPage } from './useAuthGate'
import { useBattleFeed } from './useBattleFeed'
import { hydrateFollows, useFollows } from './useFollows'
import { hydrateNotifications, useNotifications } from './useNotifications'
import { useRunUploadQueue } from './useRunUploadQueue'
import { useTerritoryCatalog } from './useTerritoryCatalog'
import { useTrailCatalog } from './useTrailCatalog'

interface BootstrapUser {
  id: number
  email: string
  name?: string
  avatar?: string | null
  roles?: string[]
}

/** Parse the cross-bundle auth event defensively before changing shared state. */
export function authReadyUser(detail: unknown): BootstrapUser | null {
  if (!detail || typeof detail !== 'object') return null
  const user = (detail as { user?: unknown }).user
  if (!user || typeof user !== 'object') return null
  const candidate = user as Partial<BootstrapUser>
  if (!Number.isSafeInteger(candidate.id) || Number(candidate.id) <= 0 || typeof candidate.email !== 'string')
    return null
  return candidate as BootstrapUser
}

type WildLoopAppStore =
  & NonNullable<Parameters<typeof useTrailCatalog>[0]>
  & NonNullable<Parameters<typeof useTerritoryCatalog>[0]>
  & NonNullable<Parameters<typeof useActivityCatalog>[0]>
  & NonNullable<Parameters<typeof useFollows>[0]>
  & NonNullable<Parameters<typeof useNotifications>[0]>
  & NonNullable<Parameters<typeof useRunUploadQueue>[0]>
  & NonNullable<Parameters<typeof useBattleFeed>[0]>
  & {
    hydrateAuthenticatedUser: (user: BootstrapUser) => void
    clearAuthenticatedUser: () => void
    setCurrentPath?: (path: string) => void
    provideServices: (services: {
      signIn: (email: string, password: string) => Promise<string | null>
      signUp: (name: string, email: string, password: string) => Promise<string | null>
      signOut: () => Promise<void>
      openAuthPage: (mode: 'login' | 'register') => void
      tap: () => void
    }) => void
  }

function cachedUser(): BootstrapUser | null {
  if (typeof localStorage === 'undefined')
    return null
  const raw = localStorage.getItem('auth_user')
  if (!raw)
    return null
  try {
    return JSON.parse(raw) as BootstrapUser
  }
  catch {
    localStorage.removeItem('auth_user')
    return null
  }
}

async function serverUser(): Promise<BootstrapUser | null> {
  await initializeAuthSession()
  return currentUser()
}

export interface AppDataNeeds {
  activities: boolean
  battles: boolean
  follows: boolean
  territories: boolean
  trails: boolean
}

function isPath(pathname: string, routes: string[]): boolean {
  return routes.some(route => pathname === route || pathname.startsWith(`${route}/`))
}

/** Public data sources needed by a route; everything else stays network-idle. */
export function dataNeedsForPath(pathname: string): AppDataNeeds {
  return {
    activities: isPath(pathname, ['/activity', '/athlete', '/feed', '/profile', '/record', '/stats']),
    // The feed carries the "turf is being taken right now" banner.
    battles: isPath(pathname, ['/battles', '/challenges', '/conquests', '/feed', '/territories', '/territory']),
    follows: isPath(pathname, ['/athlete', '/athletes', '/feed', '/profile']),
    territories: isPath(pathname, ['/battles', '/challenges', '/conquests', '/leaderboard', '/record', '/territories', '/territory']),
    trails: isPath(pathname, ['/record', '/routes', '/trail', '/trails']),
  }
}

const STALE_SHELL_KEY = 'wildloop:stale-shell-reload'

/**
 * The store outlives in-app navigation, so a page opened before new code
 * shipped keeps its old store while the pages it navigates to run the new
 * code. When that code needs something the old store does not have, the call
 * throws and takes the whole page script with it: an app left open across a
 * deploy (or a dev-server edit) showed pages with every binding dead. Reload
 * once so the whole app comes from one version; if that did not help, carry
 * on rather than loop.
 */
function reloadStaleShellOnce(): void {
  if (typeof location === 'undefined' || typeof sessionStorage === 'undefined')
    return
  if (sessionStorage.getItem(STALE_SHELL_KEY))
    return
  sessionStorage.setItem(STALE_SHELL_KEY, '1')
  location.reload()
}

function forgetStaleShellReload(): void {
  if (typeof sessionStorage !== 'undefined')
    sessionStorage.removeItem(STALE_SHELL_KEY)
}

let identityStarted = false

/** Initialize the shared Wildloop store and its browser-side data sources. */
/**
 * Keep the store's idea of the page in step with the router, for the tab
 * bar's highlight. A tab tap on iOS is an in-app navigation, which does not
 * run this again for the page it lands on, so the router's own event does.
 */
function trackCurrentPath(wl: WildLoopAppStore, pathname: string): void {
  if (typeof wl.setCurrentPath !== 'function')
    return
  wl.setCurrentPath(pathname)
  const page = globalThis as typeof globalThis & { __wildloopTracksPath?: boolean }
  if (page.__wildloopTracksPath || typeof globalThis.addEventListener !== 'function')
    return
  page.__wildloopTracksPath = true
  globalThis.addEventListener('stx:navigate', (event: Event) => {
    const url = (event as CustomEvent<{ url?: string }>).detail?.url
    if (!url || typeof location === 'undefined')
      return
    try {
      wl.setCurrentPath?.(new URL(url, location.href).pathname)
    }
    catch {
      // A URL the router could follow is one URL can parse; nothing to do.
    }
  })
}

export function useWildLoopApp(): void {
  void initializeAuthSession()
  const wl = useStore('wl') as WildLoopAppStore
  // This bundle already carries the auth client and the native bridge; the
  // nav, the mobile header and the sign-in sheet reach them through the store
  // rather than each shipping a copy (stacksjs/stx#1957).
  if (typeof wl.provideServices === 'function') {
    forgetStaleShellReload()
    wl.provideServices({
      signIn: gateSignIn,
      signUp: gateSignUp,
      signOut,
      openAuthPage: goToAuthPage,
      tap: () => {
        void haptics.selection()
      },
    })
  }
  else {
    reloadStaleShellOnce()
  }
  const pathname = typeof location === 'undefined' ? '/' : location.pathname
  trackCurrentPath(wl, pathname)
  const localUser = cachedUser()
  const hasSession = Boolean(localUser) || isSignedIn()
  const needs = dataNeedsForPath(pathname)

  if (localUser)
    wl.hydrateAuthenticatedUser(localUser)

  if (needs.trails)
    useTrailCatalog(wl)
  if (needs.territories)
    useTerritoryCatalog(wl)
  if (needs.activities)
    useActivityCatalog(wl)
  if (needs.battles)
    useBattleFeed(wl)
  function hydrateAuthenticatedSources() {
    if (needs.follows)
      void hydrateFollows(wl)
    void hydrateNotifications(wl)
  }

  if (hasSession) {
    if (needs.follows)
      useFollows(wl)
    useNotifications(wl)
  }
  // Also mount for guests so an in-place sign-in can resume their own queue.
  useRunUploadQueue(wl)

  const onAuthReady = (event: Event) => {
    const user = authReadyUser((event as CustomEvent).detail)
    if (user) {
      wl.hydrateAuthenticatedUser(user)
      hydrateAuthenticatedSources()
    }
    else {
      wl.clearAuthenticatedUser()
    }
  }
  globalThis.addEventListener('wildloop:auth-ready', onAuthReady)
  onDestroy(() => globalThis.removeEventListener('wildloop:auth-ready', onAuthReady))

  // The server remains authoritative. Local identity only prevents a flash
  // of signed-out UI while the current bearer token is checked.
  if (identityStarted)
    return
  identityStarted = true
  serverUser().then((user) => {
    if (user) {
      wl.hydrateAuthenticatedUser(user)
      hydrateAuthenticatedSources()
    }
    else {
      wl.clearAuthenticatedUser()
    }
  })
}
