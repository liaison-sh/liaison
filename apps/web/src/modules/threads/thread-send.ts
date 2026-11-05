// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE SEND FOR EVERY SURFACE THAT POSTS INTO A THREAD. The thread view and a
// task's discussion post the same message to the same route, and the agent a
// message names runs the same turn from either. What the turn may know and do
// is decided at the send, so both surfaces send through here:
// - the view the user is looking at (`currentView`, the main panel's active
//   tab, the same shape the agent panel posts), so the agent knows the task,
//   the ticket or the document on screen;
// - the mailbox turn nonce, which ties any decrypt request the turn makes to a
//   turn THIS browser started and still has open, held until the turn's own
//   stream frames say it ended (or the surface unmounts);
// - the refusal copy a failed send shows.

import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { beginMailboxAgentTurn, endMailboxAgentTurn } from "~/modules/mailbox/mailbox-agent-runtime"
import { tabStore } from "~/modules/shell/tab-store"
import {
  LocalRuntimeUnavailableError,
  localSendRefusalCopy,
} from "~/modules/threads/local-runtime-send"
import {
  holdTurnScopeUntilAgentTurnEnds,
  type QuoteDraft,
  sendMessage,
} from "~/modules/threads/message-store"

export interface ThreadSendOptions {
  attachmentSessionId?: string
  replyRootId?: string
  quote?: QuoteDraft
}

/** The view the user is looking at: the main panel's active tab, never the
 *  sending surface's own (a dock tab has no tab-store entry). Nothing for a tab
 *  that names no entity. */
export function currentViewForTurn(): { tabType: string; entityId: string } | undefined {
  const activeTab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
  return activeTab?.entityId ? { tabType: activeTab.type, entityId: activeTab.entityId } : undefined
}

/**
 * Post a message with the turn context a thread send carries. `heldScopes`
 * collects the release of an open mailbox scope so the surface can close it on
 * unmount. Resolves or rejects with the POST.
 */
export function sendThreadMessage(
  api: Pick<ApiClient, "post">,
  threadId: string,
  content: string,
  currentUser: { id: string; name: string },
  opts: ThreadSendOptions,
  heldScopes: Set<() => void>,
): Promise<void> {
  const currentView = currentViewForTurn()
  const turnNonce = beginMailboxAgentTurn()
  const sent = sendMessage(api, threadId, content, currentUser, {
    ...opts,
    ...(currentView ? { currentView } : {}),
    ...(turnNonce ? { turnNonce } : {}),
  })
  if (turnNonce) {
    // An open scope is standing permission to decrypt, so it closes when the
    // TURN ends, not when the POST does: the api answers the POST and only
    // then dispatches the agent turn, so every decrypt request the turn makes
    // arrives after the send has settled. The holder also releases on an
    // inactivity timeout and on unmount, so no scope stays open forever.
    const release: () => void = holdTurnScopeUntilAgentTurnEnds(threadId, () => {
      heldScopes.delete(release)
      endMailboxAgentTurn(turnNonce)
    })
    heldScopes.add(release)
    // A send that never reached the server starts no turn at all.
    void sent.then(
      () => {},
      () => release(),
    )
  }
  return sent
}

/** Release every mailbox scope a surface still holds (its unmount). */
export function releaseHeldScopes(heldScopes: Set<() => void>): void {
  for (const release of [...heldScopes]) release()
  heldScopes.clear()
}

/** What a failed send says: a local runtime that could not start is a warning,
 *  a refusal the server explains is said as such, anything else is generic. */
export function sendFailureToast(
  err: unknown,
  t: (key: string) => string,
): { message: string; type: "warning" | "error" } {
  if (err instanceof LocalRuntimeUnavailableError) {
    return { message: localSendRefusalCopy(err.reason), type: "warning" }
  }
  const code = err instanceof ApiError ? err.code : undefined
  const message =
    code === "reply_root_deleted"
      ? t("kernel.replyThreads.rootDeleted")
      : code === "quote_not_found" || code === "quote_excerpt_mismatch"
        ? t("kernel.replyThreads.quoteRefused")
        : t("kernel.sendMessageFailed")
  return { message, type: "error" }
}
