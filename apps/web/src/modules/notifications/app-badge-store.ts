// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE BADGE (rule 6, one badge, one meaning). The phone's icon, the desktop
// dock and the browser tab title show ONE number: the unread things that
// ask for the person (direct conversations, mentions, replies in reply threads
// they follow, approvals they decide, critical alerts). It is counted by the
// shared `countBadge` (packages/shared/src/notifications/badge.ts), the same
// function the server counts the phone's icon with.
//
// The client's own count reads the thread list it holds (the most recently
// active conversations) and the attention feed, so a direct conversation
// unread outside that list would be missing. The server answers the full
// number at `GET /notifications/badge`; between two reads the badge follows the
// local count (server number plus how far the local count moved since), so a
// read drops it at once, and every local move schedules a fresh read. The
// Messages entry keeps its own number (unread-count-store.ts): every unread
// message in the list, a section count rather than the badge.

import { type BadgeThread, countBadge } from "@liaison/shared"
import { createEffect, createRoot, createSignal, on, untrack } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { hasScope } from "~/modules/auth/auth-store"
import { attentionStore } from "~/modules/shell/attention-store"
import { belongsInChatList, threadStore } from "~/modules/threads/thread-store"

type BadgeApi = { get: (path: string) => Promise<unknown> }

const ACCESS_GRANT_SCOPE = "kernel:scope_requests:admin"
const REFRESH_DEBOUNCE_MS = 300

interface ServerReading {
  count: number
  localAt: number
}

const [reading, setReading] = createSignal<ServerReading | null>(null)
let _api: BadgeApi | null = null
let _timer: ReturnType<typeof setTimeout> | null = null
let _generation = 0
let _disposeSync: (() => void) | null = null

/** The badge as the client's own stores count it. */
export function localAppBadgeCount(): number {
  const threads: BadgeThread[] = []
  for (const id in threadStore.byId) {
    const thread = threadStore.byId[id]
    if (!thread || !belongsInChatList(thread)) continue
    threads.push({
      id: thread.id,
      type: thread.type,
      title: thread.title,
      unreadCount: thread.unreadCount,
      isMuted: thread.isMuted,
    })
  }
  return countBadge({
    threads,
    items: attentionStore.items,
    viewer: { canGrantAccess: hasScope(ACCESS_GRANT_SCOPE) },
  })
}

/** The number every badge shows: the phone's, the dock's and the tab title's. */
export function appBadgeCount(): number {
  const local = localAppBadgeCount()
  const r = reading()
  if (!r) return local
  return Math.max(0, r.count + local - r.localAt)
}

/** Reads the server's number now. A failed read keeps the last one. */
export async function refreshAppBadge(): Promise<void> {
  const api = _api
  if (!api) return
  const generation = ++_generation
  const localAt = untrack(localAppBadgeCount)
  let res: unknown
  try {
    res = await api.get("/notifications/badge")
  } catch {
    return
  }
  if (generation !== _generation) return
  const count = (res as { count?: unknown } | null)?.count
  if (typeof count === "number" && count >= 0) setReading({ count, localAt })
}

/** Schedules a server read, coalescing a burst of changes into one request. */
export function requestAppBadgeRefresh(): void {
  if (!_api) return
  if (_timer) clearTimeout(_timer)
  _timer = setTimeout(() => {
    _timer = null
    void refreshAppBadge()
  }, REFRESH_DEBOUNCE_MS)
}

/** One read now, then one after every move of the local count. */
export function startAppBadgeSync(api: BadgeApi): void {
  _api = api
  _disposeSync?.()
  _disposeSync = createRoot((dispose) => {
    createEffect(on(localAppBadgeCount, () => requestAppBadgeRefresh(), { defer: true }))
    return dispose
  })
  void refreshAppBadge()
}

export function resetAppBadgeStore(): void {
  _disposeSync?.()
  _disposeSync = null
  if (_timer) clearTimeout(_timer)
  _timer = null
  _generation++
  _api = null
  setReading(null)
}

onSessionTeardown(resetAppBadgeStore)
