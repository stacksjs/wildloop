import { dirname, join, resolve } from 'node:path'
import { createAndroidEmulator } from 'craft-native/android'

/** Run the installed app on a disposable device owned by the published SDK. */
export async function runOwnedAndroidE2e(suite: string | undefined): Promise<void> {
  if (suite !== 'baseline' && suite !== 'native-trail')
    throw new Error('Select the baseline or native-trail Android journey.')
  const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  const sdkmanager = Bun.which('sdkmanager')
  const avdmanager = Bun.which('avdmanager')
  if (!sdkRoot || !sdkmanager || !avdmanager)
    throw new Error('Install the normal Android SDK command-line tools before native QA.')
  const root = resolve(`storage/framework/runtime/e2e/${suite === 'native-trail' ? 'native-trail-android' : 'android'}/emulator`)
  const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
  const session = await createAndroidEmulator({
    sdkRoot, sdkmanager, avdmanager,
    image: `system-images;android-35;google_apis_playstore;${abi}`,
    acceleration: 'hardware', acceptLicenses: true, artifactsDirectory: root,
  })
  try {
    const args = suite === 'native-trail'
      ? ['bun', 'scripts/run-native-trail-android-e2e.ts', '--skip-build']
      : ['bun', 'scripts/run-mobile-e2e.ts', 'android', '--skip-build']
    const test = Bun.spawn(args, {
      env: {
        ...session.env, PATH: `${dirname(session.adb)}:${session.env.PATH ?? ''}`,
        NATIVE_QA_ANDROID_DEVICE: session.serial,
      },
      stdout: 'inherit', stderr: 'inherit',
    })
    const status = await test.exited
    if (status !== 0) {
      for (const [name, args] of [
        ['device-state', ['get-state']],
        ['platform-events', ['logcat', '-b', 'events', '-d', '-v', 'threadtime']],
        ['platform-properties', ['shell', 'getprop']],
      ] as const) {
        try {
          const diagnostic = Bun.spawn([session.adb, '-s', session.serial, ...args], {
            env: session.env, stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(10_000),
          })
          const [code, stdout, stderr] = await Promise.all([
            diagnostic.exited, new Response(diagnostic.stdout).text(), new Response(diagnostic.stderr).text(),
          ])
          await Bun.write(join(root, `failure-${name}.json`), JSON.stringify({ code, stdout, stderr }) + '\n')
        }
        catch (cause) { console.warn(`Could not retain Android ${name}: ${cause}`) }
      }
      throw new Error(`Android ${suite} acceptance failed with exit ${status}.`)
    }
  }
  finally {
    await session.dispose()
    await Bun.write(join(root, 'disposal.json'), JSON.stringify({ serial: session.serial, disposed: true }) + '\n')
  }
}

if (import.meta.main) await runOwnedAndroidE2e(process.argv[2])
