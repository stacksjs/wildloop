import { beforeAll, describe, expect, it } from 'bun:test'
import { answerKeychain, chooseNativeOption, answer, compileNativeBundle, nativeNodeProps, requests, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'

const activity={id:7,userId:2,userName:'Trail friend',activityType:'Hike',title:'Ridge day',distance:3,duration:'1:00:00',elevationGain:300,kudosCount:1,viewerKudosed:true,route:[]}
function ok(activities:unknown[]){return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify({activities,meta:{hasMore:false}})}}
async function open() {
  const screen=await start('Feed')
  const keychain=answerKeychain(screen)
  answer(screen,await waitForRequest(screen,0,request=>request.payload.module==='Network'),ok([activity]))
  await waitForText(screen,'Ridge day')
  keychain()
  return screen
}
describe('native Feed',()=>{
  beforeAll(compileNativeBundle,30000)
  it('restores the viewer’s kudos and sends explicit removal when tapped',async()=>{
    const screen=await open(),before=requests(screen).length
    await waitForText(screen,'Kudos given · 1')
    const keychain=answerKeychain(screen)
    await screen.event('feed-kudos','onPress')
    const request=await waitForRequest(screen,before,r=>r.payload.module==='Network')
    keychain()
    expect(request.payload.args[0]).toMatchObject({method:'DELETE',url:'https://wildloop.org/api/activities/7/kudos'})
    answer(screen,request,{status:200,headers:{'content-type':'application/json'},body:JSON.stringify({kudosed:false,kudosCount:0})})
    await waitForText(screen,'Give kudos · 0')
  })
  it('asks the server for the entire selected activity type and following scope',async()=>{
    const screen=await open(),before=requests(screen).length
    const keychain=answerKeychain(screen)
    await chooseNativeOption(screen,'feed-type','Hike')
    expect(nativeNodeProps(screen,'feed-type')).toMatchObject({accessibilityLabel:'Activity type',accessibilityValue:'Hike'})
    const typed=await waitForRequest(screen,before,r=>r.payload.module==='Network')
    expect(typed.payload.args[0].url).toContain('activity_type=Hike')
    answer(screen,typed,ok([activity]))
    const next=requests(screen).length
    await chooseNativeOption(screen,'feed-scope','Following')
    const following=await waitForRequest(screen,next,r=>r.payload.module==='Network')
    keychain()
    expect(following.payload.args[0].url).toContain('scope=following')
    expect(following.payload.args[0].url).toContain('offset=0')
    answer(screen,following,ok([]))
  })
  /*
   * The gate. The feed is the launch screen, so this is the only test that
   * says what somebody without an account sees of Wildloop: Login, and no
   * request for a feed to put behind it.
   */
  it('sends a viewer with no account to Login instead of drawing a public feed',async()=>{
    const screen=await start('Feed')
    const keychain=answerKeychain(screen,null)
    for(let attempt=0;attempt<60 && !screen.sent.some(m=>m.type==='NAVIGATE_OPEN');attempt++)
      await Bun.sleep(1)
    keychain()
    expect(screen.sent.some(m=>m.type==='NAVIGATE_OPEN' && m.payload.path==='/login?next=%2Ffeed')).toBe(true)
    expect(requests(screen).some(r=>r.payload.module==='Network')).toBe(false)
  })
})
