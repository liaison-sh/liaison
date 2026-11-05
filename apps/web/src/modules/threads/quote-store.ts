// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The quote each composer carries (S12), keyed by SURFACE: the channel's
// composer, or one reply panel's. A selection quoted in the panel goes to the
// panel's composer and never to the channel's.

import { createStore, reconcile } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { QuoteDraft } from "~/modules/threads/message-store"

const [drafts, setDrafts] = createStore<Record<string, QuoteDraft | undefined>>({})

/** The channel composer's key, or a reply panel's when `rootId` is given. */
export function quoteSurfaceKey(threadId: string, rootId?: string | null): string {
  return rootId ? `${threadId}:${rootId}` : threadId
}

export function getQuoteDraft(key: string): QuoteDraft | null {
  return drafts[key] ?? null
}

export function setQuoteDraft(key: string, draft: QuoteDraft): void {
  setDrafts(key, { ...draft })
}

export function clearQuoteDraft(key: string): void {
  setDrafts(key, undefined)
}

export function resetQuoteDrafts(): void {
  setDrafts(reconcile({}))
}
onSessionTeardown(resetQuoteDrafts)
