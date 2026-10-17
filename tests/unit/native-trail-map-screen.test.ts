import type { TrailProfilePoint } from '../../resources/functions/trail-profile'
import { beforeAll, describe, expect, it } from 'bun:test'
import { chooseNativeOption, answer, compileNativeBundle, nativeNodeProps, requests, start, waitForGeometry, waitForRequest, waitForText, waitForVisibility } from '../fixtures/nativeScreen'

function ok(body: unknown) { return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify(body)} }
async function open(points:TrailProfilePoint[]=[{mi:0,ft:4000,lat:37.7,lng:-119.5},{mi:3,ft:4500,lat:37.71,lng:-119.51}]) {
  const screen = await start('TrailMap',{id:'7'},['fetch','secureStorage','linking','share','files','geolocation','dialog'])
  answer(screen,await waitForRequest(screen,0,r=>r.payload?.module==='SecureStorage'),null)
  answer(screen,await waitForRequest(screen,0,r=>r.payload?.module==='Network'),ok({trail:{id:7,name:'Ridge Loop',latitude:37.75,longitude:-119.55,geometry:JSON.stringify([[37.7,-119.5],[37.71,-119.51],[37.7,-119.5]])}}))
  answer(screen,await waitForRequest(screen,0,r=>r.payload?.args?.[0]?.url?.endsWith('/profile')),ok({points}))
  await waitForGeometry(screen)
  return screen
}
describe('native full trail map',()=>{
  beforeAll(compileNativeBundle,30000)
  it('fits the recorded route with room for its floating card and supports zoom, layers and 3D',async()=>{
    const screen=await open()
    expect(nativeNodeProps(screen,'trail-full-map')).toMatchObject({fitToBounds:true,edgePadding:{bottom:240},showsCompass:true,showsScale:true,scrollEnabled:true,zoomEnabled:true,rotateEnabled:true,tileOverlay:{attribution:expect.stringContaining('Esri'),urlTemplate:expect.stringContaining('World_Topo_Map')}})
    await chooseNativeOption(screen,'map-layer','Satellite')
    await screen.event('map-3d','onPress')
    await screen.event('map-zoom-in','onPress')
    expect(nativeNodeProps(screen,'trail-full-map')).toMatchObject({mapType:'satellite',tileOverlay:null,cameraPitch:45,fitToBounds:false})
    await screen.event('map-fit','onPress')
    expect(nativeNodeProps(screen,'trail-full-map')).toMatchObject({region:null,fitToBounds:true})
    await screen.event('map-profile-toggle','onPress')
    expect(nativeNodeProps(screen,'trail-full-map').edgePadding.bottom).toBe(100)
    expect(nativeNodeProps(screen,'map-profile-toggle').accessibilityValue).toBe('Elevation profile collapsed')
    await screen.event('map-profile-toggle','onPress')
    expect(nativeNodeProps(screen,'map-profile-toggle').accessibilityValue).toBe('Elevation profile expanded')
  })
  it('explains missing elevation without presenting invented zero-foot measurements',async()=>{
    const screen=await open([{mi:0,ft:null,lat:37.7,lng:-119.5},{mi:3,ft:null,lat:37.71,lng:-119.51}])
    await waitForVisibility(screen,'map-profile-unavailable','shown')
    await waitForVisibility(screen,'map-profile-range','none')
  })
  it('tracks gesture camera changes, resets north and inspects actual elevation positions',async()=>{
    const screen=await open()
    await screen.event('trail-full-map','onRegionChangeComplete',{center:{latitude:37.8,longitude:-119.6},span:{latitudeDelta:0.02,longitudeDelta:0.03},heading:90,pitch:30})
    expect(nativeNodeProps(screen,'trail-full-map')).toMatchObject({cameraHeading:90,cameraPitch:30,region:{center:{latitude:37.8}}})
    await screen.event('map-north','onPress')
    expect(nativeNodeProps(screen,'trail-full-map').cameraHeading).toBe(0)
    await screen.event('map-elevation-slider','onValueChange',{value:1})
    expect(nativeNodeProps(screen,'trail-full-map').region.center).toEqual({latitude:37.71,longitude:-119.51})
  })
  it('exports a GPX file through native files and the system share sheet',async()=>{
    const screen=await open(),before=requests(screen).length
    void screen.event('map-export','onPress')
    const write=await waitForRequest(screen,before,r=>r.payload?.module==='Files')
    expect(write.payload.args[0]).toBe('Ridge-Loop.gpx')
    expect(write.payload.args[1]).toContain('<trkpt lat="37.7" lon="-119.5"/>')
    answer(screen,write,{path:'/tmp/Ridge-Loop.gpx',name:'Ridge-Loop.gpx',type:'application/gpx+xml',size:300})
    const share=await waitForRequest(screen,before,r=>r.payload?.module==='Share')
    expect(share.payload.args[0].files).toEqual(['/tmp/Ridge-Loop.gpx'])
    answer(screen,share,true)
  })
  it('opens system directions and keeps Customize on the native route planner',async()=>{
    const screen=await open(),before=requests(screen).length
    await screen.event('map-directions','onPress')
    const link=await waitForRequest(screen,before,r=>r.payload?.module==='Linking')
    const destination=new URL(link.payload.args[0])
    expect(destination.searchParams.get('daddr') ?? destination.searchParams.get('destination')).toBe('37.7,-119.5')
    answer(screen,link,true)
    await screen.event('map-customize','onPress')
    expect(screen.sent.some(m=>m.type==='NAVIGATE_OPEN' && JSON.stringify(m.payload).includes('/routes?trail=7'))).toBe(true)
  })
  it('requests location only when chosen, then centers on the returned native fix',async()=>{
    const screen=await open(),before=requests(screen).length
    expect(requests(screen).some(request=>request.payload.module==='Location')).toBe(false)
    await screen.event('map-locate','onPress')
    const location=await waitForRequest(screen,before,request=>request.payload.module==='Location')
    answer(screen,location,{latitude:37.72,longitude:-119.52,accuracy:5,timestamp:Date.now()})
    await Bun.sleep(0)
    expect(nativeNodeProps(screen,'trail-full-map')).toMatchObject({showsUserLocation:true,region:{center:{latitude:37.72,longitude:-119.52}}})
  })
  it('keeps the route usable and explains denied native location permission',async()=>{
    const screen=await open(),before=requests(screen).length
    await screen.event('map-locate','onPress')
    const location=await waitForRequest(screen,before,request=>request.payload.module==='Location')
    screen.receive({type:'API_ERROR',correlationId:location.id,payload:{code:'PERMISSION_DENIED',message:'Location permission was denied.'}})
    await waitForText(screen,'Location permission was denied.')
    expect(nativeNodeProps(screen,'trail-full-map')).toMatchObject({showsUserLocation:false,fitToBounds:true})
  })
})
