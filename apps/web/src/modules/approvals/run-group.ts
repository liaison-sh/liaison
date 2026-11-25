// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE BATCH, ONE ROW. The cards one run staged for this viewer (a month-end pass: one issue card
// per client), or, with no run behind them, the same action for the same people on the same
// business day, in the same place on their Home, carry `metadata.runGroup` from the server
// (approvals/attention.ts, group-key.ts). Home lists them as one row that opens to the cards, so the lists
// and the badge count that row once. Each card stays its own decision.

import type { AttentionItem } from "@liaison/shared"

export interface ApprovalRunGroup {
  key: string
  count: number
  /** How the group was formed: one run, or the same action on one day with no run. */
  basis: "run" | "batch"
  /** Who asked (the agent, the routine or the person), when the server knows: a run's group. */
  label?: string
  /** The action every card of a batch shares (`app:tool`). */
  toolName?: string
}

export function approvalRunGroupOf(item: AttentionItem): ApprovalRunGroup | null {
  if (item.kind !== "approval_pending") return null
  const g = item.metadata?.runGroup as Record<string, unknown> | undefined
  if (!g || typeof g.key !== "string" || g.key.length === 0) return null
  const count = typeof g.count === "number" ? g.count : 0
  return {
    key: g.key,
    count,
    basis: g.basis === "batch" ? "batch" : "run",
    ...(typeof g.label === "string" && g.label.length > 0 ? { label: g.label } : {}),
    ...(typeof g.toolName === "string" && g.toolName.length > 0 ? { toolName: g.toolName } : {}),
  }
}

/** The cards of one group, in the order the feed lists them. */
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
