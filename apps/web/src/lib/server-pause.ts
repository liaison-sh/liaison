// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the app is waiting on, for the shell's pause notice
// (modules/shell/ServerPauseNotice.tsx): whether the SERVER said it is
// restarting, and since when the oldest API request is in flight.
//
// "The server is restarting" is only ever set by a positive signal from the
// server itself: its socket closed with 1012 (Service Restart, which a draining
// process sends to every socket it holds) or an answer 503 with code
// RESTARTING. A socket that just drops, a fetch that fails, a device that went
// offline say nothing about the server, and set nothing here: the notice then
// talks about the connection, never about an update.
// THE WRITERS NEVER SUBSCRIBE. `trackRequest` runs inside whatever starts a
// request, often a component effect (a thread view marking itself read), and a
// tracked read of `oldestPendingAt` there made that effect depend on it: the
// request settling re-ran the effect, which sent the request again, once per
// round trip, until the per-user rate limit refused everything. The writers
// read their signals with `untrack`; only the notice subscribes.
import { createSignal, untrack } from "solid-js"

/** The code a draining server answers 503 with (apps/api agent routes). */
export const SERVER_RESTARTING_CODE = "RESTARTING"

const [restartSignalAt, setRestartSignalAt] = createSignal<number | null>(null)
const [oldestPendingAt, setOldestPendingAt] = createSignal<number | null>(null)

const pending = new Map<number, number>()
let nextRequestId = 0

/**
 * `restartSignalAt`: when the server said it is restarting, until something says
 * it is back. `oldestPendingAt`: when the oldest request in flight started.
 * Null otherwise.
 */
export { oldestPendingAt, restartSignalAt }

/** The server said it is restarting (a 1012 close, a 503 RESTARTING). Keeps the first time seen. */
export function noteServerRestarting(): void {
  if (untrack(restartSignalAt) === null) setRestartSignalAt(Date.now())
}

/** The server is back: the socket reconnected, or a request was answered while it is up. */
export function noteServerBack(): void {
  if (untrack(restartSignalAt) !== null) setRestartSignalAt(null)
}

/** True when this response is a draining server's 503 RESTARTING. Never consumes the body. */
export async function isRestartingResponse(response: Response): Promise<boolean> {
  if (response.status !== 503) return false
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } } | null
    return body?.error?.code === SERVER_RESTARTING_CODE
  } catch {
    return false
  }
}

/** The longest a client waits on a Retry-After before its one retry. */
export const RESTART_RETRY_MAX_MS = 5_000

/**
 * How long to wait before retrying a 503 RESTARTING: the server's
 * Retry-After (seconds), else a second, never more than RESTART_RETRY_MAX_MS.
 * The draining server refused before it saved anything, so the one retry,
 * which reaches a live process, cannot double the request.
 */
export function restartRetryDelayMs(response: Response): number {
  const raw = response.headers.get("retry-after")
  const seconds = raw === null || raw.trim() === "" ? Number.NaN : Number(raw.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000
  return Math.min(Math.round(seconds * 1_000), RESTART_RETRY_MAX_MS)
}

/** One API request starts; call the returned function when it settles (answered or failed). */
export function trackRequest(): () => void {
  const id = nextRequestId++
  pending.set(id, Date.now())
  if (untrack(oldestPendingAt) === null) setOldestPendingAt(Date.now())
  let done = false
  return () => {
    if (done) return
    done = true
    pending.delete(id)
    let oldest: number | null = null
    for (const at of pending.values()) if (oldest === null || at < oldest) oldest = at
    setOldestPendingAt(oldest)
  }
}

/** Test access: forget every signal and request. */
export const ServerPauseTestAccess = {
  reset(): void {
    pending.clear()
    setRestartSignalAt(null)
    setOldestPendingAt(null)
  },
}
