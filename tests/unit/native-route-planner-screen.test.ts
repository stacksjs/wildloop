import { beforeAll, describe, expect, it } from 'bun:test'
import { answer, compileNativeBundle, nativeNodeProps, requests, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'
function ok(body:unknown){return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify(body)}}
async function open(){
  const screen=await start('Routes',{},['fetch','secureStorage','dialog','files','share','geolocation'])
  answer(screen,await waitForRequest(screen,0,r=>r.payload?.module==='SecureStorage'),'test-token')
  answer(screen,await waitForRequest(screen,0,r=>r.payload?.module==='Network'),ok({routes:[]}))
  return screen
}
describe('native route planner',()=>{
  beforeAll(compileNativeBundle,30000)
  /*
   * A device that will not say where it is does not reject — it resolves with
   * an object that simply carries no coordinates. `Number(undefined)` is NaN,
   * and a region centred on NaN sends the camera nowhere, leaving a blank map
   * with no hint of why. The territory map shipped that exact bug as
   * `min_lat=NaN` on the wire; this is the same shape, one screen over.
   */
  it('keeps the map where it is when the device answers without coordinates',async()=>{
    const screen=await open()
    await screen.event('route-locate','onPress')
    const position=await waitForRequest(screen,0,r=>r.payload?.module==='Location')
    answer(screen,position,{accuracy:65})
    await waitForText(screen,'Your position could not be found.')
    expect(nativeNodeProps(screen,'route-builder-map').region ?? null).toBeNull()
  })
  it('draws native map taps only after routing succeeds',async()=>{
    const screen=await open()
    await screen.event('route-builder-map','onPress',{latitude:35,longitude:-82})
    await screen.event('route-builder-map','onPress',{latitude:35.01,longitude:-82.01})
    const key=await waitForRequest(screen,1,r=>r.payload?.module==='SecureStorage')
    answer(screen,key,'test-token')
    const route=await waitForRequest(screen,1,r=>r.payload?.args?.[0]?.url?.includes('/api/geo/path?'))
    expect(route.payload.args[0].url).toContain('from=35,-82&to=35.01,-82.01')
    answer(screen,route,ok({routed:false,reason:'No path between these points',points:[[35,-82],[35.01,-82.01]]}))
    await waitForText(screen,'No path between these points. Choose closer points, or explicitly turn off Follow paths to draw a straight segment.')
    expect(nativeNodeProps(screen,'route-builder-line').geometry).toEqual([35,-82])
  })
  it('saves an explicitly straight route with the current geometry and server elevation',async()=>{
    const screen=await open()
    await screen.event('route-follow-paths','onValueChange',{value:false})
    await screen.event('route-builder-map','onPress',{latitude:35,longitude:-82})
    await screen.event('route-builder-map','onPress',{latitude:35.01,longitude:-82.01})
    expect(nativeNodeProps(screen,'route-builder-line').geometry).toEqual([35,-82,35.01,-82.01])
    await screen.event('route-name','onChangeText',{text:'Native test route'})
    const before=requests(screen).length
    void screen.event('route-save','onPress')
    answer(screen,await waitForRequest(screen,before,r=>r.payload?.module==='SecureStorage'),'test-token')
    answer(screen,await waitForRequest(screen,before,r=>r.payload?.args?.[0]?.url?.includes('/api/geo/climb?')),ok({gainFt:125}))
    const save=await waitForRequest(screen,before,r=>r.payload?.args?.[0]?.method==='POST')
    expect(JSON.parse(save.payload.args[0].body)).toEqual({name:'Native test route',route:[[35,-82],[35.01,-82.01]],elevation:125})
    answer(screen,save,ok({route:{id:11}}))
    await waitForText(screen,'Route saved.')
    answer(screen,await waitForRequest(screen,before,r=>r.payload?.module==='SecureStorage' && r.id!==requests(screen)[before]?.id),'test-token')
    answer(screen,await waitForRequest(screen,before,r=>r.payload?.args?.[0]?.method==='GET' && r.payload?.args?.[0]?.url?.endsWith('/api/custom-routes')),ok({routes:[]}))
  })
})
