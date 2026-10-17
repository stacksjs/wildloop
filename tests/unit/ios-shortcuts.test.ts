import { describe, expect, it } from 'bun:test'
import mobile from '../../config/mobile'
import { APP_SHORTCUTS, appShortcutDeepLink } from '../../resources/functions/app-shortcuts'

describe('Wildloop build-owned iOS shortcuts',()=>{
  it('declares the same destinations used by the menu and native app event handler',()=>{
    expect(mobile.ios.appShortcuts.map(shortcut=>shortcut.id)).toEqual(APP_SHORTCUTS.map(shortcut=>shortcut.id))
    for(const shortcut of APP_SHORTCUTS){
      const configured=mobile.ios.appShortcuts.find(row=>row.id===shortcut.id)!
      expect(configured.url).toBe(appShortcutDeepLink(shortcut))
      expect(configured.title).toBe(shortcut.title)
      expect(configured.phrases[0].split('{app}')).toHaveLength(2)
    }
  })
  it('registers its scheme and uses the native renderer on both platforms',()=>{
    expect(mobile.ios.urlSchemes).toContain('wildloop')
    expect(mobile.ios.renderer).toBe('native')
    expect(mobile.android.renderer).toBe('native')
    expect(mobile.ios.nativeApp).toBe('resources/mobile-app.ts')
    expect(mobile.android.nativeApp).toBe('resources/mobile-app.ts')
  })
})
