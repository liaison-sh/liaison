// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { AttentionAction, AttentionItem, AttentionKind } from "@liaison/shared"

describe("AttentionItem contract", () => {
  it("accepts a fully-populated SLA-risk item with open_entity action", () => {
    const item: AttentionItem = {
      id: "sla_risk:abc",
      app: "tickets",
      entity: "ticket",
      entityId: "abc",
      kind: "sla_risk",
      summary: "SLA approaching for #ticket-12",
      urgency: 75,
      occurredAt: "2026-05-02T10:00:00.000Z",
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: "abc" },
    }
    const kinds: AttentionKind[] = [
      "sla_risk",
      "awaiting_agent",
      "unassigned",
      "nudge_due",
      "followup_due",
      "admin_action",
    ]
    expect(kinds).toContain(item.kind)
    const action: AttentionAction = item.action
    expect(action.type).toBe("open_entity")
  })
})

describe("attention shared types", () => {
  it("attention.types.kinds — includes all Phase 8 kinds", () => {
    const allKinds: AttentionKind[] = [
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
    ]
    expect(allKinds).toHaveLength(10)
  })

  it("attention.types.actions — decide_approval action carries approvalId", () => {
    const a: AttentionAction = { type: "decide_approval", approvalId: "abc" }
    expect(a.type === "decide_approval" && a.approvalId).toBe("abc")
  })

  it("attention.types.actions — open_url action carries an external URL", () => {
    const a: AttentionAction = {
      type: "open_url",
      url: "https://acme.myshopify.com/admin/orders/9001",
      label: "Open in Shopify",
    }
    expect(a.type === "open_url" && a.url).toBe("https://acme.myshopify.com/admin/orders/9001")
    expect(a.type === "open_url" && a.label).toBe("Open in Shopify")
  })

  it("attention.types.metadata — projects items carry projectId in metadata", () => {
    const item: AttentionItem = {
      id: "projects:task_overdue:t1",
      app: "projects",
      entity: "task",
      entityId: "t1",
      kind: "task_overdue",
      summary: "x",
      urgency: 70,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "open_entity", tabType: "projects:task", entityId: "t1" },
      metadata: { projectId: "p1" },
    }
    expect(item.metadata?.projectId).toBe("p1")
  })

  it("attention.types.json-roundtrip — items survive JSON serialization", () => {
    const item: AttentionItem = {
      id: "kernel:approval_request:a1",
      app: "kernel",
      entity: "approval_request",
      entityId: "a1",
      kind: "approval_pending",
      summary: "Pending approval",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a1" },
      metadata: { source: "agent" },
    }
    const roundtrip = JSON.parse(JSON.stringify(item)) as AttentionItem
    expect(roundtrip.id).toBe(item.id)
    expect(roundtrip.kind).toBe("approval_pending")
    if (roundtrip.action.type === "decide_approval") {
      expect(roundtrip.action.approvalId).toBe("a1")
    } else {
      throw new Error("expected decide_approval action after roundtrip")
    }
    expect((roundtrip.metadata as { source?: string }).source).toBe("agent")
  })

  it("attention.types.kinds — includes Phase 10 delivery kinds", () => {
    const phase10: AttentionKind[] = [
      "mention",
      "thread_reply",
      "approval_decision",
      "system_alert",
      "file_shared",
    ]
    expect(phase10).toHaveLength(5)
  })

  it("attention.types.tab-action — open_entity action provides canonical tabType strings", () => {
    const actions: AttentionAction[] = [
      { type: "open_entity", tabType: "projects:task", entityId: "t1" },
      { type: "open_entity", tabType: "tickets:ticket", entityId: "tk1" },
    ]
    for (const a of actions) {
      if (a.type === "open_entity") {
        expect(a.tabType).toMatch(/^[a-z]+:[a-z_]+$/)
      }
    }
  })
})
