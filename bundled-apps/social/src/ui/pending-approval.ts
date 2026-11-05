// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's pending approval on a finding, decided from the finding itself. A
// finding reads `awaiting_approval` while an agent's reply or like waits in the
// approvals inbox (pending.ts). When the person on the finding settles it another
// way (Reject dismisses it, Approve & post replies directly), the agent's request
// is denied too, so it can't still be approved later from the inbox. The person
// decides it with their own rights through the kernel's decide route: the
// decidable feed (`decidableByMe`) says first whether they may, so someone who
// can't decide it never posts a refused decision, and the request then stays in
// the inbox for whoever can.

import type { HostFetch } from "@liaison/host"

/** The decidable feed, narrowed to this app's gated tools. */
export const SOCIAL_DECIDABLE_APPROVALS_PATH = "/api/approvals?status=pending&decidableByMe=true&app=social"

export function decidePath(approvalId: string): string {
  return `/api/approvals/${encodeURIComponent(approvalId)}/decide`
}

/** `denied`: the request is now denied. `not_decidable`: the caller may not decide
 *  it (or it is no longer pending), so it was left as it is. */
export type PendingDenyOutcome = "denied" | "not_decidable"

/** Deny the pending approval `approvalId` when the caller may decide it. */
export async function denyPendingApproval(
  fetch: HostFetch,
  approvalId: string,
  reason: string,
): Promise<PendingDenyOutcome> {
  const rows = await fetch<Array<{ id?: unknown }>>(SOCIAL_DECIDABLE_APPROVALS_PATH)
  if (!Array.isArray(rows) || !rows.some((r) => r?.id === approvalId)) return "not_decidable"
  await fetch(decidePath(approvalId), {
    method: "POST",
    body: JSON.stringify({ decision: "deny", reason }),
  })
  return "denied"
}

/** What Reject tells the person, given what happened to the agent's request. */
export function rejectNote(outcome: PendingDenyOutcome | null): string {
  if (outcome === "denied") return "Finding dismissed and the agent's draft rejected."
  if (outcome === "not_decidable")
    return "Finding dismissed. The agent's draft is still waiting in the approvals inbox for someone who can decide it."
  return "Finding dismissed."
}
