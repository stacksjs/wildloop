import { beforeAll, describe, expect, it } from 'bun:test'
import { answer, compileNativeBundle, requests, start } from '../fixtures/nativeScreen'
import { nativeDestination } from '../../resources/functions/native-destinations'

describe('native application lifecycle',()=>{
  beforeAll(compileNativeBundle,30000)
  it('runs the shared application script without creating a web or native screen',async()=>{
    const app=await start('__app')
    expect(app.sent.some(message=>message.type==='RENDER')).toBe(false)
    // It starts by restoring the account from the keychain: the bearer and the identity beside it.
    expect(requests(app).slice(0,2).map(request=>[request.payload.module,request.payload.args[0]])).toEqual([['SecureStorage','auth_token'],['SecureStorage','wildloop-account']])
  })
  it('opens notification destinations and app shortcuts through native navigation',async()=>{
    const app=await start('__app')
    app.receive({type:'CRAFT_EVENT',payload:{event:'craftNotificationResponse',detail:{href:'/trail/7'}}})
    app.receive({type:'CRAFT_EVENT',payload:{event:'craftShortcut',detail:{type:'favorites'}}})
    expect(app.sent.filter(message=>message.type==='NAVIGATE_OPEN').map(message=>message.payload.path)).toEqual(['/trail/7','/profile?tab=saved'])
    app.receive({type:'CRAFT_EVENT',payload:{event:'craftNotificationResponse',detail:{href:'https://other.example/trail/7'}}})
    expect(app.sent.filter(message=>message.type==='NAVIGATE_OPEN')).toHaveLength(2)
    app.scope.__stxNativeUnmount()
    app.receive({type:'CRAFT_EVENT',payload:{event:'craftShortcut',detail:{type:'favorites'}}})
    expect(app.sent.filter(message=>message.type==='NAVIGATE_OPEN')).toHaveLength(2)
  })
  it('restores the public identity from a matching keychain account without networking',async()=>{
    const app=await start('__app')
    for(const request of requests(app).filter(r=>r.payload.module==='SecureStorage'))answer(app,request,request.payload.args[0]==='auth_token' ? 'native-token' : JSON.stringify({token:'native-token',user:{id:7}}))
    for(let attempt=0;attempt<20 && !app.scope.__snapshots.get('wildloop-session');attempt++)await Bun.sleep(1)
    expect(app.scope.__snapshots.get('wildloop-session')).toEqual({user:{id:7}})
    // The identity came from the keychain. What the network is asked for is
    // only the bar's account and unread count (native-chrome.ts), afterwards.
    for(let attempt=0;attempt<20 && requests(app).filter(r=>r.payload.module==='Network').length<2;attempt++)await Bun.sleep(1)
    expect(requests(app).filter(request=>request.payload.module==='Network').map(request=>request.payload.args[0].url)).toEqual(['https://wildloop.org/api/me','https://wildloop.org/api/notifications?limit=1'])
  })
  it('rejects external, protocol-relative and encoded traversal destinations',()=>{
    expect(nativeDestination('wildloop://trail/7')).toBe('/trail/7')
    expect(nativeDestination('https://wildloop.org/trail/7')).toBe('/trail/7')
    for(const path of ['//other.example','/\\other.example','/%2fother.example','/%2e%2e/settings','https://wildloop.org.other.example/trail/7','javascript:alert(1)'])expect(nativeDestination(path)).toBeNull()
  })
})
