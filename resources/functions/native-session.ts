import type { NativeCraft } from '@stacksjs/stx/native'

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
