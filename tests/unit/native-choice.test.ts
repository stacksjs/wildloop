import { describe, expect, it } from 'bun:test'
import { chooseNativeChoice, nativeChoiceLabel } from '../../resources/functions/native-choice'

const items=[{label:'Not reported',value:''},{label:'First section',value:0},{label:'Satellite',value:'satellite'}]
function host(answer:string|null){return {dialog:{actionSheet:async()=>answer,alert:async()=>{},confirm:async()=>false}}}
describe('native compact choices',()=>{
  it('preserves empty and numeric values returned by the system sheet',async()=>{
    const chosen:unknown[]=[],errors:string[]=[]
    await chooseNativeChoice(host('choice-0'),'Conditions',items,value=>chosen.push(value),message=>errors.push(message))
    await chooseNativeChoice(host('choice-1'),'Sections',items,value=>chosen.push(value),message=>errors.push(message))
    expect(chosen).toEqual(['',0])
    expect(errors).toEqual([])
    expect(nativeChoiceLabel(items,0)).toBe('First section')
  })
  it('keeps the current value when the sheet is cancelled',async()=>{
    let selected='outdoors'
    await chooseNativeChoice(host('cancel'),'Map layer',items,value=>{selected=String(value)},()=>{})
    expect(selected).toBe('outdoors')
  })
  it('reports a refused sheet without applying an unrecognized selection',async()=>{
    const errors:string[]=[],chosen:unknown[]=[]
    await chooseNativeChoice(host('choice-99'),'Map layer',items,value=>chosen.push(value),message=>errors.push(message))
    expect(chosen).toEqual([])
    expect(errors).toEqual(['The selected option is unavailable. Please try again.'])
    await chooseNativeChoice({},'Map layer',items,value=>chosen.push(value),message=>errors.push(message))
    expect(errors.at(-1)).toBe('Selection is unavailable in this app build.')
  })
})
