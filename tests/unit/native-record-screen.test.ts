import { beforeAll, describe, expect, it } from 'bun:test'
import { answer, compileNativeBundle, nativeNodeStyle, nativeNodeProps, requests, shownText, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'

const checkpoint={userId:7,id:'run-7',startedAt:100000,type:'Hike',visibility:'private',gameMode:'free',targetTerritoryId:null,pauses:[],samples:[],pending:{upload_id:'run:run-7',completed_at:'2026-10-17T12:00:00Z'}}
function ok(body:unknown,status=200){return {status,headers:{'content-type':'application/json'},body:JSON.stringify(body)}}
async function recover(userId=7) {
  const screen=await start('Record',{},['fetch','secureStorage','storage','geolocation','lifecycle','liveActivity'])
  for(const request of requests(screen).filter(r=>r.payload.module==='SecureStorage')) answer(screen,request,request.payload.args[0]==='auth_token' ? 'record-token' : JSON.stringify({token:'record-token',user:{id:userId}}))
  const stored=await waitForRequest(screen,0,r=>r.payload.module==='Storage' && r.payload.method==='get')
  answer(screen,stored,checkpoint)
  const host=await waitForRequest(screen,0,r=>r.payload.method==='getRecordingState')
  answer(screen,host,{active:false,paused:false,locations:[]})
  return screen
}
describe('native Record checkpoint recovery',()=>{
  beforeAll(compileNativeBundle,30000)
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
    answer(screen,await waitForRequest(screen,2,r=>r.payload.module==='SecureStorage' && r.payload.args[0]==='auth_token'),'record-token')
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
    answer(screen,await waitForRequest(screen,before,r=>r.payload.module==='SecureStorage' && r.payload.args[0]==='auth_token'),'record-token')
    const againMe=await waitForRequest(screen,before,r=>r.payload.module==='Network')
    answer(screen,againMe,ok({user:{id:7}}))
    const again=await waitForRequest(screen,requests(screen).indexOf(againMe)+1,r=>r.payload.module==='Network')
    expect(again.payload.args[0].body).toBe(post.payload.args[0].body)
  })
})
