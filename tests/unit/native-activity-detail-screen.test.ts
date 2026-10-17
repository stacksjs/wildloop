import { beforeAll, describe, expect, it } from 'bun:test'
import { answer, compileNativeBundle, nativeNodeProps, nativeNodeStyle, requests, shownText, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'

const ACTIVITY={id:7,userId:12,userName:'Trail friend',activityType:'Hike',distance:3,duration:'1:00:00',elevation:300,hasGps:true,notes:'A quiet ridge outing',visibility:'private',viewerKudosed:true,kudosCount:1,route:[[37.7,-119.5],[37.71,-119.51]],comments:[{id:1,userName:'Another friend',body:'Lovely ridge views.'}],photos:[]}
function ok(body:unknown){return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify(body)}}
async function open(){
  const screen=await start('ActivityDetail',{id:7})
  answer(screen,await waitForRequest(screen,0,r=>r.payload.module==='SecureStorage'),'activity-token')
  answer(screen,await waitForRequest(screen,0,r=>r.payload.module==='Network'),ok({activity:ACTIVITY}))
  answer(screen,await waitForRequest(screen,0,r=>r.payload.args?.[0]?.url?.endsWith('/api/me')),ok({user:{id:12}}))
  await waitForText(screen,ACTIVITY.notes)
  return screen
}
async function nextNetwork(screen: Awaited<ReturnType<typeof start>>, after: number) {
  const request = await waitForRequest(screen, after, r => r.payload.module === 'Network' || r.payload.module === 'SecureStorage')
  if (request.payload.module === 'SecureStorage') {
    answer(screen, request, 'activity-token')
    return waitForRequest(screen, requests(screen).indexOf(request) + 1, r => r.payload.module === 'Network')
  }
  return request
}
describe('native activity detail',()=>{
  beforeAll(compileNativeBundle,30000)
  it('keeps the native map, measurements, comments and actionable comment label visible',async()=>{
    const screen=await open()
    expect(shownText(screen)).toContain('3 mi · 1:00:00 · 300 ft')
    expect(shownText(screen)).toContain('Lovely ridge views.')
    expect(nativeNodeStyle(screen,'activity-native-map').height).toBe(320)
    expect(nativeNodeProps(screen,'activity-comment-submit').title).toBe('Post comment')
  })
  it('posts a comment and reloads its real activity response',async()=>{
    const screen=await open(),before=requests(screen).length
    await screen.event('activity-comment','onChangeText',{text:'Returned via native comment'})
    await screen.event('activity-comment-submit','onPress')
    const post=await nextNetwork(screen,before)
    expect(post.payload.args[0]).toMatchObject({url:'https://wildloop.org/api/activities/7/comments',method:'POST'})
    expect(JSON.parse(post.payload.args[0].body)).toEqual({body:'Returned via native comment'})
    answer(screen,post,ok({success:true}))
    const reload=await nextNetwork(screen,requests(screen).indexOf(post)+1)
    answer(screen,reload,ok({activity:{...ACTIVITY,comments:[...ACTIVITY.comments,{id:2,userName:'Trail friend',body:'Returned via native comment'}]}}))
    answer(screen,await waitForRequest(screen,requests(screen).indexOf(reload)+1,r=>r.payload.module==='Network'),ok({user:{id:12}}))
    await waitForText(screen,'Returned via native comment')
  })
  it('edits notes while retaining locked GPS measurements',async()=>{
    const screen=await open(),before=requests(screen).length
    await screen.event('activity-edit','onPress')
    await screen.event('activity-edit-notes','onChangeText',{text:'Updated ridge outing'})
    await screen.event('activity-edit-save','onPress')
    const patch=await nextNetwork(screen,before)
    const body=JSON.parse(patch.payload.args[0].body)
    expect(patch.payload.args[0].method).toBe('PATCH')
    expect(body).toEqual({activity_type:'Hike',notes:'Updated ridge outing',visibility:'private'})
    expect(nativeNodeProps(screen,'activity-edit-save').title).toBe('Save changes')
  })
  it('removes existing viewer kudos through explicit native intent',async()=>{
    const screen=await open(),before=requests(screen).length
    await screen.event('activity-kudos','onPress')
    const removal=await nextNetwork(screen,before)
    expect(removal.payload.args[0]).toMatchObject({url:'https://wildloop.org/api/activities/7/kudos',method:'DELETE'})
    answer(screen,removal,ok({kudosed:false,kudosCount:0}))
    await waitForText(screen,'Give kudos · 0')
  })
})
