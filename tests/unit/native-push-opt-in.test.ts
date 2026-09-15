import { describe, expect, it } from 'bun:test'

const root = new URL('../../', import.meta.url)

describe('native push opt-in', () => {
  it('does not request a device token before the stored opt-in exists', async () => {
    const source = await Bun.file(new URL('resources/composables/useNativeServices.ts', root)).text()
    const sync = source.slice(source.indexOf('async function syncOptedInNativePushNotifications'))

    expect(sync).toContain("secureStorage.get(PUSH_ENABLED_KEY)")
    expect(sync.indexOf("secureStorage.get(PUSH_ENABLED_KEY)")).toBeLessThan(sync.indexOf('enableNativePushNotifications()'))
  })

  it('allows only the token owner to replace or remove a registration', async () => {
    const register = await Bun.file(new URL('app/Actions/Notification/RegisterPushTokenAction.ts', root)).text()
    const unregister = await Bun.file(new URL('app/Actions/Notification/UnregisterPushTokenAction.ts', root)).text()

    expect(register).toContain('existing.user_id !== user.id')
    expect(unregister).toContain(".where('user_id', '=', user.id)")
  })

  it('offers an explicit native Settings control', async () => {
    const settings = await Bun.file(new URL('resources/views/settings.stx', root)).text()

    expect(settings).toContain('Turn on notifications')
    expect(settings).toContain('Turn off notifications')
  })
})
