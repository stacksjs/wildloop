/**
 * Recent reviewers for the trails currently on screen.
 *
 * Fetched after the results land rather than with them: the faces are the last
 * thing on a card and the first thing worth dropping, so the list renders at
 * the speed of the catalog query and fills in a moment later. Nothing here
 * throws — a card with no faces is simply a card.
 */

import { state } from 'stx'

export interface Reviewer {
  id: number
  name: string
}

export interface ReviewerSummary {
  recentCount: number
  reviewers: Reviewer[]
}

/** Summaries by trail id, for every trail asked about so far this session. */
export const trailReviewers = state<Record<number, ReviewerSummary>>({})

/** The window the counts describe, as the API reports it. */
export const reviewerWindowDays = state(30)

/** Ids already answered for, so scrolling back does not re-ask. */
const answered = new Set<number>()

/** The most ids one request may carry, matching the endpoint's own cap. */
const MAX_IDS = 60

export function reviewersFor(trailId: number): ReviewerSummary | null {
  return trailReviewers()[trailId] ?? null
}

/**
 * Ask about a page of trails, skipping the ones already answered.
 *
 * A trail with no recent reviews comes back absent from the payload, and is
 * still marked answered — the absence is the answer, and asking again on every
 * keystroke would be a request per render for a row that will stay empty.
 */
export async function loadReviewers(trailIds: number[]): Promise<void> {
  const wanted: number[] = []

  for (const id of trailIds) {
    const trailId = Number(id)
    if (!Number.isSafeInteger(trailId) || trailId <= 0 || answered.has(trailId))
      continue
    answered.add(trailId)
    wanted.push(trailId)
    if (wanted.length >= MAX_IDS)
      break
  }

  if (wanted.length === 0)
    return

  try {
    const res = await fetch(`/api/trails/reviewers?ids=${wanted.join(',')}`)
    if (!res.ok)
      return

    const payload = await res.json()
    if (!payload?.success || !payload.trails)
      return

    const merged: Record<number, ReviewerSummary> = { ...trailReviewers() }
    for (const [key, value] of Object.entries(payload.trails as Record<string, ReviewerSummary>)) {
      const trailId = Number(key)
      if (!Number.isFinite(trailId) || !value)
        continue
      merged[trailId] = {
        recentCount: Number(value.recentCount) || 0,
        reviewers: Array.isArray(value.reviewers) ? value.reviewers.slice(0, 3) : [],
      }
    }

    trailReviewers.set(merged)
    if (Number(payload.windowDays) > 0)
      reviewerWindowDays.set(Number(payload.windowDays))
  }
  catch {
    // Offline, or the endpoint is down. The cards keep everything else they
    // have; a retry would be a request per failing render.
  }
}
