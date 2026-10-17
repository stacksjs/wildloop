import type { NativeCraft } from '@stacksjs/stx/native'
import { createNativeApi, nativeApiOrigin } from './native-api'
import { readNativeAccount, storeNativeSession } from './native-session'
import { nativeDestination, nativeShortcutDestination } from './native-destinations'

/** Application-wide session and opted-in push work, beside Craft's native screens. */
export function startNativeApp(host: NativeCraft): () => void {
  let alive=true
  let refreshing=false
  let registering=false
  const api=createNativeApi(host)
  const shortcut=(event:Event)=>{const route=nativeShortcutDestination((event as CustomEvent).detail);if(route)host.navigation.open(route)}
  const notification=(event:Event)=>{const detail=(event as CustomEvent).detail;const route=nativeDestination(detail?.href ?? detail?.url ?? detail?.data?.href);if(route)host.navigation.open(route)}
  globalThis.addEventListener('craftShortcut',shortcut)
  globalThis.addEventListener('craftSiriShortcut',shortcut)
  globalThis.addEventListener('craftNotificationResponse',notification)
  async function push(token?:string) {
    if(!alive || registering || !host.push)return
    registering=true
    try {
      if(await host.secureStorage.get('wildloop_push_enabled')!=='true' || !await api.readToken())return
      if(await host.push.getPermissionStatus()!=='granted')return
      const deviceToken=token || await host.push.register()
      const response=await api.send('/api/notifications/push-token','POST',{token:deviceToken,platform:host.platform,environment:nativeApiOrigin(host)==='https://wildloop.org'?'production':'development'})
      if(!response.ok)throw new Error('Device notifications could not be refreshed. Open Settings to reconnect them.')
      await host.secureStorage.set('wildloop_push_token',deviceToken)
    }
    catch { if(alive)await host.snapshots.set('wildloop-push',{error:'Device notifications could not be refreshed. Open Settings to reconnect them.'}) }
    finally {registering=false}
  }
  async function restore() {
    if(!alive || refreshing)return
    refreshing=true
    try {
      const before=JSON.stringify(host.snapshots.get('wildloop-session'))
      const cached=await readNativeAccount(host)
      if(!alive || before!==JSON.stringify(host.snapshots.get('wildloop-session')))return
      if(cached){
        const current=host.snapshots.get<{user?:{id?:number}}>('wildloop-session')
        if(Number(current?.user?.id)!==cached.id)await host.snapshots.set('wildloop-session',{user:cached})
      }
      else if(await api.readToken()){
        // Upgrade a session created by an older shell; the server authenticates
        // it before its owner can be used for offline recording recovery.
        const me=await api.send('/api/me')
        if(alive && me.ok)await storeNativeSession(host,await api.readToken(),me.body.user)
      }
      else await host.snapshots.set('wildloop-session',null)
      if(alive)await push()
    }
    catch { /* Offline startup retains the last authenticated on-device session. */ }
    finally {refreshing=false}
  }
  const stopLifecycle=host.lifecycle.onStateChange(state=>{if(state==='active')void restore()})
  const stopSession=host.snapshots.onChange(name=>{if(name==='wildloop-session')void push()})
  const stopToken=host.push?.onToken(token=>{void push(token)})
  void restore()
  return()=>{alive=false;stopLifecycle();stopSession();stopToken?.();globalThis.removeEventListener('craftShortcut',shortcut);globalThis.removeEventListener('craftSiriShortcut',shortcut);globalThis.removeEventListener('craftNotificationResponse',notification)}
}
