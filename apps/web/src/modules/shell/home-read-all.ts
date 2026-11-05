// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HOME'S "MARK ALL AS READ" (D21 follow-up). One action in the main panel's
// header, scoped to the slice the sidebar (or a phone chip) selected:
// Overview reads everything Home shows that can be read, Alerts the alerts
// (a cluster only its own), Agents > Notifications those, and so on.
//
// What it never reads is a row that needs a DECISION: an approval, an access
// request, a node permission prompt. Those clear through their decision; the
// action leaves them and its confirmation says how many are left. Rows the
// apps compute on every fetch (a ticket awaiting a reply, an overdue task)
// are not "read" either: they go when the work is done, so the action is not
// offered on a slice that holds only those. The server applies the same
// decision rule whatever the client sends (attention-routes.ts).

import type { AttentionItem } from "@liaison/shared"
import { approvalActionKey, isApprovalItem } from "~/modules/shell/approval-facets"
import {
  alertClusterOf,
  alertItemsFor,
  approvalFacetOf,
  type HomeFilter,
  type HomeSections,
  queueOf,
} from "~/modules/shell/home-sections"

/** True for a row that is cleared by deciding it, never by reading it. */
export function isDecisionItem(item: AttentionItem): boolean {
  return (
    isApprovalItem(item) ||
    item.kind === "approval_pending" ||
    item.kind === "scope_request" ||
    item.metadata?.nodePermissionPromptId !== undefined ||
    item.metadata?.nodePermission !== undefined
  )
}

/** The attention rows a Home filter puts on screen. */
export function homeSliceItems(sections: HomeSections, filter: HomeFilter): AttentionItem[] {
  const needs = sections.needs
  const allNeeds = [...needs.timeLimited, ...needs.approvals, ...needs.alerts]
  const queueItems = sections.queues.flatMap((g) => g.items)
  const agents = [...sections.agents.failed, ...sections.agents.notifications]
  if (filter === "overview") return [...allNeeds, ...queueItems, ...agents]
  if (filter === "needs") return allNeeds
  if (filter === "needs:time") return needs.timeLimited
  if (filter.startsWith("needs:approvals")) {
    const facet = approvalFacetOf(filter)
    return facet === null
      ? needs.approvals
      : needs.approvals.filter((i) => approvalActionKey(i) === facet)
  }
  if (filter.startsWith("needs:alerts")) return alertItemsFor(sections, alertClusterOf(filter))
  if (filter === "queues") return queueItems
  const queue = queueOf(filter)
  if (queue) {
    const items = sections.queues.find((g) => g.key === queue.key)?.items ?? []
    return queue.kind ? items.filter((i) => i.kind === queue.kind) : items
  }
  if (filter === "agents") return agents
  if (filter === "agents:failed") return sections.agents.failed
  if (filter === "agents:notifications") return sections.agents.notifications
  return []
}

export interface ReadAllPlan {
  /** One entry per entity to read: what the request carries. */
  entities: { app: string; entityType: string; entityId: string }[]
  /** Decisions the slice shows that the action leaves in place. */
  approvalsLeft: number
  decisionsLeft: number
}

/** What "Mark all as read" does on this slice. */
export function homeReadAllPlan(sections: HomeSections, filter: HomeFilter): ReadAllPlan {
  const seen = new Set<string>()
  const entities: ReadAllPlan["entities"] = []
  let approvalsLeft = 0
  let decisionsLeft = 0
  const counted = new Set<string>()
  // The decisions it names are the Needs-you ones, so the confirmation agrees
  // with the Needs-you total and the badge. A queue row of a decision kind (a
  // social reply suggestion) is left alone without being counted (walk
  // 2026-10-12: "32 decisions" beside a Needs-you total of 30).
  const needsIds = new Set(
    [...sections.needs.timeLimited, ...sections.needs.approvals, ...sections.needs.alerts].map(
      (i) => i.id,
    ),
  )
  for (const item of homeSliceItems(sections, filter)) {
    if (isDecisionItem(item)) {
      if (counted.has(item.id) || !needsIds.has(item.id)) continue
      counted.add(item.id)
      decisionsLeft += 1
      if (isApprovalItem(item)) approvalsLeft += 1
      continue
    }
    if (!item.persisted) continue
    const key = `${item.app}\u0000${item.entity}\u0000${item.entityId}`
    if (seen.has(key)) continue
    seen.add(key)
    entities.push({ app: item.app, entityType: item.entity, entityId: item.entityId })
  }
  return { entities, approvalsLeft, decisionsLeft }
}
