/**
 * Browser auth suites share real module imports in one Bun process. A simulated
 * relaunch may replace the page singleton, but must put the original object
 * back so another suite's cached imports still refer to its own page.
 */
export function isolateBrowserGlobals(): () => void {
  const host = globalThis as typeof globalThis & { __wildloopSession?: {
    token: string | null
    initialization: Promise<void> | null
    inflight: Map<string, Promise<Response>>
    signOutTasks: Set<() => Promise<unknown>>
  } }
  const keys = ['fetch', 'document', 'localStorage', 'sessionStorage', 'window', 'craft', '__wildloopSession']
  const originals = keys.map(key => [key, Object.getOwnPropertyDescriptor(host, key)] as const)
  const page = host.__wildloopSession
  const saved = page && {
    token: page.token,
    initialization: page.initialization,
    inflight: [...page.inflight],
    signOutTasks: [...page.signOutTasks],
  }
  if (page) {
    page.token = null
    page.initialization = null
    page.inflight.clear()
  }
  return () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(host, key, descriptor)
      else Reflect.deleteProperty(host, key)
    }
    if (page && saved) {
      page.token = saved.token
      page.initialization = saved.initialization
      page.inflight.clear()
      for (const [key, value] of saved.inflight) page.inflight.set(key, value)
      page.signOutTasks.clear()
      for (const task of saved.signOutTasks) page.signOutTasks.add(task)
    }
  }
}
