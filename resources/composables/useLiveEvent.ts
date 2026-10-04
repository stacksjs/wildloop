import type { EventDetail, LiveBoard } from '../assets/scripts/events-api'
import { derived, effect, onDestroy, onMount, state } from 'stx'
import { fetchEvent, fetchLiveBoard, reportLap, setEventStatus, toggleEventEntry } from '../assets/scripts/events-api'
import { formatClock } from '../functions/backyard'
import { indexInSpotlight, removeFromSpotlight } from './useSpotlightIndex'

/**
 * Watching one event.
 *
 * Two clocks run here and they answer different questions:
 *
 *   - The **poll** asks the server what happened. It is deliberately slow —
 *     laps land at most once per yard, so hammering the endpoint every second
 *     would buy nothing and cost a spectator's battery. It speeds up in the
 *     last minute before a corral, which is the only time the board changes
 *     fast enough to notice.
 *   - The **tick** is local, once a second, and only moves the countdown. The
 *     corral clock has to be smooth; it does not have to be fetched.
 *
 * The tick is anchored to `serverTime` from the last poll rather than to the
 * viewer's own clock. A laptop that is three minutes fast would otherwise show
 * a countdown that disagrees with the one at the start line, which in this
 * format is the difference between making the corral and being out.
 */

const IDLE_POLL_MS = 15_000
const LIVE_POLL_MS = 6_000
const CORRAL_POLL_MS = 2_000

/** Inside this window before a start, the board is worth watching closely. */
const CORRAL_WINDOW_MS = 60_000

export function useLiveEvent(eventId: number | null) {
  const event = state<EventDetail | null>(null)
  const board = state<LiveBoard | null>(null)
  const me = state<{ entered: boolean, status?: string, yardsCompleted?: number, bib?: string | null }>({ entered: false })
  const loading = state(true)
  const notFound = state(false)
  const actionError = state<string | null>(null)
  const working = state(false)

  /** Milliseconds to add to `Date.now()` to land on the server's clock. */
  let clockSkew = 0
  const tick = state(0)

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  function serverNow(): number {
    return Date.now() + clockSkew
  }

  function applyBoard(next: LiveBoard) {
    const stamped = Date.parse(next.serverTime)
    if (Number.isFinite(stamped))
      clockSkew = stamped - Date.now()
    board.set(next)
  }

  function nextPollDelay(): number {
    const current = board()
    if (!current || current.status !== 'live')
      return IDLE_POLL_MS
    return msToStart() <= CORRAL_WINDOW_MS ? CORRAL_POLL_MS : LIVE_POLL_MS
  }

  function schedulePoll() {
    if (stopped || eventId === null)
      return
    pollTimer = setTimeout(async () => {
      const next = await fetchLiveBoard(eventId)
      // A dropped poll keeps the last good board on screen. Blanking the
      // standings because one request timed out at a trailhead would be worse
      // than showing figures that are a few seconds stale.
      if (next)
        applyBoard(next)
      schedulePoll()
    }, nextPollDelay())
  }

  function restartPoll() {
    if (pollTimer)
      clearTimeout(pollTimer)
    schedulePoll()
  }

  /** Milliseconds until the next corral, recomputed locally between polls. */
  function msToStart(): number {
    const current = board()
    if (!current)
      return 0
    const anchor = Date.parse(current.serverTime)
    if (!Number.isFinite(anchor))
      return current.msToNextStart
    const elapsed = serverNow() - anchor
    return Math.max(0, current.msToNextStart - elapsed)
  }

  async function load() {
    if (eventId === null) {
      notFound.set(true)
      loading.set(false)
      return
    }
    const payload = await fetchEvent(eventId)
    if (!payload) {
      notFound.set(true)
      loading.set(false)
      return
    }
    event.set(payload.event)
    applyBoard(payload.live)
    me.set(payload.me ?? { entered: false })
    loading.set(false)
  }

  async function toggleEntry() {
    if (eventId === null || working())
      return
    working.set(true)
    actionError.set(null)
    const result = await toggleEventEntry(eventId)
    working.set(false)
    if (!result?.success) {
      actionError.set(result?.error ?? 'Could not update your entry.')
      return
    }
    me.set({ ...me(), entered: !!result.entered })
    await load()
  }

  async function changeStatus(status: 'live' | 'finished' | 'cancelled') {
    if (eventId === null || working())
      return
    working.set(true)
    actionError.set(null)
    const result = await setEventStatus(eventId, status)
    working.set(false)
    if (!result?.success) {
      actionError.set(result?.error ?? 'Could not update the event.')
      return
    }
    await load()
    restartPoll()
  }

  /** Report the yard the viewer just finished. Used by the host console too. */
  async function recordLap(input: { userId?: number, yard?: number, durationSeconds?: number } = {}) {
    if (eventId === null || working())
      return
    working.set(true)
    actionError.set(null)
    const result = await reportLap(eventId, {
      user_id: input.userId,
      yard: input.yard,
      duration_seconds: input.durationSeconds,
      finished_at: new Date(serverNow()).toISOString(),
    })
    working.set(false)
    if (!result?.success) {
      actionError.set(result?.error ?? 'Could not record that lap.')
      return
    }
    const next = await fetchLiveBoard(eventId)
    if (next)
      applyBoard(next)
    if (!input.userId)
      me.set({ ...me(), yardsCompleted: result.yardsCompleted ?? me().yardsCompleted })
  }

  /**
   * Keep the device's search index on whatever this page knows about the
   * entry, in both directions.
   *
   * Gated on being entered rather than on having opened the event, because
   * entering and withdrawing both reload it: an index that followed the visit
   * would donate an event back the moment somebody withdrew, with the page
   * still open. A no-op off a native host — see useSpotlightIndex.
   */
  let stopIndex: (() => void) | null = null

  onMount(() => {
    void load().then(schedulePoll)
    // Depending on a signal inside an interval is what makes the countdown
    // re-render; the value itself is only a heartbeat.
    tickTimer = setInterval(() => tick.set(tick() + 1), 1000)
    stopIndex = effect(() => {
      const current = event()
      if (!current?.id)
        return

      if (me().entered)
        void indexInSpotlight('event', { id: current.id, name: current.name })
      else
        void removeFromSpotlight('event', current.id)
    })
  })

  onDestroy(() => {
    stopped = true
    if (pollTimer)
      clearTimeout(pollTimer)
    if (tickTimer)
      clearInterval(tickTimer)
    stopIndex?.()
  })

  const countdown = derived(() => {
    tick()
    const current = board()
    if (!current)
      return '—'
    if (current.status === 'scheduled') {
      const start = Date.parse(current.yardStartsAt)
      return Number.isFinite(start) ? formatClock(Math.max(0, start - serverNow())) : '—'
    }
    if (current.status !== 'live')
      return '—'
    return formatClock(msToStart())
  })

  /** How far into the current yard the field is, as a 0–100 percentage. */
  const yardProgress = derived(() => {
    tick()
    const current = board()
    if (!current || current.status !== 'live')
      return 0
    const total = current.msToNextStart + current.msIntoYard
    if (total <= 0)
      return 0
    return Math.min(100, Math.round(((total - msToStart()) / total) * 100))
  })

  const standings = derived(() => board()?.standings ?? [])
  const recentLaps = derived(() => board()?.recentLaps ?? [])
  const stillIn = derived(() => board()?.stillIn ?? 0)
  const currentYard = derived(() => board()?.currentYard ?? 0)
  const isLive = derived(() => board()?.status === 'live')

  return {
    event,
    board,
    me,
    loading,
    notFound,
    actionError,
    working,
    countdown,
    yardProgress,
    standings,
    recentLaps,
    stillIn,
    currentYard,
    isLive,
    reload: load,
    toggleEntry,
    changeStatus,
    recordLap,
  }
}
