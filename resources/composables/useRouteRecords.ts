import type {
  EffortDetailView,
  RecordCategory,
  RecordDirection,
  RecordEffortView,
  RecordStyle,
  TrackedEffort,
  TrailRecordsView,
} from '../assets/scripts/records-api'
import { derived, onDestroy, onMount, state } from 'stx'
import {
  fetchEffort,
  fetchRecords,
  fetchTracking,
  fetchTrailRecords,
  fileEffort,
  reviewEffort,
  updateEffort,
  withdrawEffort,
} from '../assets/scripts/records-api'
import { formatClock } from '../functions/backyard'
import { CATEGORY_LABELS, DIRECTION_LABELS, STATUS_LABELS, STYLE_LABELS } from '../functions/route-records'

/**
 * The records surfaces: the latest-records feed, the tracking board, one
 * route's board, and the submit form.
 *
 * The labels are re-exported from the shared module rather than restated here
 * so the server's grouping and the page's headings can never drift — a board
 * captioned "Self-supported" that the API filed under `supported` is the kind
 * of bug that only shows up in a screenshot on a forum.
 */
export { CATEGORY_LABELS, DIRECTION_LABELS, STATUS_LABELS, STYLE_LABELS }

/**
 * The tracking board refreshes on its own.
 *
 * Slow on purpose: an attempt is hours or days long, so a tighter poll would
 * cost battery to redraw the same rows. Thirty seconds is enough that a page
 * left open at a finish line notices a finish within a reasonable window.
 */
const TRACKING_REFRESH_MS = 30_000

/** The records index: latest verified times, plus what is running right now. */
export function useRecordsFeed() {
  const tab = state<'latest' | 'tracking'>('latest')
  const records = state<RecordEffortView[]>([])
  const tracking = state<TrackedEffort[]>([])
  const loading = state(true)
  const loadError = state<string | null>(null)

  const styleFilter = state<RecordStyle | 'all'>('all')
  const categoryFilter = state<RecordCategory | 'all'>('all')

  let timer: ReturnType<typeof setInterval> | null = null

  async function loadLatest() {
    const result = await fetchRecords({
      style: styleFilter() === 'all' ? undefined : styleFilter() as RecordStyle,
      category: categoryFilter() === 'all' ? undefined : categoryFilter() as RecordCategory,
      limit: 40,
    })
    if (result === null) {
      loadError.set('Could not reach the records service.')
      loading.set(false)
      return
    }
    loadError.set(null)
    records.set(result.efforts)
    loading.set(false)
  }

  async function loadTracking() {
    const result = await fetchTracking()
    // Only the visible tab owns the spinner. This also runs in the background
    // to fill the tab's count, and clearing `loading` from there would uncover
    // a latest-records list that has not arrived yet.
    const ownsSpinner = tab() === 'tracking'
    // A failed poll keeps the last good board rather than blanking it: a
    // dropped request is not news, and an empty tracking board reads as
    // "nobody is out there", which would be a lie.
    if (result === null) {
      if (ownsSpinner)
        loading.set(false)
      return
    }
    tracking.set(result)
    if (ownsSpinner) {
      loadError.set(null)
      loading.set(false)
    }
  }

  function load() {
    return tab() === 'tracking' ? loadTracking() : loadLatest()
  }

  function setTab(next: 'latest' | 'tracking') {
    if (tab() === next)
      return
    tab.set(next)
    loading.set(true)
    void load()
  }

  function applyFilter(next: { style?: RecordStyle | 'all', category?: RecordCategory | 'all' }) {
    if (next.style !== undefined)
      styleFilter.set(next.style)
    if (next.category !== undefined)
      categoryFilter.set(next.category)
    loading.set(true)
    void loadLatest()
  }

  onMount(() => {
    void load()
    // Both on first paint, whichever tab is showing: the tracking count is on
    // the tab itself, and a badge that only appears once you have already
    // clicked through is a badge that never told anyone anything.
    if (tab() !== 'tracking')
      void loadTracking()
    timer = setInterval(() => {
      // Only the tracking board is time-sensitive. Re-polling the latest feed
      // every 30s would redraw a list that changes a few times a week.
      if (tab() === 'tracking')
        void loadTracking()
    }, TRACKING_REFRESH_MS)
  })

  onDestroy(() => {
    if (timer)
      clearInterval(timer)
    timer = null
  })

  return {
    tab,
    records,
    tracking,
    loading,
    loadError,
    styleFilter,
    categoryFilter,
    setTab,
    applyFilter,
    reload: load,
  }
}

/**
 * One route's board, for the trail page's records section.
 *
 * The returned keys are prefixed so a caller can destructure them straight
 * into a template that already has a `loading` and a `board` of its own.
 */
export function useTrailRecords(trailId: number) {
  const recordBoard = state<TrailRecordsView | null>(null)
  const recordsLoading = state(true)
  const recordsError = state<string | null>(null)

  async function load() {
    // `-1` is the no-match sentinel the detail pages pass when the route param
    // could not be resolved, so guard the range rather than just falsiness.
    if (!trailId || trailId <= 0) {
      recordsLoading.set(false)
      return
    }
    const result = await fetchTrailRecords(trailId)
    if (result === null) {
      recordsError.set('Could not load this route’s records.')
      recordsLoading.set(false)
      return
    }
    recordsError.set(null)
    recordBoard.set(result)
    recordsLoading.set(false)
  }

  const hasRecords = derived(() => (recordBoard()?.boards.length ?? 0) > 0)
  // Unknown reads as rankable: the section is hidden until the board arrives,
  // and flashing "this route cannot carry records" during the fetch would be
  // wrong for almost every route it appeared on.
  const recordsRankable = derived(() => recordBoard()?.rankable !== false)

  onMount(() => {
    void load()
  })

  return { recordBoard, recordsLoading, recordsError, hasRecords, recordsRankable, reloadRecords: load }
}

/**
 * The submit form.
 *
 * Two shapes in one, because they are the same claim at different times: an
 * attempt announced before the start (a tracker link, no finish) and a
 * finished one (a time and its evidence). Which one is being filed is decided
 * by whether a finish was entered, not by a mode switch the athlete has to
 * find.
 */
export function useRecordSubmission(defaults: { trailId?: number } = {}) {
  // Claim-prefixed for the same reason `useTrailRecords` prefixes its own
  // keys: the trail page hosts both composables at once.
  const claimOpen = state(false)
  const claimSubmitting = state(false)
  const claimError = state<string | null>(null)
  const claimFieldErrors = state<Record<string, string>>({})
  const claimFiled = state<RecordEffortView | null>(null)

  const fTrailId = state(defaults.trailId ? String(defaults.trailId) : '')
  const fStyle = state<RecordStyle>('self_supported')
  const fCategory = state<RecordCategory>('mens')
  const fDirection = state<RecordDirection>('standard')
  const fTeamSize = state('1')
  const fStartedAt = state(toLocalInputValue(new Date().toISOString()))
  const fFinishedAt = state('')
  const fEvidenceUrl = state('')
  const fTrackerUrl = state('')
  const fTripReport = state('')
  const fActivityId = state('')

  /** An entry with no finish is an announcement; with one, it is a claim. */
  const isAnnouncement = derived(() => !fFinishedAt().trim())

  function resetClaim() {
    fStyle.set('self_supported')
    fCategory.set('mens')
    fDirection.set('standard')
    fTeamSize.set('1')
    fStartedAt.set(toLocalInputValue(new Date().toISOString()))
    fFinishedAt.set('')
    fEvidenceUrl.set('')
    fTrackerUrl.set('')
    fTripReport.set('')
    fActivityId.set('')
    claimError.set(null)
    claimFieldErrors.set({})
    claimFiled.set(null)
  }

  function openClaim(trailId?: number) {
    resetClaim()
    if (trailId)
      fTrailId.set(String(trailId))
    claimOpen.set(true)
  }

  function closeClaim() {
    claimOpen.set(false)
  }

  async function submitClaim(): Promise<RecordEffortView | null> {
    if (claimSubmitting())
      return null
    claimSubmitting.set(true)
    claimError.set(null)
    claimFieldErrors.set({})

    const result = await fileEffort({
      trail_id: Number(fTrailId()),
      style: fStyle(),
      category: fCategory(),
      direction: fDirection(),
      team_size: Number(fTeamSize()) || 1,
      started_at: fromLocalInputValue(fStartedAt()),
      finished_at: fFinishedAt().trim() ? fromLocalInputValue(fFinishedAt()) : null,
      evidence_url: fEvidenceUrl().trim() || null,
      tracker_url: fTrackerUrl().trim() || null,
      trip_report: fTripReport().trim() || null,
      activity_id: Number(fActivityId()) || null,
    })

    claimSubmitting.set(false)
    if (!result) {
      claimError.set('Could not reach the records service. Your entry was not saved.')
      return null
    }
    if (!result.success) {
      claimError.set(result.error ?? 'That entry was not accepted.')
      claimFieldErrors.set(result.fields ?? {})
      return null
    }
    claimFiled.set(result.effort ?? null)
    claimOpen.set(false)
    return result.effort ?? null
  }

  return {
    claimOpen,
    claimSubmitting,
    claimError,
    claimFieldErrors,
    claimFiled,
    isAnnouncement,
    fTrailId,
    fStyle,
    fCategory,
    fDirection,
    fTeamSize,
    fStartedAt,
    fFinishedAt,
    fEvidenceUrl,
    fTrackerUrl,
    fTripReport,
    fActivityId,
    openClaim,
    closeClaim,
    resetClaim,
    submitClaim,
  }
}

/** One attempt's page: the trip report, its rank, and the owner/reviewer tools. */
export function useEffortDetail(effortId: number) {
  const effort = state<EffortDetailView | null>(null)
  const loading = state(true)
  const loadError = state<string | null>(null)
  const working = state(false)
  const actionError = state<string | null>(null)

  const fFinishedAt = state('')
  const fReviewNote = state('')

  // A live attempt's clock. The API has no elapsed time for an attempt that
  // has not finished — `elapsedLabel` is a dash until then — so the page
  // showed "—" in the one place a spectator looks first. Counted here from
  // the start, the same way the tracking board counts it.
  const now = state(Date.now())
  const isLive = derived(() => effort()?.status === 'in_progress')
  const liveClock = derived(() => {
    const current = effort()
    if (!current || current.status !== 'in_progress')
      return ''
    const started = Date.parse(current.startedAt)
    return Number.isFinite(started) ? formatClock(now() - started) : ''
  })

  let clockTimer: ReturnType<typeof setInterval> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function load() {
    const result = await fetchEffort(effortId)
    if (result === null) {
      loadError.set('That attempt could not be found.')
      loading.set(false)
      return
    }
    loadError.set(null)
    effort.set(result)
    loading.set(false)
  }

  async function run<T>(work: () => Promise<{ success: boolean, error?: string } | null>): Promise<boolean> {
    if (working())
      return false
    working.set(true)
    actionError.set(null)
    const result = await work()
    working.set(false)
    if (!result) {
      actionError.set('Could not reach the records service.')
      return false
    }
    if (!result.success) {
      actionError.set(result.error ?? 'That did not work.')
      return false
    }
    await load()
    return true
  }

  const finish = () => run(() => updateEffort(effortId, { finished_at: fromLocalInputValue(fFinishedAt()) }))
  const markDnf = () => run(() => updateEffort(effortId, { outcome: 'dnf' }))
  const withdraw = () => run(() => withdrawEffort(effortId))
  const verify = () => run(() => reviewEffort(effortId, 'verify', fReviewNote().trim() || undefined))
  const reject = () => run(() => reviewEffort(effortId, 'reject', fReviewNote().trim()))
  const reopen = () => run(() => reviewEffort(effortId, 'reopen', fReviewNote().trim() || undefined))

  onMount(() => {
    void load()
    clockTimer = setInterval(() => {
      if (isLive())
        now.set(Date.now())
    }, 1000)
    // A finish, a DNF or a withdrawal should reach somebody watching without a
    // reload. Same cadence as the tracking board, and only while it is live.
    pollTimer = setInterval(() => {
      if (isLive() && !working())
        void load()
    }, TRACKING_REFRESH_MS)
  })

  onDestroy(() => {
    if (clockTimer)
      clearInterval(clockTimer)
    if (pollTimer)
      clearInterval(pollTimer)
    clockTimer = null
    pollTimer = null
  })

  return {
    effort,
    loading,
    loadError,
    working,
    actionError,
    isLive,
    liveClock,
    fFinishedAt,
    fReviewNote,
    finish,
    markDnf,
    withdraw,
    verify,
    reject,
    reopen,
    reload: load,
  }
}

/** `2026-08-25T07:00` — the shape `<input type="datetime-local">` speaks. */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Back to an ISO instant.
 *
 * `datetime-local` has no zone, so the browser's own offset is what turns
 * "07:00" into a moment. A record's elapsed time is the difference between
 * two of these, so both ends have to be read the same way or a run that
 * crosses a DST boundary gains or loses an hour.
 */
export function fromLocalInputValue(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}
