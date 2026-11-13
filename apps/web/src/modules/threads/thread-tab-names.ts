// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CONVERSATION TAB CARRIES THE CONVERSATION'S CURRENT NAME.
//
// The thread tab type names its tab from the thread store, and the store holds
// only the live list (the 50 most recent, never an archived one). A tab whose
// conversation is not in that list kept the label it was opened with for the
// rest of time: four channels opened while they were misread as the "Personal
// agent" DM still read "Personal agent" after the classification fix, and a
// rename made elsewhere never reached a tab whose conversation was archived.
//
// So a tab the list cannot name reads its conversation by id (GET
// /threads/:id, the read RoutineDetail makes for a destination outside the
// list), once, and again whenever a thread or participant event names it. The
// answer is also written into the stored tab label, so a restored tab starts
// with the right name before anything has loaded.

import { createSignal } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { ApiError } from "~/lib/api-error"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { userFromToken } from "~/modules/auth/auth-store"
import { makeTabId, tabStore, updateTabLabel } from "~/modules/shell/tab-store"
import { conversationDisplayName } from "~/modules/threads/conversation-display"
import {
  getThread,
  normalizeThread,
  subscribeThreadRemoved,
  type Thread,
} from "~/modules/threads/thread-store"

type ThreadTabNamesApi = { get: (path: string) => Promise<any> }

// Started once the session's thread list has loaded: before that every tab
// misses the store, and reading each one by id would only race the list.
const [api, setApi] = createSignal<ThreadTabNamesApi | null>(null)
const [fetched, setFetched] = createStore<Record<string, Thread>>({})
const requested = new Set<string>()
// Conversations the server answered "not there" for (deleted, another
// workspace's, no longer the viewer's): what still points at one lets go of it.
const [gone, setGone] = createStore<Record<string, true>>({})

export function startThreadTabNames(client: ThreadTabNamesApi): void {
  setApi(() => client)
}

/**
 * The conversation an open tab shows: the list's copy, else the one read by id
 * (kept current by thread events). The view's own header reads it too, so a
 * conversation archived while open keeps its current name there as well.
 */
export function threadForTab(threadId: string): Thread | undefined {
  return getThread(threadId) ?? fetched[threadId]
}

/**
 * The name of the conversation tab `threadId` for `viewerId`, or undefined while
 * neither the list nor a read by id has answered (the stored label stands until
 * then). A miss asks the server once.
 */
export function threadTabLabel(threadId: string, viewerId: string): string | undefined {
  if (!threadId) return undefined
  const thread = threadForTab(threadId)
  if (thread) return conversationDisplayName(thread, viewerId)
  if (api()) requestThreadTabName(threadId)
  return undefined
}

/**
 * The conversation a dock item shows. The dock outlives the list too: an item
 * restored from an earlier visit, or one whose conversation fell out of the 50
 * most recent, read "Conversation" with an empty face for good. A miss asks
 * the server once; `threadIsGone` then says when there is nothing to show.
 */
export function threadForDock(threadId: string): Thread | undefined {
  if (!threadId) return undefined
  const thread = threadForTab(threadId)
  if (!thread && api()) requestThreadTabName(threadId)
  return thread
}

/** The server said this conversation is not there for the viewer (404 or 403). */
export function threadIsGone(threadId: string): boolean {
  return gone[threadId] === true
}

function requestThreadTabName(threadId: string): void {
  if (requested.has(threadId)) return
  requested.add(threadId)
  // Out of the reactive read that asked: the store write must not land inside it.
  queueMicrotask(() => void readThreadForTab(threadId))
}

async function readThreadForTab(threadId: string): Promise<void> {
  const client = api()
  if (!client) {
    requested.delete(threadId)
    return
  }
  try {
    const res = await client.get(`/threads/${threadId}`)
    if (client !== api()) return // the session it belonged to is gone
    const data = res?.data ?? res
    if (data?.id !== threadId) return
    setFetched(threadId, normalizeThread(data))
    syncStoredLabel(threadId)
  } catch (err) {
    // A refusal or a network error leaves the stored label; the tab's own view
    // decides whether the conversation is gone (ThreadView closes it on 404/403).
    // A dock item has no view while it is collapsed: it reads the answer here.
    if (client !== api()) return
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
      setGone(threadId, true)
    }
  }
}

/** Write the current name into the stored tab label (what a restored tab shows first). */
function syncStoredLabel(threadId: string): void {
  const tabId = makeTabId("thread", threadId)
  const tab = tabStore.tabs.find((t) => t.id === tabId)
  if (!tab) return
  const thread = threadForTab(threadId)
  if (!thread) return
  const label = conversationDisplayName(thread, userFromToken()?.userId ?? "")
  if (label && label !== tab.label) updateTabLabel(tabId, label)
}

/**
 * A thread or participant event named `threadId`. A tab the list names follows
 * the list already; a tab named by a read by id takes a new title at once and
 * reads again (a member change, anything the event does not carry).
 */
export function noteThreadChangedForTabs(
  threadId: string | undefined,
  changes?: { title?: string | null },
): void {
  if (!threadId || !api()) return
  if (getThread(threadId)) return
  const open = tabStore.tabs.some((t) => t.id === makeTabId("thread", threadId))
  if (!open && !fetched[threadId]) return
  if (fetched[threadId] && typeof changes?.title === "string") {
    setFetched(threadId, "title", changes.title)
    syncStoredLabel(threadId)
  }
  requested.delete(threadId)
  requestThreadTabName(threadId)
}

// The conversation of an open tab leaves the list (archived here or on another
// device): the copy the list held is the current one, so it is kept, and the
// tab and its view never fall back to an older name in between.
subscribeThreadRemoved((thread) => {
  if (!tabStore.tabs.some((t) => t.id === makeTabId("thread", thread.id))) return
  const copy = unwrap(thread)
  setFetched(thread.id, { ...copy, participants: [...copy.participants] })
  requested.add(thread.id)
})

export function resetThreadTabNames(): void {
  setApi(null)
  setFetched(reconcile({}))
  setGone(reconcile({}))
  requested.clear()
}
onSessionTeardown(resetThreadTabNames)
