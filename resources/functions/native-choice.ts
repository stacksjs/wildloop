import type { NativeCraft } from '@stacksjs/stx/native'

export interface NativeChoice<T extends string|number=string|number> { label:string, value:T }

export function nativeChoiceLabel(items:NativeChoice[],value:unknown):string {
  return items.find(item=>String(item.value)===String(value))?.label ?? 'Choose'
}

/** Compact selection uses the system action sheet, including its Cancel action. */
export async function chooseNativeChoice<T extends string|number>(
  host:Pick<NativeCraft,'dialog'>, title:string, items:NativeChoice<T>[],
  apply:(value:T)=>unknown, report:(message:string)=>void,
):Promise<void> {
  try {
    if(!host.dialog)throw new Error('Selection is unavailable in this app build.')
    const selected=await host.dialog.actionSheet({title,actions:[
      ...items.map((item,index)=>({id:`choice-${index}`,title:item.label})),
      {id:'cancel',title:'Cancel',style:'cancel' as const},
    ]})
    if(!selected || selected==='cancel')return
    const match=/^choice-(\d+)$/.exec(selected)
    const item=match ? items[Number(match[1])] : undefined
    if(!item)throw new Error('The selected option is unavailable. Please try again.')
    await apply(item.value)
  }
  catch(cause){report(cause instanceof Error?cause.message:'The options could not be opened.')}
}
