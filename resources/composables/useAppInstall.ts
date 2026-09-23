import { onDestroy, onMount, state } from 'stx'

/**
 * Installing Wildloop on a phone.
 *
 * There is no single "install" API. What is available depends entirely on
 * where the page is running, and the honest thing is to offer each platform
 * the path that exists there rather than a button that does nothing:
 *
 *   - Chrome/Edge (Android + desktop) fire `beforeinstallprompt`. We keep the
 *     event and replay it on a click, which is the real, one-tap install.
 *   - iOS Safari has no programmatic install at all. It only has Share → Add
 *     to Home Screen, so the UI says that instead of offering a button.
 *   - Inside the native shell, or once installed, there is nothing to offer.
 *
 * `beforeinstallprompt` fires early — often before a component that wants it
 * has mounted — so the listener is installed at module load and the captured
 * event is shared. Otherwise the first page a visitor lands on eats the event
 * and the footer never learns that an install is possible.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallPlatform = 'ios' | 'android' | 'desktop' | 'native' | 'unknown'

const INSTALL_EVENT = 'wildloop:install-availability'

let deferredPrompt: BeforeInstallPromptEvent | null = null

function announce(): void {
  if (typeof globalThis !== 'undefined')
    globalThis.dispatchEvent(new CustomEvent(INSTALL_EVENT))
}

if (typeof globalThis !== 'undefined' && typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('beforeinstallprompt', (event: Event) => {
    // Chrome shows its own mini-infobar unless the page takes the event over.
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    announce()
  })

  globalThis.addEventListener('appinstalled', () => {
    deferredPrompt = null
    announce()
  })
}

/** Already running as an installed app, so there is nothing left to install. */
export function isStandalone(): boolean {
  if (typeof globalThis === 'undefined')
    return false
  const nav = globalThis.navigator as Navigator & { standalone?: boolean }
  if (nav?.standalone === true)
    return true
  return typeof globalThis.matchMedia === 'function'
    && globalThis.matchMedia('(display-mode: standalone)').matches
}

export function detectPlatform(): InstallPlatform {
  if (typeof globalThis === 'undefined')
    return 'unknown'
  if ((globalThis as { craft?: unknown }).craft)
    return 'native'

  const nav = globalThis.navigator
  if (!nav)
    return 'unknown'

  const ua = nav.userAgent ?? ''
  // iPadOS 13+ reports itself as a Mac. A Mac with a touchscreen does not
  // exist, so multi-touch plus a Mac UA is an iPad.
  const isIpadOS = /Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1
  if (/iphone|ipad|ipod/i.test(ua) || isIpadOS)
    return 'ios'
  if (/android/i.test(ua))
    return 'android'
  return 'desktop'
}

export function useAppInstall() {
  const canPrompt = state(false)
  const installed = state(false)
  const platform = state<InstallPlatform>('unknown')
  const outcome = state<'accepted' | 'dismissed' | null>(null)

  function sync() {
    installed.set(isStandalone())
    platform.set(detectPlatform())
    canPrompt.set(!!deferredPrompt && !isStandalone())
  }

  async function promptInstall() {
    const event = deferredPrompt
    if (!event)
      return
    // The event is single-use: Chrome refuses a second `prompt()` on the same
    // one. Drop it up front so a double click cannot throw.
    deferredPrompt = null
    canPrompt.set(false)
    await event.prompt().catch(() => undefined)
    const choice = await event.userChoice.catch(() => null)
    outcome.set(choice?.outcome ?? null)
    if (choice?.outcome === 'accepted')
      installed.set(true)
  }

  onMount(() => {
    sync()
    globalThis.addEventListener(INSTALL_EVENT, sync)
  })

  onDestroy(() => {
    globalThis.removeEventListener(INSTALL_EVENT, sync)
  })

  return { canPrompt, installed, platform, outcome, promptInstall }
}
