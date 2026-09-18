/**
 * Whether this page is running inside the native shell — asked at a moment
 * when the answer is true.
 *
 * `isNativeMobile()` reads a global that Craft installs *after* the document
 * starts, so anything that asks at setup or on mount gets `false` on iPhone
 * and then never asks again. That is how the app kept rendering the website's
 * header and its marketing landing page: both decisions were made a few
 * hundred milliseconds too early.
 *
 * The host itself is detectable straight away — the WebView carries the
 * message handler even before the bridge finishes installing — so this waits
 * for `craftReady` only when there is a host to wait for, and answers `false`
 * immediately in a browser.
 */

/** A shell is present when any of Craft's transports exist, bridge or not. */
function hasCraftHost(): boolean {
  if (typeof globalThis === 'undefined')
    return false

  const host = globalThis as typeof globalThis & {
    CraftAndroid?: unknown
    craft?: unknown
    webkit?: { messageHandlers?: { craft?: unknown } }
  }

  return Boolean(host.craft || host.CraftAndroid || host.webkit?.messageHandlers?.craft)
}

/** The bridge, once it has finished installing. */
function craftInstalled(): boolean {
  return typeof globalThis !== 'undefined' && Boolean((globalThis as typeof globalThis & { craft?: unknown }).craft)
}

/**
 * Resolves true inside the native shell, false in a browser.
 *
 * The timeout is a floor, not a guess at how long installation takes: a host
 * that never fires `craftReady` would otherwise leave a caller waiting for a
 * decision it has to make to render anything.
 */
export function nativeShellReady(timeoutMs = 2000): Promise<boolean> {
  if (!hasCraftHost())
    return Promise.resolve(false)

  if (craftInstalled())
    return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const done = () => {
      if (timer !== undefined)
        clearTimeout(timer)
      globalThis.removeEventListener('craftReady', done)
      resolve(craftInstalled())
    }

    globalThis.addEventListener('craftReady', done, { once: true })
    timer = setTimeout(done, timeoutMs)
  })
}

/**
 * Run `fn` once the shell's answer is known, and only when it is true.
 *
 * For the callers that just want to do something native-only without carrying
 * a promise through their own setup.
 */
export function whenNativeShell(fn: () => void): void {
  void nativeShellReady().then((native) => {
    if (native)
      fn()
  })
}
