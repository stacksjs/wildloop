import type { TripPlan, TripPlanInput } from '../functions/trip-plans'
import { isNativeMobile, notifications, secureStorage } from '@stacksjs/mobile'
import { state } from 'stx'
import { apiFetch, beforeSignOut, initializeAuthSession, isSignedIn } from '../assets/scripts/auth'
import { addDays, isCalendarDate, PLAN_REMINDER_HOUR, planReminderBody, sortPlans, localDate } from '../functions/trip-plans'

/**
 * Trip plans for the signed-in person: load, save, change, cancel — and keep
 * a copy on the device.
 *
 * The copy is what makes a plan usable where plans get used: at a trailhead,
 * or in a car park with one bar. The list is small (tens of plans), so it
 * lives in localStorage, keyed by account so a shared phone never shows one
 * person another's trips. When the network is gone the page renders the
 * copy and says so, and the Apple Maps and Google Maps links still work —
 * they are plain URLs built from the saved point.
 */

const CACHE_PREFIX = 'wildloop-plans-v1:'
/**
 * The native app's copy. A launch with no signal opens the copy of the site
 * bundled in the app (craft://app), whose localStorage is not wildloop.org's
 * — and offline the session cannot say who is signed in, either. Secure
 * storage belongs to the app, so it survives both; it holds one account's
 * plans, is replaced on every refresh, and is deleted on sign-out.
 */
const NATIVE_KEY = 'wildloop.plans'

export interface PlanStoreLike {
  currentUserId: () => number
}

export interface PlanSaveResult {
  ok: boolean
  plan?: TripPlan
  error?: string
  fields?: Record<string, string>
}

/** The device's IANA timezone: what "today" and the reminder are counted in. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  }
  catch {
    return null
  }
}

/** Today's date where the device is. */
export function deviceToday(): string {
  return localDate(deviceTimeZone())
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  }
  catch {
    return null
  }
}

export function readCachedPlans(userId: number): TripPlan[] | null {
  if (userId <= 0)
    return null
  try {
    const raw = storage()?.getItem(`${CACHE_PREFIX}${userId}`)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed?.plans) ? parsed.plans : null
  }
  catch {
    return null
  }
}

function writeCachedPlans(userId: number, plans: TripPlan[]): void {
  if (userId <= 0)
    return
  const copy = JSON.stringify({ userId, savedAt: new Date().toISOString(), plans })
  try {
    storage()?.setItem(`${CACHE_PREFIX}${userId}`, copy)
  }
  catch {
    // Full or blocked storage costs the offline copy, not the plan.
  }
  if (isNativeMobile())
    void secureStorage.set(NATIVE_KEY, copy).catch(() => {})
}

/**
 * The native copy: this account's when the session knows who that is, and
 * the device owner's when it cannot (offline, no session to ask).
 */
async function readNativePlans(userId: number): Promise<TripPlan[] | null> {
  if (!isNativeMobile())
    return null
  try {
    const raw = await secureStorage.get(NATIVE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed?.plans))
      return null
    return userId > 0 && parsed.userId !== userId ? null : parsed.plans
  }
  catch {
    return null
  }
}

/** Sign-out takes the trips, and their reminders, off the device. */
beforeSignOut(async () => {
  try {
    const store = storage()
    if (store) {
      for (let i = store.length - 1; i >= 0; i--) {
        const key = store.key(i)
        if (key?.startsWith(CACHE_PREFIX))
          store.removeItem(key)
      }
    }
  }
  catch {
    // Nothing more to do without storage.
  }
  if (isNativeMobile()) {
    await secureStorage.delete(NATIVE_KEY).catch(() => {})
    await notifications.cancelAll().catch(() => {})
  }
})

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json()
  }
  catch {
    return {}
  }
}

/**
 * The on-device reminder, for the native app: the same evening-before as the
 * server's in-app notification, but it fires with no network, and it is the
 * only one that reaches a locked phone (the server cannot push).
 *
 * There is no way to cancel one scheduled notification, so every change
 * clears them all and schedules the upcoming set again. Nothing else in the
 * app schedules local notifications, so clearing all clears only these.
 */
async function scheduleNativeReminders(plans: TripPlan[]): Promise<void> {
  if (!isNativeMobile())
    return
  try {
    await notifications.cancelAll()
    const now = Date.now()
    for (const plan of sortPlans(plans, deviceToday()).upcoming) {
      if (!isCalendarDate(plan.planned_for))
        continue
      const eve = addDays(plan.planned_for, -1)
      const [y, m, d] = eve.split('-').map(Number)
      // Local wall-clock time on this device, which is where it will ring.
      const at = new Date(y, m - 1, d, PLAN_REMINDER_HOUR, 0, 0).getTime()
      if (at <= now)
        continue
      await notifications.schedule({
        title: 'Tomorrow on Wildloop',
        body: planReminderBody(plan),
        data: { link: `/plans#plan-${plan.id}` },
        scheduleAt: at,
      })
    }
  }
  catch {
    // A shell without the capability, or a refused permission: the in-app
    // reminder still arrives.
  }
}

export function useTripPlans(wl: PlanStoreLike | null) {
  const plans = state<TripPlan[]>([])
  const loading = state(false)
  const loaded = state(false)
  /** True while the list on screen is the device copy, not a fresh answer. */
  const fromCache = state(false)
  const loadError = state<string | null>(null)

  const userId = (): number => (wl ? wl.currentUserId() : 0)

  function commit(next: TripPlan[]): void {
    plans.set(next)
    writeCachedPlans(userId(), next)
    void scheduleNativeReminders(next)
  }

  async function load(): Promise<void> {
    loading.set(true)
    await initializeAuthSession().catch(() => {})
    if (!isSignedIn()) {
      // No session to ask with — offline in the app, typically. The device
      // copy is still this phone owner's trips; a browser has none to show.
      const copy = await readNativePlans(0)
      if (copy) {
        plans.set(copy)
        fromCache.set(true)
      }
      loading.set(false)
      loaded.set(true)
      return
    }
    const cached = readCachedPlans(userId()) ?? await readNativePlans(userId())
    if (cached && !plans().length)
      plans.set(cached)
    try {
      const response = await apiFetch('/api/plans')
      const body = await readJson(response)
      if (!response.ok || !Array.isArray(body.plans))
        throw new Error(body.error || `Plans could not be loaded (${response.status})`)
      fromCache.set(false)
      loadError.set(null)
      commit(body.plans)
    }
    catch (error) {
      if (cached) {
        plans.set(cached)
        fromCache.set(true)
        loadError.set(null)
      }
      else {
        loadError.set(error instanceof Error && !/fetch/i.test(error.message) ? error.message : 'No connection, and no plans saved on this device yet.')
      }
    }
    finally {
      loading.set(false)
      loaded.set(true)
    }
  }

  async function send(path: string, method: string, input?: TripPlanInput): Promise<{ response: Response | null, body: any }> {
    try {
      const response = await apiFetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: input ? JSON.stringify({ timezone: deviceTimeZone(), ...input }) : undefined,
      })
      return { response, body: await readJson(response) }
    }
    catch {
      return { response: null, body: {} }
    }
  }

  function failure(response: Response | null, body: any, fallback: string): PlanSaveResult {
    if (!response)
      return { ok: false, error: 'No connection. The plan was not saved — try again when you have signal.' }
    return { ok: false, error: body.error && body.error !== 'Validation failed' ? body.error : fallback, fields: body.fields }
  }

  async function create(input: TripPlanInput): Promise<PlanSaveResult> {
    const { response, body } = await send('/api/plans', 'POST', input)
    if (!response?.ok || !body.plan)
      return failure(response, body, 'Check the highlighted fields')
    commit([body.plan, ...plans().filter(p => p.id !== body.plan.id)])
    return { ok: true, plan: body.plan }
  }

  async function update(id: number, input: TripPlanInput): Promise<PlanSaveResult> {
    const { response, body } = await send(`/api/plans/${id}`, 'PATCH', input)
    if (!response?.ok || !body.plan)
      return failure(response, body, 'Check the highlighted fields')
    commit(plans().map(p => (p.id === id ? body.plan : p)))
    return { ok: true, plan: body.plan }
  }

  async function remove(id: number): Promise<PlanSaveResult> {
    const { response, body } = await send(`/api/plans/${id}`, 'DELETE')
    // Already gone is what was asked for.
    if (!response || (!response.ok && response.status !== 404))
      return failure(response, body, 'The plan could not be removed')
    commit(plans().filter(p => p.id !== id))
    return { ok: true }
  }

  /** The next upcoming plan on a trail, if there is one. */
  function nextPlanFor(trailId: number): TripPlan | null {
    return sortPlans(plans().filter(p => p.trail_id === trailId), deviceToday()).upcoming[0] ?? null
  }

  return { plans, loading, loaded, fromCache, loadError, load, create, update, remove, nextPlanFor }
}
