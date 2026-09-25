import type { CLI } from '@stacksjs/types'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'

interface RegisteredCommand {
  name?: string
  rawName?: string
}

const projectRoot = resolve(import.meta.dir, '../..')

function hasCommand(cli: CLI, name: string): boolean {
  const commands = (cli as CLI & { commands?: RegisteredCommand[] }).commands
  return commands?.some(command => command.rawName === name || command.name === name) ?? false
}

async function runScript(script: string, label: string): Promise<boolean> {
  log.info(`Running bun run ${script}`)
  const craftPackages = resolve(projectRoot, '../../Tools/craft/packages')
  const localIosBuilder = resolve(craftPackages, 'ios/src/index.ts')
  const localAndroidBuilder = resolve(craftPackages, 'android/src/index.ts')
  const env = {
    ...process.env,
    ...(existsSync(localIosBuilder) && !process.env.CRAFT_IOS_SRC ? { CRAFT_IOS_SRC: localIosBuilder } : {}),
    ...(existsSync(localAndroidBuilder) && !process.env.CRAFT_ANDROID_SRC ? { CRAFT_ANDROID_SRC: localAndroidBuilder } : {}),
  }
  const child = Bun.spawn(['bun', 'run', script], {
    cwd: projectRoot,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited

  if (exitCode !== 0) {
    log.error(`${label} failed with exit code ${exitCode}.`)
    return false
  }

  return true
}

/**
 * Wildloop's physical-iPhone commands.
 *
 * `build:android`, `build:ios`, and `build:mobile` are NOT registered here:
 * Buddy ships them itself and runs the framework's own build actions. The two
 * commands below drive scripts that only exist in this repository — compiling
 * an unsigned Release build for a real handset, and installing it — so they
 * have no upstream equivalent to defer to.
 */
export default function (cli: CLI): void {
  if (!hasCommand(cli, 'build:iphone')) {
    cli
      .command('build:iphone', 'Compile and validate an unsigned Release build for a physical iPhone')
      .action(async () => {
        const perf = await intro('buddy build:iphone')
        if (!await runScript('check:iphone', 'iPhone Release build'))
          process.exit(ExitCode.FatalError)
        await outro('Physical-iPhone Release application built and validated', { startTime: perf, useSeconds: true })
      })
  }

  if (!hasCommand(cli, 'preview:iphone')) {
    cli
      .command('preview:iphone', 'Build, sign, install, and launch Wildloop on a connected iPhone')
      .option('--bundled', 'Bundle the local frontend instead of using the configured remote URL', { default: false })
      .action(async (options: { bundled: boolean }) => {
        const perf = await intro('buddy preview:iphone')
        const script = options.bundled ? 'preview:iphone:bundled' : 'preview:iphone'
        if (!await runScript(script, 'iPhone preview'))
          process.exit(ExitCode.FatalError)
        await outro('Wildloop installed and launched on the connected iPhone', { startTime: perf, useSeconds: true })
      })
  }
}
