/**
 * Fetch client for the trail photo review queue on /admin/photos (#1006).
 *
 * Both endpoints are admin-only and say so with a 401 or 403, which the page
 * shows as it is rather than as an empty queue: "nothing to review" and "you
 * may not review" are different answers.
 */

import { apiFetch, csrfToken, readyToken } from './auth'

export interface PhotoQueueCandidate {
  id: number
  title: string
  url: string
  pageUrl: string
  credit: string
  license: string
  licenseUrl: string
  matched: string[]
}

export interface PhotoQueueTrail {
  id: number
  name: string
  location: string
  state: string
  lat: number
  lng: number
  distance: number
  priority: number
  line: Array<[number, number]>
  candidates: PhotoQueueCandidate[]
}

export interface PhotoQueueResult {
  ok: boolean
  status: number
  error: string
  trails: PhotoQueueTrail[]
  pendingTrails: number
  pendingCandidates: number
}

export type PhotoDecision = 'approve' | 'reject' | 'reopen'

export async function fetchPhotoQueue(limit = 20): Promise<PhotoQueueResult> {
  try {
    const res = await apiFetch(`/api/admin/trail-photos?limit=${limit}`, { headers: { Accept: 'application/json' } })
    const payload = await res.json().catch(() => null) as any
    return {
      ok: res.ok && payload?.success === true,
      status: res.status,
      error: String(payload?.error ?? (res.ok ? '' : `The queue answered ${res.status}`)),
      trails: Array.isArray(payload?.trails) ? payload.trails : [],
      pendingTrails: Number(payload?.pendingTrails) || 0,
      pendingCandidates: Number(payload?.pendingCandidates) || 0,
    }
  }
  catch {
    return { ok: false, status: 0, error: 'The queue could not be reached.', trails: [], pendingTrails: 0, pendingCandidates: 0 }
  }
}

export async function reviewTrailPhoto(id: number, decision: PhotoDecision): Promise<{ ok: boolean, error: string }> {
  await readyToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  const csrf = csrfToken()
  if (csrf)
    headers['X-CSRF-Token'] = csrf
  try {
    const res = await apiFetch(`/api/admin/trail-photos/${id}/review`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ decision }),
    })
    const payload = await res.json().catch(() => null) as any
    return { ok: res.ok && payload?.success === true, error: String(payload?.error ?? '') }
  }
  catch {
    return { ok: false, error: 'The decision could not be sent.' }
  }
}
