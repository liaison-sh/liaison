// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE REPLY THREADS THIS USER FOLLOWS (S11), for the sidebar's "Followed
// threads" section: unread first, then the newest reply. Read from
// `GET /threads/followed-replies` and read again when a reply lands in a thread
// the user follows (or starts following by replying).

import type { FollowedReplyThread } from "@liaison/shared"
import { createStore, reconcile } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"

interface FollowedState {
  items: FollowedReplyThread[]
  loaded: boolean
}

const [state, setState] = createStore<FollowedState>({ items: [], loaded: false })

export function followedReplies(): FollowedReplyThread[] {
  return state.items
}

/** Unread first, then the newest reply; the root id breaks ties, like the server. */
export function sortFollowedReplies(items: readonly FollowedReplyThread[]): FollowedReplyThread[] {
  return [...items].sort((a, b) => {
    const ua = a.unreadCount > 0 ? 1 : 0
    const ub = b.unreadCount > 0 ? 1 : 0
    if (ua !== ub) return ub - ua
    const ta = new Date(a.lastReplyAt).getTime()
    const tb = new Date(b.lastReplyAt).getTime()
    if (ta !== tb) return tb - ta
    return a.rootMessage.id < b.rootMessage.id ? -1 : 1
  })
}

/** Rows the section shows before folding the rest under "More". */
export const FOLLOWED_ROW_CAP = 3
/** A read thread with no reply for this long is history, not news: it folds
 *  even when the cap has room. */
export const FOLLOWED_RECENT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Which followed threads the sidebar shows and which it folds, so the main list
 * carries only what is worth a glance. ALWAYS SHOWN: every thread with unread
 * replies (the fold must never hide news; a folded thread that gets a reply is
 * unread, so it comes back on its own) and the thread whose panel is open. The
 * cap then fills with read threads that had a reply recently, newest first.
 * Everything else folds. Both lists keep the input order (sortFollowedReplies).
 */
export function splitFollowedReplies(
  items: readonly FollowedReplyThread[],
  opts: { activeRootId: string | null; now: number; cap?: number; recentMs?: number },
): { shown: FollowedReplyThread[]; folded: FollowedReplyThread[] } {
  const cap = opts.cap ?? FOLLOWED_ROW_CAP
  const recentMs = opts.recentMs ?? FOLLOWED_RECENT_MS
  const keep = new Set<string>()
  for (const item of items) {
    if (item.unreadCount > 0 || item.rootMessage.id === opts.activeRootId) {
      keep.add(item.rootMessage.id)
    }
  }
  for (const item of items) {
    if (keep.size >= cap) break
    if (opts.now - new Date(item.lastReplyAt).getTime() <= recentMs) keep.add(item.rootMessage.id)
  }
  return {
    shown: items.filter((i) => keep.has(i.rootMessage.id)),
    folded: items.filter((i) => !keep.has(i.rootMessage.id)),
  }
}

let _api: { get: (path: string) => Promise<any> } | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null

export async function loadFollowedReplies(api: { get: (path: string) => Promise<any> }) {
  _api = api
  try {
    const res = await api.get("/threads/followed-replies?limit=50")
    const rows = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    setState({ items: sortFollowedReplies(rows as FollowedReplyThread[]), loaded: true })
  } catch {
    // The section is a convenience: a failed read leaves the last list.
  }
}

/** Debounced reload: a burst of replies is one read. */
export function requestFollowedRepliesReload(delayMs = 250): void {
  if (!_api) return
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    if (_api) void loadFollowedReplies(_api)
  }, delayMs)
}

/** The panel opened on this root: its unread count is zero here too. */
export function markFollowedReplyRead(rootId: string): void {
  const idx = state.items.findIndex((i) => i.rootMessage.id === rootId)
  if (idx < 0 || state.items[idx]?.unreadCount === 0) return
  setState(
    "items",
    sortFollowedReplies(state.items.map((i, k) => (k === idx ? { ...i, unreadCount: 0 } : i))),
  )
}

/**
 * A socket `message` frame. A reply that names this user among its followers,
 * that this user wrote, or that lands in a thread already listed, changes the
 * list; nothing else does.
 */
export function handleFollowedRepliesMessageEvent(
  action: string,
  data: any,
  currentUserId: string | null | undefined,
): void {
  if (action !== "create" && action !== "delete") return
  const rootId = typeof data?.replyRootId === "string" ? data.replyRootId : null
  if (!rootId) return
  const followers: unknown[] = Array.isArray(data?.followerIds) ? data.followerIds : []
  const listed = state.items.some((i) => i.rootMessage.id === rootId)
  const mine =
    !!currentUserId && (followers.includes(currentUserId) || data?.authorId === currentUserId)
  if (listed || mine) requestFollowedRepliesReload()
}

export function resetFollowedReplies(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = null
  _api = null
  setState(reconcile({ items: [], loaded: false }))
}
onSessionTeardown(resetFollowedReplies)
