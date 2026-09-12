import { describe, expect, it } from 'bun:test'
import { cli } from '@stacksjs/cli'
import registerMobileCommands from '../../app/Commands/Mobile'

describe('mobile Buddy commands', () => {
  it('registers the physical-iPhone entry points', () => {
    const buddy = cli('buddy')
    registerMobileCommands(buddy)

    const names = buddy.commands.map(command => command.rawName)
    expect(names).toContain('build:iphone')
    expect(names).toContain('preview:iphone')
  })

  it('leaves the native build commands to Buddy', () => {
    // build:android, build:ios, and build:mobile ship with Buddy and run the
    // framework's own build actions. Registering our own would shadow them
    // with a shim that re-enters `bun run build:ios`, which is this repo's
    // script for `./buddy build:ios` — an infinite loop.
    const buddy = cli('buddy')
    registerMobileCommands(buddy)

    const names = buddy.commands.map(command => command.rawName)
    expect(names).not.toContain('build:android')
    expect(names).not.toContain('build:ios')
    expect(names).not.toContain('build:mobile')
  })

  it('does not shadow a command supplied by a newer Buddy release', () => {
    const buddy = cli('buddy')
    buddy.command('preview:iphone', 'Framework iPhone preview')
    registerMobileCommands(buddy)

    expect(buddy.commands.filter(command => command.rawName === 'preview:iphone')).toHaveLength(1)
  })

  it('takes the native mobile runtime from npm, not a vendored copy', async () => {
    const packageJson = await Bun.file(new URL('../../package.json', import.meta.url)).json()
    const projectRoot = new URL('../../', import.meta.url).pathname
    const clientSources: string[] = []
    for await (const path of new Bun.Glob('resources/**/*.{stx,ts}').scan({ cwd: projectRoot, absolute: true }))
      clientSources.push(await Bun.file(path).text())

    // @stacksjs/mobile bundles Craft's browser runtime, so importing the
    // published package is enough for a web build, an STX client bundle, and
    // a native WebView alike. Nothing may reach back into storage/framework.
    expect(packageJson.dependencies['@stacksjs/mobile']).toBeString()
    expect(clientSources.some(source => source.includes("from '@stacksjs/mobile'"))).toBe(true)
    expect(clientSources.every(source => !source.includes('storage/framework/core'))).toBe(true)
  })

  it('keeps recording behind a real location sample', async () => {
    const recordView = await Bun.file(new URL('../../resources/views/record.stx', import.meta.url)).text()

    // Craft's generic permission bridge does not currently report Android
    // location correctly. The app asks the dedicated location bridge for a
    // real sample, which is also what recording needs to begin safely.
    expect(recordView).toContain('<NativeLocationPermissionButton')
    expect(recordView).not.toContain('<NativePermissionButton')
  })
})
