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

/**
 * Craft's Android shell, which is conclusive on its own.
 *
 * Android adds the `CraftAndroid` interface before the page starts, but only
 * installs `window.craft` once the page has finished loading, images and all.
 * On a heavy page (the landing page) or a slow phone that was past the
 * timeout below, so the app stayed on the website's landing page with the
 * website's chrome. Only the app's WebView has this interface.
 */
function isAndroidShell(): boolean {
  return typeof globalThis !== 'undefined' && Boolean((globalThis as typeof globalThis & { CraftAndroid?: unknown }).CraftAndroid)
}

/**
 * Craft's iOS shell, for the same reason: it installs `window.craft` when the
 * page finishes loading too, and on a slow start that missed the timeout just
 * as often. Its message handler is there from the start, but Craft's macOS
 * desktop windows have one as well, so an iPhone or iPad user agent is what
 * makes it the phone app.
 */
function isIosShell(): boolean {
  if (typeof globalThis === 'undefined')
    return false
  const host = globalThis as typeof globalThis & { webkit?: { messageHandlers?: { craft?: unknown } } }
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return Boolean(host.webkit?.messageHandlers?.craft) && /iPhone|iPad|iPod/.test(agent)
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

  if (craftInstalled() || isAndroidShell() || isIosShell())
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
