// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE MESSAGES BADGE (S8, A14). The thread store's `totalUnreadCount()` sums the
// threads the client list holds, which is the 50 most recently active ones, so
// unread messages in an older thread never reached a badge. The server answers
// the real total at `GET /threads/unread-count` (the same count the app icon
// shows), and this store holds it.
//
// Between two server reads the badge follows the local list: the server total
// plus how far the local sum has moved since that read. Reading a thread drops
// the badge at once instead of after a round trip, and a message landing in a
// listed thread raises it at once. Every local move also schedules a fresh
// server read, which settles the total again; so does a read-state frame from
// the server (read on another device, or this device's own read committed).
// Before the first server read, the local sum is all there is.

import { createEffect, createRoot, createSignal, on, untrack } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { totalUnreadCount } from "~/modules/threads/thread-store"

type UnreadCountApi = { get: (path: string) => Promise<any> }

interface ServerReading {
  count: number
  /** The local sum when the read was sent: the badge adds the local delta since. */
  localAt: number
}

const REFRESH_DEBOUNCE_MS = 300

const [reading, setReading] = createSignal<ServerReading | null>(null)
let _api: UnreadCountApi | null = null
let _timer: ReturnType<typeof setTimeout> | null = null
let _generation = 0
let _disposeSync: (() => void) | null = null

/** The number the Messages entry shows. */
export function messagesUnreadCount(): number {
  const local = totalUnreadCount()
  const r = reading()
  if (!r) return local
  return Math.max(0, r.count + local - r.localAt)
}

export function setUnreadCountApi(api: UnreadCountApi | null): void {
  _api = api
}

/** Reads the server total now. A failed read keeps the last one. */
export async function refreshUnreadCount(): Promise<void> {
  const api = _api
  if (!api) return
  const generation = ++_generation
  const localAt = untrack(totalUnreadCount)
  let res: any
  try {
    res = await api.get("/threads/unread-count")
  } catch {
    return
  }
  if (generation !== _generation) return // a newer read owns the badge
  // The api client's `get` unwraps the `{ data }` envelope: `res` IS `{ count }`.
  const count = res?.count
  if (typeof count === "number" && count >= 0) setReading({ count, localAt })
}

/** Schedules a server read, coalescing a burst of changes into one request. */
export function requestUnreadCountRefresh(): void {
  if (!_api) return
  if (_timer) clearTimeout(_timer)
  _timer = setTimeout(() => {
    _timer = null
    void refreshUnreadCount()
  }, REFRESH_DEBOUNCE_MS)
}

/**
 * Starts keeping the badge current for this session: one read now, then one
 * after every move of the local unread sum. Called once the thread list has
 * loaded, so the first reading's baseline is the hydrated list.
 */
export function startUnreadCountSync(api: UnreadCountApi): void {
  setUnreadCountApi(api)
  _disposeSync?.()
  _disposeSync = createRoot((dispose) => {
    createEffect(on(totalUnreadCount, () => requestUnreadCountRefresh(), { defer: true }))
    return dispose
  })
  void refreshUnreadCount()
}

export function resetUnreadCountStore(): void {
  _disposeSync?.()
  _disposeSync = null
  if (_timer) clearTimeout(_timer)
  _timer = null
  _generation++
  _api = null
  setReading(null)
}

onSessionTeardown(resetUnreadCountStore)
