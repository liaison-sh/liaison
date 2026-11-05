// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Bring this approval into view" (LIF-18): a notification about an approval
// opens Home, and Home's approvals card unfolds, drops a facet filter that
// hides it, and its row opens and scrolls into view. The request stands until
// the row has acted on it (the feed may still be loading when Home opens).

import { createSignal } from "solid-js"

const [focused, setFocused] = createSignal<string | null>(null)

/** The approval Home should bring into view, if any. */
export function focusedApproval(): string | null {
  return focused()
}

export function focusApproval(approvalId: string): void {
  setFocused(approvalId)
}

/** The row showed it: the request is spent. */
export function clearApprovalFocus(approvalId: string): void {
  if (focused() === approvalId) setFocused(null)
}
