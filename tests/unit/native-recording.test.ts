import { describe, expect, it } from 'bun:test'
import { movingSeconds, recordingFigures, recordingPayload, recordingSamples, type NativeRecording } from '../../resources/functions/native-recording'

function track(): NativeRecording {
  return { userId:7,id:'native-run-7',startedAt:100000,type:'Hike',visibility:'private',gameMode:'free',targetTerritoryId:null,pauses:[],samples:[] }
}
describe('native recording recovery math',()=>{
  it('deduplicates background replay, retains altitude in feet and excludes paused fixes',()=>{
    const value=track()
    value.pauses=[{start:120000,end:150000}]
    const locations=[
      {latitude:37,longitude:-119,timestamp:110000,accuracy:5,altitude:100},
      {latitude:37.1,longitude:-119,timestamp:130000,accuracy:5,altitude:1000},
      {latitude:37.2,longitude:-119,timestamp:160000,accuracy:5,altitude:120},
    ]
    value.samples=recordingSamples(value,locations)
    expect(value.samples).toHaveLength(2)
    expect(value.samples[0].eleFt).toBeCloseTo(328.084)
    expect(value.samples[1].movingS).toBe(30)
    expect(recordingSamples(value,locations)).toEqual(value.samples)
    // Moving the phone while paused must not add miles or ascent.
    expect(recordingFigures(value)).toEqual({distance:0,elevation:0})
  })
  it('freezes moving time during an unfinished pause',()=>{
    const value=track();value.pauses=[{start:160000,end:null}]
    expect(movingSeconds(value,220000)).toBe(60)
    expect(movingSeconds(value,300000)).toBe(60)
  })
  it('retries the same upload identity and exports platform altitude as metres',()=>{
    const value=track()
    value.samples=[{lat:37,lng:-119,t:100000,eleFt:328.084,movingS:0},{lat:37.01,lng:-119,t:160000,eleFt:328.084,movingS:60}]
    const payload=recordingPayload(value,160000)
    expect(payload).toMatchObject({upload_id:'run:native-run-7',recording_source:'native_gps',duration:'1:00',moving_time:'1:00',visibility:'private',game_mode:'free'})
    expect('user_id' in payload).toBe(false)
    const geometry=JSON.parse(String(payload.gpx_data))
    expect(geometry.coordinates[0]).toEqual([-119,37])
    expect(geometry.properties.samples[0].altitude).toBeCloseTo(100)
    expect(recordingPayload(value,160000).upload_id).toBe(payload.upload_id)
  })
})
