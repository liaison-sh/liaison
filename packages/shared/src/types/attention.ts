// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Every kernel attention kind, as a runtime list so exhaustiveness checks (the
 * notification groups in `notifications/groups.ts`) can iterate the union.
 */
export const ATTENTION_KINDS = [
  "sla_risk",
  "awaiting_agent",
  "unassigned",
  "nudge_due",
  "followup_due",
  "admin_action",
  "task_overdue",
  "task_due_this_week",
  "task_blocked",
  "approval_pending",
  "mention",
  "thread_reply",
  "thread_followup",
  "approval_decision",
  "system_alert",
  "file_shared",
  "agent_notification",
  "dm_window_closing",
  "scope_request",
  "scope_request_decided",
  // A routine run waiting for its owner's private mailbox: an item of the
  // owner's approvals list (Run now, Dismiss).
  "routine_mailbox_wait",
] as const

export type AttentionKind = (typeof ATTENTION_KINDS)[number]

export type AttentionAction =
  | { type: "open_entity"; tabType: string; entityId: string }
  // An entity with no in-app view but a manifest-declared external deep link
  // (e.g. a Shopify order, which opens the Shopify admin directly). The URL is
  // resolved server-side so the click handler can open it synchronously without
  // tripping the browser popup blocker.
  | { type: "open_url"; url: string; label?: string }
  | { type: "decide_approval"; approvalId: string; payloadHash?: string }

export type AttentionItem = {
  id: string
  app: string
  entity: string
  entityId: string
  kind: AttentionKind
  summary: string
  urgency: number
  occurredAt: string
  action: AttentionAction
  metadata?: Record<string, unknown>
  /**
   * Kinds of other attention items that targeted the same entity and were
   * merged into this one by the aggregator (highest-urgency item wins).
   * A ticket that is both awaiting_agent and unassigned surfaces once.
   */
  alsoKinds?: string[]
  /**
   * True when the item is a persisted kernel.attention_events row (clearable
   * via mark-read). Rule-computed items (ticket/task rules) omit it — marking
   * those read is a no-op since the provider re-derives them every fetch.
   */
  persisted?: boolean
}

export type AttentionProviderError = {
  app: string
  reason: "timeout" | "error"
  message: string
}

export type AttentionFeedResponse = {
  items: AttentionItem[]
  errors: AttentionProviderError[]
}
