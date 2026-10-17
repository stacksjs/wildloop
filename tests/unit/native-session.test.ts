import { describe, expect, it } from 'bun:test'
import { clearNativeSession, readNativeAccount, storeNativeSession } from '../../resources/functions/native-session'

function host() {
  const keychain=new Map<string,string>(), snapshots=new Map<string,unknown>()
  return {keychain,snapshots,host:{secureStorage:{get:async(key:string)=>keychain.get(key) ?? null,set:async(key:string,value:string)=>{keychain.set(key,value)},delete:async(key:string)=>{keychain.delete(key)}},snapshots:{get:(key:string)=>snapshots.get(key),set:async(key:string,value:unknown)=>{snapshots.set(key,value)}}} as any}
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
