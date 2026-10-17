import { beforeAll, describe, expect, it } from 'bun:test'
import { addDays } from '../../resources/functions/trip-plans'
import { todayLocal } from '../../resources/functions/manual-activity'
import { answer, compileNativeBundle, requests, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'

const plan={id:7,title:'Ridge day',planned_for:addDays(todayLocal(),3),start_time:'07:30',latitude:37.7,longitude:-119.5,activity_type:'Hike',timezone:'UTC',trail_id:7,custom_route_id:null,notes:''}
function ok(body:unknown){return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify(body)}}
async function open() {
  const screen=await start('Plans',{},['fetch','storage','secureStorage','notifications','linking','dialog'])
  for(const request of requests(screen).filter(r=>r.payload.module==='SecureStorage'))answer(screen,request,request.payload.args[0]==='auth_token'?'native-token':JSON.stringify({token:'native-token',user:{id:7}}))
  const cached=await waitForRequest(screen,0,r=>r.payload.module==='Storage')
  const before=requests(screen).length;answer(screen,cached,null)
  answer(screen,await waitForRequest(screen,before,r=>r.payload.module==='SecureStorage'),'native-token')
  const me=await waitForRequest(screen,0,r=>r.payload.module==='Network');answer(screen,me,ok({user:{id:7}}))
  const list=await waitForRequest(screen,requests(screen).indexOf(me)+1,r=>r.payload.module==='Network');answer(screen,list,ok({plans:[plan]}))
  const write=await waitForRequest(screen,requests(screen).indexOf(list)+1,r=>r.payload.module==='Storage');answer(screen,write,true)
  await waitForText(screen,'Ridge day')
  return screen
}
describe('native Plans',()=>{
  beforeAll(compileNativeBundle,30000)
  it('uses native notifications with a real delay for the chosen plan',async()=>{
    const screen=await open(),before=requests(screen).length
    await screen.event('plan-reminder-7','onPress')
    const cancel=await waitForRequest(screen,before,r=>r.payload.module==='Notifications')
    expect(cancel.payload).toMatchObject({method:'cancel',args:['wildloop-plan-7']});answer(screen,cancel,true)
    const scheduled=await waitForRequest(screen,requests(screen).indexOf(cancel)+1,r=>r.payload.module==='Notifications')
    expect(scheduled.payload.method).toBe('schedule')
    expect(scheduled.payload.args[0]).toMatchObject({id:'wildloop-plan-7',title:'Your Wildloop plan'})
    expect(scheduled.payload.args[0].delay).toBeGreaterThan(0)
    expect(scheduled.payload.args[0].at).toBeUndefined()
    answer(screen,scheduled,true)
    await waitForText(screen,'Reminder scheduled for 6 pm on the evening before your plan.')
  })
  it('does not save an empty latitude as zero',async()=>{
    const screen=await open()
    await screen.event('plan-new','onPress')
    await screen.event('plan-title','onChangeText',{text:'New hike'})
    await screen.event('plan-longitude','onChangeText',{text:'-119.5'})
    const before=requests(screen).length
    await screen.event('plan-save','onPress')
    answer(screen,await waitForRequest(screen,before,r=>r.payload.module==='SecureStorage'),'native-token')
    await waitForText(screen,'Pick a trail or a spot on the map')
    expect(requests(screen).slice(before).some(r=>r.payload.module==='Network')).toBe(false)
  })
})
