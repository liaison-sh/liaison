// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH REPLY THREAD IS OPEN, per channel (S10), and the ways in: the "Reply in
// thread" action, the summary under a root, the followed threads in the
// sidebar, a notification row, a search hit and a quote whose source is a
// reply. Every one of them opens the channel with the panel on the root, and
// may name a message to bring into view once the panel has loaded.

import { createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { userFromToken } from "~/modules/auth/auth-store"
import { tNow } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"
import { conversationDisplayName } from "~/modules/threads/conversation-display"
import { getThread } from "~/modules/threads/thread-store"

export interface OpenReplyPanel {
  rootId: string
  /** A message to scroll to and highlight once the replies are loaded. */
  focusMessageId: string | null
  /** Bumped on every open, so reopening the same root re-focuses. */
  nonce: number
}

const [panels, setPanels] = createStore<Record<string, OpenReplyPanel | undefined>>({})
let nonce = 0

export function getOpenReplyPanel(threadId: string): OpenReplyPanel | null {
  return panels[threadId] ?? null
}

export function openReplyPanel(
  threadId: string,
  rootId: string,
  opts: { focusMessageId?: string | null } = {},
): void {
  nonce++
  setPanels(threadId, { rootId, focusMessageId: opts.focusMessageId ?? null, nonce })
}

export function closeReplyPanel(threadId: string): void {
  setPanels(threadId, undefined)
}

function channelLabel(threadId: string, fallback?: string | null): string {
  const thread = getThread(threadId)
  if (thread) {
    const name = conversationDisplayName(thread, userFromToken()?.userId ?? "").trim()
    if (name) return name
  }
  return fallback?.trim() || tNow("kernel.replyThreads.title")
}

/** Opens the channel's tab with the reply panel on `rootId`. */
export function openThreadWithReplyPanel(
  threadId: string,
  rootId: string,
  opts: { label?: string | null; focusMessageId?: string | null } = {},
): void {
  openReplyPanel(threadId, rootId, { focusMessageId: opts.focusMessageId ?? null })
  openTab({ type: "thread", entityId: threadId, label: channelLabel(threadId, opts.label) })
}

/** A request for the CHANNEL list to bring a message into view (a quote in a
 *  reply panel whose source is a channel message). */
export interface ChannelJumpRequest {
  threadId: string
  messageId: string
  nonce: number
}
const [channelJump, setChannelJump] = createSignal<ChannelJumpRequest | null>(null)

export function channelJumpRequest(): ChannelJumpRequest | null {
  return channelJump()
}

export function requestChannelJump(threadId: string, messageId: string): void {
  nonce++
  setChannelJump({ threadId, messageId, nonce })
}

/** The channel list that serves a request takes it, so a remount (or a second
 *  surface on the same conversation) does not jump again. */
export function consumeChannelJump(req: ChannelJumpRequest): void {
  if (channelJump()?.nonce === req.nonce) setChannelJump(null)
}

/**
 * A message hit from search (A17): the channel, and the reply panel when the
 * message lives in a reply thread. Answers false for any other hit, which the
 * caller opens the usual way.
 */
export function openSearchMessageHit(hit: {
  app?: string
  entity_type?: string
  entity_id?: string
  id?: string
  thread_id?: unknown
  replyRootId?: unknown
  title?: unknown
}): boolean {
  if (hit.app !== "kernel" || hit.entity_type !== "message") return false
  const threadId = typeof hit.thread_id === "string" ? hit.thread_id : null
  if (!threadId) return false
  const messageId = hit.entity_id ?? hit.id ?? ""
  const rootId = typeof hit.replyRootId === "string" ? hit.replyRootId : null
  if (rootId) {
    openThreadWithReplyPanel(threadId, rootId, { focusMessageId: messageId || null })
    return true
  }
  openTab({ type: "thread", entityId: threadId, label: channelLabel(threadId) })
  if (messageId) requestChannelJump(threadId, messageId)
  return true
}

export function resetReplyPanels(): void {
  setPanels(reconcile({}))
  setChannelJump(null)
}
onSessionTeardown(resetReplyPanels)
