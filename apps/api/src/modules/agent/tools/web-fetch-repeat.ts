// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A REPEAT FETCH OF THE SAME PAGE IS A REFERENCE, NOT A SECOND COPY.
//
// A model fetched the same URL twice in one turn and got the same page twice:
// both copies rode every later step and every later turn. Within a run, a
// web_fetch of a URL already fetched (normalised, same mode and extraction
// query) whose content is identical returns a short reference to the earlier
// result instead of the content again.
//
// Only while the earlier result is still whole: a result the run has clipped
// (stale-result-clipper.ts) is a head of the page, so a repeat fetch then
// returns the full content. Pointing at the earlier result pins it: the run's
// clip ledger records it as final ("left as is"), so it is never clipped later
// in the run and the reference keeps pointing at the whole page. A later turn
// replays both as stored: the earlier result under the replay cap, as the second
// copy would have been, and the reference as the same bytes every time.
// Across turns nothing is referenced: an earlier turn's result replays clipped.

import type { RunContext } from "~/modules/agent/runtime/run-context"
import { SHORT_WEB_FETCH_HINT } from "~/modules/agent/tools/kernel-result-hints"

/** What a repeat fetch answers instead of the page. */
export const REPEAT_FETCH_NOTE =
  "Same page, same content as your earlier kernel__web_fetch of this URL in this turn: that result, above, is the page. Read it there instead of fetching again."

/** A URL as compared for a repeat: scheme and host lower case, no fragment, no default port, no trailing slash. */
export function normalizeFetchUrl(url: string): string {
  try {
    const u = new URL(url.trim())
    u.hash = ""
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname
    return `${u.protocol}//${u.host}${path}${u.search}`
  } catch {
    return url.trim()
  }
}

function fetchKey(args: unknown): string | null {
  const a = (args ?? {}) as { url?: unknown; mode?: unknown; extractionQuery?: unknown }
  if (typeof a.url !== "string") return null
  const mode = typeof a.mode === "string" ? a.mode : "markdown"
  const query = typeof a.extractionQuery === "string" ? a.extractionQuery : ""
  return `${mode}\u0000${query}\u0000${normalizeFetchUrl(a.url)}`
}

/**
 * The result a web_fetch call returns: `result` itself, or the reference to
 * an earlier identical fetch of this run that is still whole (see the header).
 * Records `result` as the fetch later repeats are compared with.
 */
export function repeatFetchResult(
  frame: Pick<RunContext, "clipLedger" | "fetchedPages"> | undefined,
  args: unknown,
  result: unknown,
  toolCallId: string | undefined,
): unknown {
  const ledger = frame?.clipLedger
  if (!frame || !ledger || !toolCallId) return result
  if (!result || typeof result !== "object" || Array.isArray(result)) return result
  const row = result as { content?: unknown; url?: unknown; error?: unknown }
  if (typeof row.content !== "string" || row.error !== undefined) return result
  const key = fetchKey(args)
  if (!key) return result
  frame.fetchedPages ??= new Map()
  const earlier = frame.fetchedPages.get(key)
  // A clip recorded for the earlier result means it is no longer whole.
  if (earlier && earlier.content === row.content && !ledger.get(earlier.toolCallId)) {
    ledger.set(earlier.toolCallId, null)
    return {
      ...(typeof row.url === "string" ? { url: row.url } : {}),
      sameAsEarlierFetch: true,
      note: REPEAT_FETCH_NOTE,
      hint: SHORT_WEB_FETCH_HINT,
    }
  }
  frame.fetchedPages.set(key, { content: row.content, toolCallId })
  return result
}
