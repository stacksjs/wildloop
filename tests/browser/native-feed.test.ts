import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

const qa=process.env.RECORDING_QA==='1'
let owner={id:0,token:''},viewer={id:0,token:''}
let hike=0
async function send(path:string,method='GET',body?:unknown,token='') {
  return fetch(`${API}${path}`,{method,headers:{'Content-Type':'application/json',...token?{Authorization:`Bearer ${token}`}:{ }},...body===undefined?{}:{body:JSON.stringify(body)}})
}
async function register(role:string) {
  const csrf=await csrfToken(API)
  const response=await fetch(`${API}/register`,{method:'POST',headers:{'Content-Type':'application/json',Origin:APP,'X-CSRF-Token':csrf,Cookie:`X-CSRF-Token=${encodeURIComponent(csrf)}`},body:JSON.stringify({name:`Native Feed ${role}`,email:`native-feed-${crypto.randomUUID()}@example.test`,password:`Local-QA-${crypto.randomUUID()}`})})
  expect(response.status,await response.clone().text()).toBe(200)
  const session=await response.json()
  return {id:Number(session.user.id),token:String(session.token)}
}
beforeAll(async()=>{
  if(!qa)return
  await startQaServers();owner=await register('owner');viewer=await register('viewer')
  for(const [index,type,visibility] of [[0,'Hike','public'],[1,'Bike','public'],[2,'Hike','private']] as const){
    const response=await send('/activities','POST',{activity_type:type,visibility,distance:2,duration:'30:00',recording_source:'manual',game_mode:'none',completed_at:new Date(Date.now()-(3-index)*3600000).toISOString()},owner.token)
    expect(response.status,await response.clone().text()).toBe(201)
    const row=(await response.json()).activity
    if(index===0)hike=Number(row.id)
  }
},READY_TIMEOUT_MS+60000)

describe.skipIf(!qa)('native feed API',()=>{
  it('filters the whole visible catalog before paging',async()=>{
    const response=await send(`/activities?user_id=${owner.id}&activity_type=Hike&limit=1`, 'GET',undefined,viewer.token)
    expect(response.status).toBe(200)
    const body=await response.json()
    expect(body.activities.map((row:any)=>row.id)).toEqual([hike])
    expect(body.meta.total).toBe(1)
  })
  it('limits Following to followed authors while retaining activity privacy',async()=>{
    const before=await send(`/activities?user_id=${owner.id}&scope=following`,'GET',undefined,viewer.token)
    expect((await before.json()).activities).toHaveLength(0)
    expect((await send(`/users/${owner.id}/follow`,'PUT',{},viewer.token)).status).toBe(200)
    const followed=await send(`/activities?user_id=${owner.id}&scope=following`,'GET',undefined,viewer.token)
    const rows=(await followed.json()).activities
    expect(rows).toHaveLength(2)
    expect(rows.every((row:any)=>row.visibility==='public' && row.userId===owner.id)).toBe(true)
  })
  it('returns only the current viewer’s kudos in the feed and detail',async()=>{
    expect((await send(`/activities/${hike}/kudos`,'PUT',{},viewer.token)).status).toBe(200)
    const detail=await send(`/activities/${hike}`,'GET',undefined,viewer.token)
    expect((await detail.json()).activity.viewerKudosed).toBe(true)
    const own=await send(`/activities/${hike}`,'GET',undefined,owner.token)
    expect((await own.json()).activity.viewerKudosed).toBe(false)
    const list=await send(`/activities?user_id=${owner.id}`,'GET',undefined,viewer.token)
    expect((await list.json()).activities.find((row:any)=>row.id===hike).viewerKudosed).toBe(true)
    expect((await send(`/activities/${hike}/kudos`,'DELETE',{},viewer.token)).status).toBe(200)
    const removed=await send(`/activities/${hike}`,'GET',undefined,viewer.token)
    expect((await removed.json()).activity.viewerKudosed).toBe(false)
  })
})
