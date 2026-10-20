import { describe, expect, it } from 'bun:test'
import { clearNativeSession, readNativeAccount, requireNativeAccount, storeNativeSession } from '../../resources/functions/native-session'

function host(focused=true) {
  const keychain=new Map<string,string>(), snapshots=new Map<string,unknown>(), opened:string[]=[]
  return {keychain,snapshots,opened,host:{secureStorage:{get:async(key:string)=>keychain.get(key) ?? null,set:async(key:string,value:string)=>{keychain.set(key,value)},delete:async(key:string)=>{keychain.delete(key)}},snapshots:{get:(key:string)=>snapshots.get(key),set:async(key:string,value:unknown)=>{snapshots.set(key,value)}},navigation:{open:(path:string)=>{opened.push(path)},isFocused:()=>focused}} as any}
}
describe('native account identity across offline recovery',()=>{
  it('stores the bearer in keychain and publishes only the user',async()=>{
    const state=host()
    await storeNativeSession(state.host,'token-7',{id:7})
    expect(await readNativeAccount(state.host)).toEqual({id:7})
    expect(state.snapshots.get('wildloop-session')).toEqual({user:{id:7},version:1})
    expect(JSON.stringify(state.snapshots.get('wildloop-session'))).not.toContain('token-7')
  })
  it('refuses stale identity after a bearer changes or disappears',async()=>{
    const state=host()
    await storeNativeSession(state.host,'token-7',{id:7})
    state.keychain.set('auth_token','token-8')
    expect(await readNativeAccount(state.host)).toBeNull()
    await clearNativeSession(state.host)
    expect(await readNativeAccount(state.host)).toBeNull()
    expect(state.snapshots.get('wildloop-session')).toBeNull()
    expect(state.keychain.size).toBe(0)
  })
  it('cannot recover a malformed or missing account',async()=>{
    const state=host()
    state.keychain.set('auth_token','token-7');state.keychain.set('wildloop-account','invalid JSON')
    expect(await readNativeAccount(state.host)).toBeNull()
    await expect(storeNativeSession(state.host,'token',{id:0})).rejects.toThrow('invalid account session')
  })
  it('changes the public session version when the same account receives a new bearer',async()=>{
    const state=host()
    await storeNativeSession(state.host,'old-bearer',{id:7})
    const before=JSON.stringify(state.snapshots.get('wildloop-session'))
    await storeNativeSession(state.host,'new-bearer',{id:7})
    expect(JSON.stringify(state.snapshots.get('wildloop-session'))).not.toBe(before)
    expect(state.snapshots.get('wildloop-session')).toEqual({user:{id:7},version:2})
    expect(await readNativeAccount(state.host)).toEqual({id:7})
  })
})

/**
 * The gate: Wildloop needs an account, so a screen without one sends the
 * viewer to Login rather than drawing a public version of itself.
 */
describe('requiring an account before a screen draws',()=>{
  it('lets an account through and opens nothing',async()=>{
    const state=host()
    await storeNativeSession(state.host,'token-7',{id:7})
    expect(await requireNativeAccount(state.host,'/stats')).toBe(true)
    expect(state.opened).toEqual([])
  })
  /*
   * A bearer is not an account. Logging out revokes the token server side and
   * the stale one left on the device still reads as truthy, which is how
   * Record kept letting a signed-out viewer in.
   */
  it('refuses a bearer the device has no user for',async()=>{
    const state=host()
    state.keychain.set('auth_token','orphan-token')
    expect(await requireNativeAccount(state.host,'/stats')).toBe(false)
    expect(state.opened).toEqual(['/login?next=%2Fstats'])
  })
  it('returns the viewer to where they were going, query and all',async()=>{
    const state=host()
    expect(await requireNativeAccount(state.host,'/trails?list=mine')).toBe(false)
    expect(state.opened).toEqual(['/login?next=%2Ftrails%3Flist%3Dmine'])
  })
  /*
   * The shell prepares the Record and Menu tabs hidden beside the Feed at
   * launch. A guard that navigated from there pushed Login over the Feed.
   */
  it('sends nobody anywhere from a screen that is not in front',async()=>{
    const state=host(false)
    expect(await requireNativeAccount(state.host,'/menu')).toBe(false)
    expect(state.opened).toEqual([])
  })
  it('stands aside when the keychain read was cancelled by the screen closing',async()=>{
    const state=host()
    state.host.secureStorage.get=async()=>{throw new Error('screen closed')}
    expect(await requireNativeAccount(state.host,'/menu')).toBe(true)
    expect(state.opened).toEqual([])
  })
})
