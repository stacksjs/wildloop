import type { NativeCraft } from '@stacksjs/stx/native'
import { installNativeChrome } from './native-chrome'

type SessionHost = Pick<NativeCraft, 'secureStorage' | 'snapshots'>
const ACCOUNT_KEY = 'wildloop-account'

/** A keychain identity is useful offline only while it matches the exact bearer. */
export async function readNativeAccount(host: SessionHost): Promise<{id:number} | null> {
  const [token, raw] = await Promise.all([host.secureStorage.get('auth_token'), host.secureStorage.get(ACCOUNT_KEY)])
  try {
    const record = JSON.parse(raw ?? 'null')
    return token && record?.token === token && Number.isSafeInteger(record?.user?.id) && record.user.id > 0 ? {id:record.user.id} : null
  }
  catch { return null }
}

/** Keep credentials in the platform keychain; publish only the account to screens. */
export async function storeNativeSession(host: SessionHost, token: string, user: {id:number}): Promise<void> {
  if (!token || !Number.isSafeInteger(user?.id) || user.id < 1) throw new Error('The server returned an invalid account session.')
  await host.secureStorage.set('auth_token', token)
  await host.secureStorage.set(ACCOUNT_KEY, JSON.stringify({token,user:{id:user.id}}))
  const previous=host.snapshots.get<{version?:number}>('wildloop-session')
  // A password change rotates the bearer while keeping the same user. Warm
  // screens must invalidate their keychain read even when that identity matches.
  const version=(Number(previous?.version)||0)+1
  await host.snapshots.set('wildloop-session',{user,version})
}

export async function clearNativeSession(host: SessionHost): Promise<void> {
  await host.secureStorage.delete('auth_token')
  await host.secureStorage.delete(ACCOUNT_KEY)
  await host.snapshots.set('wildloop-session',null)
}

/**
 * The app needs an account.
 *
 * Wildloop is not browsable without one. A screen reached with no account
 * sends the viewer to Login and comes back to itself once they have signed
 * in, rather than drawing a public version of itself or parking a Sign in
 * button in an empty state. It answers `false` once it has navigated, so a
 * loader can bail on the same line.
 *
 * Three things it is careful about, each of them learned on a device:
 *
 *   - **A bearer is not an account.** Logging out revokes the token server
 *     side, and the stale one left on the device still reads as truthy — which
 *     is how Record kept letting a signed-out viewer in while Territories,
 *     which asks the server, said they were signed out. `readNativeAccount`
 *     is the test: a bearer the device still has a user for.
 *   - **Only a screen in front sends anybody anywhere.** The shell prepares
 *     the Record and Menu tabs hidden beside the Feed at launch, so a guard
 *     that ran at their mount pushed Login over the Feed. A tab root asks
 *     again from `onAppear`, when it is the screen somebody is looking at.
 *   - **The four auth screens never call this**, which is the whole reason the
 *     guard lives in the screens instead of in `startNativeApp`. A password
 *     reset opens `/password/reset/:token` with no account by design, and an
 *     app-level gate would stomp it the moment the session resolved.
 */
export async function requireNativeAccount(host: SessionHost & Pick<NativeCraft, 'navigation'>, next: string): Promise<boolean> {
  try {
    if ((await readNativeAccount(host))?.id) {
      // A signed-in screen wears the app's bar buttons and tabs; the auth
      // screens never get here, so they never do.
      installNativeChrome(host)
      return true
    }
  }
  catch {
    // Cancelled because the screen closed; there is nobody to send anywhere.
    return true
  }
  if (!host.navigation.isFocused())
    return false
  host.navigation.open(`/login?next=${encodeURIComponent(next)}`)
  return false
}
