import { beforeAll, describe, expect, it } from 'bun:test'
import { answer, compileNativeBundle, nativeNodeStyle, nativeNodeProps, nativeNodeText, requests, shownText, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'

const checkpoint={userId:7,id:'run-7',startedAt:100000,type:'Hike',visibility:'private',gameMode:'free',targetTerritoryId:null,pauses:[],samples:[],pending:{upload_id:'run:run-7',completed_at:'2026-10-17T12:00:00Z'}}
function ok(body:unknown,status=200){return {status,headers:{'content-type':'application/json'},body:JSON.stringify(body)}}
async function recover(userId=7) {
  const screen=await start('Record',{},['fetch','secureStorage','storage','geolocation','lifecycle','liveActivity'])
  // Answered as they arrive, not only the batch that existed on the first
  // tick: the screen reads the keychain to decide whether a signed-out viewer
  // belongs here at all, and those reads come before the checkpoint.
  const keychain=setInterval(()=>{
    for(const request of requests(screen).filter(r=>r.payload.module==='SecureStorage' && !r.answered)) {
      request.answered=true
      answer(screen,request,request.payload.args[0]==='auth_token' ? 'record-token' : JSON.stringify({token:'record-token',user:{id:userId}}))
    }
  },1)
  const stored=await waitForRequest(screen,0,r=>r.payload.module==='Storage' && r.payload.method==='get')
  clearInterval(keychain)
  answer(screen,stored,checkpoint)
  const host=await waitForRequest(screen,0,r=>r.payload.method==='getRecordingState')
  answer(screen,host,{active:false,paused:false,locations:[]})
  return screen
}
/**
 * A live recording on the device, recovered, holding whatever samples are
 * given. `startedAt` decides how long it has been going without a fix.
 */
async function live(samples:unknown[],startedAt:number) {
  const track={...checkpoint,startedAt,samples,pending:undefined}
  const screen=await start('Record',{},['fetch','secureStorage','storage','geolocation','lifecycle','liveActivity'])
  const keychain=setInterval(()=>{
    for(const request of requests(screen).filter(r=>r.payload.module==='SecureStorage' && !r.answered)) {
      request.answered=true
      answer(screen,request,request.payload.args[0]==='auth_token' ? 'record-token' : JSON.stringify({token:'record-token',user:{id:7}}))
    }
  },1)
  const stored=await waitForRequest(screen,0,r=>r.payload.module==='Storage' && r.payload.method==='get')
  clearInterval(keychain)
  answer(screen,stored,track)
  const host=await waitForRequest(screen,0,r=>r.payload.method==='getRecordingState')
  answer(screen,host,{active:true,paused:false,id:'run-7',locations:[]})
  const read=await waitForRequest(screen,0,r=>r.payload.method==='readRecording')
  answer(screen,read,[])
  return screen
}

describe('native Record checkpoint recovery',()=>{
  beforeAll(compileNativeBundle,30000)

  /*
   * Recording belongs to an account: every sample is uploaded under one, so a
   * signed-out viewer could start a run, cover ten miles and find the app has
   * nowhere to put it. The screen used to open normally and only say so when
   * Start was pressed — reported from a device, 19 Oct 2026.
   */
  it('sends a signed-out viewer to log in rather than offering to record',async()=>{
    const screen=await start('Record',{},['fetch','secureStorage','storage','geolocation','lifecycle','liveActivity'])
    for(let attempt=0;attempt<40;attempt++){
      for(const request of requests(screen).filter((r:any)=>r.payload.module==='SecureStorage' && !r.answered)){
        ;(request as any).answered=true
        answer(screen,request,null)
      }
      if(screen.sent.some((message:any)=>message.type==='NAVIGATE_OPEN'))break
      await Bun.sleep(1)
    }
    expect(screen.sent.some((message:any)=>message.type==='NAVIGATE_OPEN' && message.payload.path==='/login?next=/record')).toBe(true)
    // And it does not go looking for a checkpoint to recover on the way out.
    expect(requests(screen).some((r:any)=>r.payload.module==='Storage')).toBe(false)
    expect(requests(screen).some((r:any)=>r.payload.method==='startRecording')).toBe(false)
  })

  /*
   * The shell prepares this tab hidden beside the Feed at launch. Its guard
   * ran there and pushed Login over the Feed, which is what the navigation
   * journey caught on the simulator: a hidden screen sends nobody anywhere,
   * and asks when it is shown.
   */
  it('waits until the prepared tab is shown before sending anybody to log in',async()=>{
    const screen=await start('Record',{},['fetch','secureStorage','storage','geolocation','lifecycle','liveActivity'],{__stxNativeFocused:false})
    const answerKeychain=async()=>{
      for(let attempt=0;attempt<40;attempt++){
        for(const request of requests(screen).filter((r:any)=>r.payload.module==='SecureStorage' && !r.answered)){
          ;(request as any).answered=true
          answer(screen,request,null)
        }
        await Bun.sleep(1)
      }
    }
    await answerKeychain()
    expect(screen.sent.some((message:any)=>message.type==='NAVIGATE_OPEN')).toBe(false)

    screen.receive({type:'SCREEN_FOCUS',payload:{focused:true}})
    await answerKeychain()
    expect(screen.sent.some((message:any)=>message.type==='NAVIGATE_OPEN' && message.payload.path==='/login?next=/record')).toBe(true)
  })

  /*
   * A retained recording was started by somebody who was signed in. Bouncing
   * them to a login screen is how a run gets lost, so the guard stands aside
   * while one is held.
   */
  /*
   * iOS does not refuse `startUpdatingLocation` when location is denied. It
   * accepts it and then delivers nothing, so the host answers `active: true`
   * and the screen used to settle on "Recording GPS" over a clock counting up
   * and a distance stuck on zero. Measured on a device with location denied:
   * forty-three seconds of "moving", not one sample, and nothing on the screen
   * suggesting the run was not being recorded. Granting the permission
   * mid-recording started the distance climbing immediately, which is what
   * pinned the cause.
   *
   * The screen cannot ask whether permission was granted, so it reports what
   * it can see: no samples at all means it is not recording GPS, whatever the
   * host claims, and after half a minute of that the likely reason is named.
   */
  /*
   * With no region of its own the map fell back to MapKit's default camera,
   * which is the device's own region at country scale: a simulator set to the
   * Philippines opened on the Philippines, a phone in Oregon on the United
   * States. Either way the runner is a speck under the Start button.
   *
   * Asking for a position on mount is right on this screen and wrong on the
   * route planner — Record is the screen whose job is GPS, and the app's
   * purpose string describes exactly this, so the prompt is one the viewer
   * invited. A refusal is silent: the caption under the clock is where the
   * GPS story gets told.
   */
  it('opens the map where the device is, and yields to the track once there is one',async()=>{
    const screen=await recover()
    const position=await waitForRequest(screen,0,r=>r.payload?.module==='Location' && r.payload.method==='getCurrentPosition')
    answer(screen,position,{latitude:45.5152,longitude:-122.6784})
    for(let attempt=0;attempt<60 && !nativeNodeProps(screen,'record-native-map').initialRegion;attempt++)await Bun.sleep(1)
    const region=nativeNodeProps(screen,'record-native-map').initialRegion
    expect(region.center).toEqual({latitude:45.5152,longitude:-122.6784})
    // Tight enough to read a street, not a country.
    expect(region.span.latitudeDelta).toBeLessThan(0.05)
  })

  it('ignores a position that carries no coordinates',async()=>{
    const screen=await recover()
    const position=await waitForRequest(screen,0,r=>r.payload?.module==='Location' && r.payload.method==='getCurrentPosition')
    answer(screen,position,{accuracy:65})
    await Bun.sleep(30)
    // Never a NaN centre, which sends the camera nowhere at all.
    expect(nativeNodeProps(screen,'record-native-map').initialRegion ?? null).toBeNull()
  })

  it('does not claim to be recording GPS before a single fix arrives',async()=>{
    const fresh=await live([],Date.now()-2000)
    await waitForText(fresh,'Waiting for GPS…')
    expect(nativeNodeText(fresh,'record-state')).toBe('Waiting for GPS…')

    const silent=await live([],Date.now()-120000)
    await waitForText(silent,'Still no GPS. Check location permission in Settings.')

    const fixed=await live([{lat:45.5152,lng:-122.6784,at:Date.now()-1000,elevation:0,accuracy:5}],Date.now()-2000)
    await waitForText(fixed,'Recording GPS')
  })

  it('does not bounce a viewer who is holding a recording',async()=>{
    const screen=await recover()
    await waitForText(screen,'Your finished recording is saved on this device. Retry the upload when connected.')
    const before=screen.sent.length

    // The bearer is gone — revoked, or signed out on another device — and the
    // viewer comes back to the tab still holding a finished run.
    screen.receive({type:'SCREEN_FOCUS',payload:{}})
    for(let attempt=0;attempt<40;attempt++){
      for(const request of requests(screen).filter((r:any)=>r.payload.module==='SecureStorage' && !r.answered)){
        ;(request as any).answered=true
        answer(screen,request,null)
      }
      await Bun.sleep(1)
    }
    expect(screen.sent.slice(before).some((message:any)=>message.type==='NAVIGATE_OPEN' && String(message.payload.path).startsWith('/login'))).toBe(false)
  })
  it('recovers a finished upload offline without starting another GPS recording',async()=>{
    const screen=await recover()
    await waitForText(screen,'Your finished recording is saved on this device. Retry the upload when connected.')
    expect(nativeNodeStyle(screen,'record-native-map').height).toBe(320)
    expect(nativeNodeProps(screen,'record-retry').title).toBe('Retry upload')
    expect(nativeNodeProps(screen,'record-start').title).toBe('Start recording')
    expect(requests(screen).some(r=>r.payload.method==='startRecording')).toBe(false)
    expect(requests(screen).some(r=>r.payload.module==='Network')).toBe(false)
    expect(shownText(screen).some(text=>text.includes('moving ·'))).toBe(true)
  })
  it('does not reveal or upload another account’s saved track',async()=>{
    const screen=await recover(8)
    await waitForText(screen,'Log in as the account that started the saved recording before resuming or uploading it.')
    expect(requests(screen).some(r=>r.payload.module==='Network')).toBe(false)
    expect(requests(screen).some(r=>r.payload.method==='startRecording')).toBe(false)
  })
  it('retains a finished track when uploading fails and retries the same identity',async()=>{
    const screen=await recover()
    await waitForText(screen,'Your finished recording is saved on this device. Retry the upload when connected.')
    await screen.event('record-retry','onPress')
    // The upload reads the bearer for itself; the recovery reads above were
    // `readNativeAccount`, which goes to the keychain rather than through the
    // api's memoized token.
    answer(screen,await waitForRequest(screen,4,r=>r.payload.module==='SecureStorage' && r.payload.args[0]==='auth_token'),'record-token')
    const me=await waitForRequest(screen,0,r=>r.payload.module==='Network')
    answer(screen,me,ok({user:{id:7}}))
    const post=await waitForRequest(screen,requests(screen).indexOf(me)+1,r=>r.payload.module==='Network')
    expect(JSON.parse(post.payload.args[0].body).upload_id).toBe('run:run-7')
    answer(screen,post,ok({error:'Temporarily unavailable'},503))
    await waitForText(screen,'Temporarily unavailable')
    expect(requests(screen).some(r=>r.payload.module==='Storage' && r.payload.method==='remove')).toBe(false)
    for(let attempt=0;attempt<20 && nativeNodeProps(screen,'record-retry').disabled;attempt++)await Bun.sleep(1)
    expect(nativeNodeProps(screen,'record-retry').disabled).toBe(false)
    const before=requests(screen).length
    await screen.event('record-retry','onPress')
    // No keychain read this time: the screen holds one `createNativeApi` and
    // it has already read the bearer, so a second attempt reuses it.
    const againMe=await waitForRequest(screen,before,r=>r.payload.module==='Network')
    expect(requests(screen).slice(before).some(r=>r.payload.module==='SecureStorage')).toBe(false)
    answer(screen,againMe,ok({user:{id:7}}))
    const again=await waitForRequest(screen,requests(screen).indexOf(againMe)+1,r=>r.payload.module==='Network')
    expect(again.payload.args[0].body).toBe(post.payload.args[0].body)
  })
})
