// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ANOTHER DEVICE OF MINE READ SOMETHING. The server sends a `kernel:read_state`
// frame to every socket of the reader after any read mark moves (api
// modules/threads/read-state-broadcast.ts), and this applies it here, so a
// thread read on the phone loses its unread pill on the laptop at once, and
// the other way round. The frame only ever reaches its own reader (the socket
// fan-out filters on `forUserId`), so it is applied without a second check.

//
// The same frame carries the reader's own mute / archive / pin flags
// (`thread_state`): the flags as stored, applied as values. An archive removes
// the thread from the live list (and its dock tab), exactly as archiving on
// this device does; an unarchive reloads the list, which is where the thread
// comes back from.

import { requestAppBadgeRefresh } from "~/modules/notifications/app-badge-store"
import { withdrawThreadNotifications } from "~/modules/notifications/native-bridge"
import { markFollowedReplyRead } from "~/modules/threads/followed-replies-store"
import {
  getThread,
  removeArchivedThread,
  removeThread,
  requestThreadReload,
  setThreadMuted,
  setThreadNotifyAllPosts,
  setThreadPinnedByUser,
  setThreadUnreadCount,
} from "~/modules/threads/thread-store"
import { requestUnreadCountRefresh } from "~/modules/threads/unread-count-store"

export interface ReadStateSyncDeps {
  /** Refetch the attention feed (Home, badges): its rows are read server side. */
  reloadAttention: () => void
  /** Apply the holder's relayed assistant-mail switch (it verifies an "on" itself). */
  applyAgentMailAccess?: (data: Record<string, unknown>) => void
}

export function handleReadStateEvent(action: string, data: any, deps: ReadStateSyncDeps): void {
  if (action !== "update" || !data || typeof data !== "object") return
  switch (data.kind) {
    case "thread": {
      if (typeof data.threadId !== "string") return
      // The server's own count after the move: a message that landed while the
      // other device was reading is still unread, and stays so here.
      const count =
        typeof data.unreadCount === "number" && data.unreadCount >= 0 ? data.unreadCount : 0
      setThreadUnreadCount(data.threadId, count)
      // Rule 5: read everywhere, so the channel's own notifications leave
      // this computer (its replies' leave with their reply thread's read).
      if (count === 0) void withdrawThreadNotifications(data.threadId)
      // The read is committed now: the Messages badge reads the server total
      // again, including for a thread outside the client list.
      requestUnreadCountRefresh()
      requestAppBadgeRefresh()
      return
    }
    case "reply_thread": {
      if (typeof data.rootId === "string") {
        markFollowedReplyRead(data.rootId)
        // Rule 5: that reply thread's notifications leave this computer.
        if (typeof data.threadId === "string")
          void withdrawThreadNotifications(data.threadId, data.rootId)
      }
      // Reading a reply thread also reads its followup attention row.
      deps.reloadAttention()
      requestAppBadgeRefresh()
      return
    }
    case "thread_state": {
      if (typeof data.threadId !== "string") return
      applyThreadState(data.threadId, data)
      // A mute or archive moves the server total too (muted threads never count).
      requestUnreadCountRefresh()
      requestAppBadgeRefresh()
      return
    }
    case "attention": {
      deps.reloadAttention()
      requestAppBadgeRefresh()
      return
    }
    case "agent_mail_access": {
      deps.applyAgentMailAccess?.(data)
      return
    }
  }
}

function applyThreadState(threadId: string, data: Record<string, unknown>): void {
  if (data.isArchived === true) {
    if (getThread(threadId)) removeThread(threadId)
    return
  }
  const known = getThread(threadId)
  if (!known) {
    // Unarchived elsewhere (or never loaded here): the list is where it
    // comes back from, and the archived view must not keep showing it.
    if (data.isArchived === false) {
      removeArchivedThread(threadId)
      requestThreadReload()
    }
    return
  }
  if (typeof data.isMuted === "boolean" && known.isMuted !== data.isMuted) {
    setThreadMuted(threadId, data.isMuted)
  }
  if (
    typeof data.notifyAllPosts === "boolean" &&
    (known.notifyAllPosts === true) !== data.notifyAllPosts
  ) {
    setThreadNotifyAllPosts(threadId, data.notifyAllPosts)
  }
  if (typeof data.isPinned === "boolean" && known.isPinnedByUser !== data.isPinned) {
    setThreadPinnedByUser(threadId, data.isPinned)
  }
}
