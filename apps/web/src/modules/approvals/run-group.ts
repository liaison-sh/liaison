// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE RUN, ONE ROW. The cards one run staged for this viewer, in the same place on their Home
// (a month-end pass: one issue card per client), carry `metadata.runGroup` from the server
// (approvals/attention.ts). Home lists them as one row that opens to the cards, so the lists
// and the badge count that row once. Each card stays its own decision.

import type { AttentionItem } from "@liaison/shared"

export interface ApprovalRunGroup {
  key: string
  count: number
  /** Who asked (the agent, the routine or the person), when the server knows. */
  label?: string
}

export function approvalRunGroupOf(item: AttentionItem): ApprovalRunGroup | null {
  if (item.kind !== "approval_pending") return null
  const g = item.metadata?.runGroup as Record<string, unknown> | undefined
  if (!g || typeof g.key !== "string" || g.key.length === 0) return null
  const count = typeof g.count === "number" ? g.count : 0
  return {
    key: g.key,
    count,
    ...(typeof g.label === "string" && g.label.length > 0 ? { label: g.label } : {}),
  }
}

/** The cards of one run, in the order the feed lists them. */
export function approvalRunGroupMembers(key: string, items: AttentionItem[]): AttentionItem[] {
  return items.filter((item) => approvalRunGroupOf(item)?.key === key)
}

/**
 * Keep the first card of each run in its place (the feed's order, so the run sits where its
 * most pressing card would) and drop the rest: that row stands for them all.
 */
export function collapseApprovalRunGroups(items: AttentionItem[]): AttentionItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const group = approvalRunGroupOf(item)
    if (!group) return true
    if (seen.has(group.key)) return false
    seen.add(group.key)
    return true
  })
}
