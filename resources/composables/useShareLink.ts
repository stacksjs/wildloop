/**
 * Share a page, wherever the share is happening.
 *
 * Three environments, one call: the native shell hands the request to the OS
 * sheet, a phone browser uses the Web Share API, and a desktop browser — where
 * `navigator.share` is missing more often than not — copies the link instead.
 * The last case is the reason this exists: `share.share()` throws there, and a
 * share button whose only behaviour is an exception is a dead button.
 */

import { share } from '@stacksjs/mobile'
import { state } from 'stx'

export type ShareOutcome = 'shared' | 'copied' | 'failed'

/** What happened last, for the line under the button. Cleared on its own. */
export const shareNote = state<string | null>(null)

let noteTimer: ReturnType<typeof setTimeout> | null = null

function announce(message: string | null) {
  shareNote.set(message)
  if (noteTimer)
    clearTimeout(noteTimer)
  if (message)
    noteTimer = setTimeout(() => shareNote.set(null), 4000)
}

export interface ShareRequest {
  title: string
  text?: string
  /** Absolute or app-relative; a relative path is resolved against the page. */
  url: string
}

/** The absolute URL a link has to be to survive leaving the browser. */
function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url))
    return url
  if (typeof location === 'undefined')
    return url
  return new URL(url, location.origin).toString()
}

export async function shareLink(request: ShareRequest): Promise<ShareOutcome> {
  const url = absoluteUrl(request.url)

  try {
    await share.share({ title: request.title, text: request.text, url })
    announce(null)
    return 'shared'
  }
  catch (error) {
    // A cancelled sheet is not a failure, and it must not fall through to
    // copying: the visitor said no.
    if (error instanceof DOMException && error.name === 'AbortError') {
      announce(null)
      return 'shared'
    }
  }

  try {
    await navigator.clipboard.writeText(url)
    announce('Link copied to your clipboard.')
    return 'copied'
  }
  catch {
    announce('Could not share this link. Copy it from the address bar.')
    return 'failed'
  }
}
