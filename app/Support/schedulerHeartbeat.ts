import { log } from '@stacksjs/logging'

/**
 * Tells StatusHQ the scheduler is alive.
 *
 * Every nightly job (snapshots, counters, the trail repairs, the fold) runs
 * from one always-on scheduler process. If it stops, nothing fails loudly:
 * the jobs just never run, and nobody notices until the data has drifted.
 * A heartbeat inverts that. The scheduler pings a StatusHQ heartbeat monitor
 * every few minutes, and StatusHQ alerts the team's Discord when the pings
 * stop.
 *
 * ts-cloud's `scheduler.heartbeatUrl` cannot do this here: it appends a curl
 * to a cron line, and Stacks runs the scheduler as a daemon, not from cron.
 * So the ping is a job of its own inside the daemon, which proves the thing
 * worth proving: that the process is up and its timer is firing.
 *
 * The URL is `https://statushq.org/api/ping/<token>`, kept encrypted in
 * `.env.production` as SCHEDULER_HEARTBEAT_URL. The token is the only
 * credential, so it is never logged.
 */

/** How often the scheduler pings. StatusHQ expects one this often, plus grace. */
export const HEARTBEAT_EVERY_SECONDS = 300

const TIMEOUT_MS = 10_000

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * One ping. Never throws: a monitor that cannot be reached is StatusHQ's
 * problem to report, and must not take a scheduler job down with it.
 * Returns whether StatusHQ accepted it, for the tests.
 */
export async function pingHeartbeat(url: string | undefined, fetcher: FetchLike = fetch): Promise<boolean> {
  const target = String(url ?? '').trim()
  if (!target)
    return false

  try {
    const response = await fetcher(target, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (response.ok)
      return true
    log.warn(`[scheduler] heartbeat ping answered ${response.status}`)
  }
  catch (error) {
    log.warn(`[scheduler] heartbeat ping failed: ${error instanceof Error ? error.name : 'error'}`)
  }
  return false
}

/**
 * Run a scheduled command and tell its own StatusHQ monitor how it went.
 *
 * The scheduler heartbeat says the scheduler is alive, not that last night's
 * backup worked. A job that matters gets a monitor of its own: `/start` when
 * it begins (so StatusHQ can time it and notice one that never finishes),
 * the plain ping when it exits 0, and `/fail` when it does not, which alerts
 * at once instead of waiting for a missed deadline. A monitor whose cron
 * expression matches the job also alerts when the run never happens.
 *
 * Throws on a non-zero exit, as `schedule.command` does, so the scheduler's
 * own log and error handling see the failure too.
 */
export async function runReported(
  command: string,
  url: string | undefined,
  run: (command: string) => Promise<number> = runInShell,
  fetcher: FetchLike = fetch,
): Promise<void> {
  const base = String(url ?? '').trim().replace(/\/+$/, '')
  if (base)
    await pingHeartbeat(`${base}/start`, fetcher)

  let code = 1
  try {
    code = await run(command)
  }
  finally {
    if (base)
      await pingHeartbeat(code === 0 ? base : `${base}/fail`, fetcher)
  }
  if (code !== 0)
    throw new Error(`'${command}' exited with code ${code}`)
}

async function runInShell(command: string): Promise<number> {
  log.info(`Executing command: ${command}`)
  const child = Bun.spawn(['sh', '-c', command], { stdout: 'inherit', stderr: 'inherit' })
  return await child.exited
}
