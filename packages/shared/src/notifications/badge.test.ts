// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  type BadgeItem,
  type BadgeThread,
  countBadge,
  isBadgeAsk,
  isBadgeThread,
  NOW_URGENCY,
} from "./badge"

const viewer = { canGrantAccess: false }

const dm: BadgeThread = { id: "dm", title: null, type: "thread", unreadCount: 2 }
const agentChat: BadgeThread = { id: "ac", title: "Auto title", type: "agent_chat", unreadCount: 1 }
const channel: BadgeThread = { id: "ch", title: "support", type: "thread", unreadCount: 7 }

function item(kind: string, extra: Partial<BadgeItem> = {}): BadgeItem {
  return { kind: kind as BadgeItem["kind"], entity: "thread", entityId: `${kind}-1`, ...extra }
}

describe("the badge counts direct asks only", () => {
  it("counts unread messages of direct conversations, never of a channel", () => {
    expect(isBadgeThread(dm)).toBe(true)
    expect(isBadgeThread(agentChat)).toBe(true)
    expect(isBadgeThread(channel)).toBe(false)
    expect(countBadge({ threads: [dm, agentChat, channel], items: [], viewer })).toBe(3)
  })

  it("skips a muted or archived direct conversation", () => {
    const threads = [
      { ...dm, isMuted: true },
      { ...agentChat, isArchived: true },
    ]
    expect(countBadge({ threads, items: [], viewer })).toBe(0)
  })

  it("leaves out a critical alert scored below what Home presents as needing someone now", () => {
    const incident = { entity: "incident", entityId: "i1" }
    const low = item("monitoring:incident.critical", { ...incident, urgency: NOW_URGENCY - 5 })
    const now = item("monitoring:incident.critical", { ...incident, urgency: NOW_URGENCY })
    expect(isBadgeAsk(low, viewer)).toBe(false)
    expect(isBadgeAsk(now, viewer)).toBe(true)
  })

  it("counts a mention in a channel once, and not again when it sits in a direct conversation", () => {
    const inChannel = item("mention", { entityId: "ch" })
    const inDm = item("mention", { entityId: "dm" })
    expect(countBadge({ threads: [dm, channel], items: [inChannel, inDm], viewer })).toBe(3)
  })

  it("counts replies in a followed reply thread, approvals, access requests to grant and critical alerts", () => {
    const items: BadgeItem[] = [
      item("thread_followup", { entityId: "root-1", metadata: { threadId: "ch" } }),
      item("approval_pending", {
        entity: "approval",
        entityId: "a1",
        action: { type: "decide_approval", approvalId: "a1" },
      }),
      item("monitoring:incident.critical", { entity: "incident", entityId: "i1" }),
      item("routine_mailbox_wait", { entity: "routine_run", entityId: "r1" }),
      item("x", {
        entity: "node_session",
        entityId: "n1",
        metadata: { nodePermissionPromptId: "p" },
      }),
    ]
    expect(countBadge({ threads: [], items, viewer })).toBe(5)
    const access = item("scope_request", { entity: "scope_request", entityId: "s1" })
    expect(isBadgeAsk(access, viewer)).toBe(false)
    expect(isBadgeAsk(access, { canGrantAccess: true })).toBe(true)
  })

  it("rule 7: a muted (quiet) mention or critical alert never asks", () => {
    const quiet = { metadata: { quiet: true } }
    expect(isBadgeAsk({ kind: "mention", entity: "thread", entityId: "t", ...quiet }, viewer)).toBe(
      false,
    )
    expect(
      isBadgeAsk(
        {
          kind: "monitoring:incident.critical" as BadgeItem["kind"],
          entity: "incident",
          entityId: "i",
          ...quiet,
        },
        viewer,
      ),
    ).toBe(false)
  })

  it("leaves out what does not ask for the person", () => {
    const quiet = [
      "thread_reply",
      "approval_decision",
      "task_overdue",
      "sla_risk",
      "system_alert",
      "agent_notification",
      "monitoring:incident.warning",
      "shopify:order.created",
    ].map((kind) => item(kind, { entityId: kind }))
    expect(countBadge({ threads: [], items: quiet, viewer })).toBe(0)
    const peer = item("approval_pending", {
      entity: "approval",
      entityId: "a2",
      action: { type: "decide_approval", approvalId: "a2" },
      metadata: { peerSelfApprovable: true },
    })
    expect(isBadgeAsk(peer, viewer)).toBe(false)
  })

  it("counts the same row once when two sources carry it", () => {
    const a = item("mention", { entityId: "ch" })
    expect(countBadge({ threads: [], items: [a, { ...a }], viewer })).toBe(1)
  })
})
