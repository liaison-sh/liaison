// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

import {
  approvalRunGroupMembers,
  approvalRunGroupOf,
  collapseApprovalRunGroups,
} from "~/modules/approvals/run-group"
import { homeActionItems, homeApprovalItems } from "~/modules/shell/home-action-count"

const approval = (id: string, metadata?: Record<string, unknown>): AttentionItem => ({
  id: `kernel:approval_pending:${id}`,
  app: "kernel",
  entity: "approval_request",
  entityId: id,
  kind: "approval_pending",
  summary: `Issue ${id}`,
  urgency: 60,
  occurredAt: "2026-12-31T09:00:00.000Z",
  action: { type: "decide_approval", approvalId: id },
  ...(metadata ? { metadata } : {}),
})
const run = (key: string, count: number) => ({
  placement: "mine",
  runGroup: { key, count, label: "Monthly billing" },
})
const viewer = { userId: "u-1", canGrantAccess: true }

describe("one run, one Home row", () => {
  const items = [
    approval("a1", run("run-a:mine", 3)),
    approval("solo", { placement: "mine" }),
    approval("a2", run("run-a:mine", 3)),
    approval("b1", run("run-b:mine", 2)),
    approval("a3", run("run-a:mine", 3)),
    approval("b2", run("run-b:mine", 2)),
  ]

  it("the cards of one run are one row in the run's first place, a lone card stays", () => {
    expect(collapseApprovalRunGroups(items).map((i) => i.entityId)).toEqual(["a1", "solo", "b1"])
  })

  it("Home's approvals list and badge count each run once", () => {
    expect(homeApprovalItems(items, true, viewer).map((i) => i.entityId)).toEqual([
      "a1",
      "solo",
      "b1",
    ])
    expect(homeActionItems(items, false, viewer)).toHaveLength(3)
  })

  it("the row opens to every card of its run, in the feed's order", () => {
    expect(approvalRunGroupMembers("run-a:mine", items).map((i) => i.entityId)).toEqual([
      "a1",
      "a2",
      "a3",
    ])
  })

  it("reads the group only off an approval with a key", () => {
    expect(approvalRunGroupOf(items[0] as AttentionItem)).toEqual({
      key: "run-a:mine",
      count: 3,
      label: "Monthly billing",
    })
    expect(approvalRunGroupOf(items[1] as AttentionItem)).toBeNull()
    expect(
      approvalRunGroupOf({ ...(items[0] as AttentionItem), kind: "mention" } as AttentionItem),
    ).toBeNull()
  })
})
