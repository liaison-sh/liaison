// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { decidingScopeOfRow } from "@liaison/shared"
import {
  type ApprovalGroupSource,
  approvalGroupBasis,
  approvalRunKey,
  civilDayIn,
} from "~/modules/approvals/group-key"

const card = (over: Partial<ApprovalGroupSource> = {}): ApprovalGroupSource => ({
  id: "c1",
  bundle_id: null,
  tool_name: "invoicing:invoice_issue",
  approve_scope: "invoicing:documents:write",
  resource_owner_id: null,
  created_at: "2026-11-30T10:00:00.000Z",
  metadata: null,
  ...over,
})

describe("approvalRunKey", () => {
  it("takes the routine run first, then the agent run's root", () => {
    expect(
      approvalRunKey(
        card({ metadata: { originRoutineRunId: "rr", originRootRunId: "root" } }),
        "UTC",
      ),
    ).toBe("run:rr")
    expect(approvalRunKey(card({ metadata: { originRootRunId: "root" } }), "UTC")).toBe("run:root")
  })

  it("a run's cards share their key across days", () => {
    const a = approvalRunKey(card({ metadata: { originRootRunId: "root" } }), "UTC")
    const b = approvalRunKey(
      card({ created_at: "2026-12-02T10:00:00.000Z", metadata: { originRootRunId: "root" } }),
      "UTC",
    )
    expect(a).toBe(b)
  })

  it("with no run: same audience, app action and business day share a key", () => {
    const a = approvalRunKey(card({ id: "a" }), "Europe/Paris")
    const b = approvalRunKey(
      card({ id: "b", created_at: "2026-11-30T21:00:00.000Z" }),
      "Europe/Paris",
    )
    expect(a).toBe(b)
    expect(a).toBe("batch:invoicing:documents:write||invoicing:invoice_issue|2026-11-30")
    expect(approvalGroupBasis(a as string)).toBe("batch")
  })

  it("with no run: another action, audience, owner or day is another key", () => {
    const base = approvalRunKey(card(), "UTC")
    expect(approvalRunKey(card({ tool_name: "invoicing:credit_note_issue" }), "UTC")).not.toBe(base)
    expect(approvalRunKey(card({ approve_scope: "invoicing:approve" }), "UTC")).not.toBe(base)
    expect(approvalRunKey(card({ resource_owner_id: "u1" }), "UTC")).not.toBe(base)
    expect(approvalRunKey(card({ created_at: "2026-12-01T10:00:00.000Z" }), "UTC")).not.toBe(base)
  })

  it("the business day is the org's: 23:30 UTC is the next day in Paris", () => {
    const late = card({ created_at: "2026-11-30T23:30:00.000Z" })
    expect(approvalRunKey(late, "UTC")).toContain("|2026-11-30")
    expect(approvalRunKey(late, "Europe/Paris")).toContain("|2026-12-01")
  })

  it("an unset decision scope reads as the app's approve scope", () => {
    expect(approvalRunKey(card({ approve_scope: null }), "UTC")).toBe(
      approvalRunKey(card({ approve_scope: "invoicing:approve" }), "UTC"),
    )
  })

  it("the audience is the scope that decides the row, never one derived here", () => {
    // An empty stored scope is the row's own: the gate does not read it as the app's scope.
    for (const approve_scope of [null, "", "invoicing:documents:write"]) {
      const scope = decidingScopeOfRow("invoicing:invoice_issue", approve_scope)
      expect(approvalRunKey(card({ approve_scope }), "UTC")).toBe(
        `batch:${scope}||invoicing:invoice_issue|2026-11-30`,
      )
    }
    expect(approvalRunKey(card({ approve_scope: "" }), "UTC")).not.toBe(
      approvalRunKey(card({ approve_scope: "invoicing:approve" }), "UTC"),
    )
  })

  it("a bundle step never groups, and a bundle head groups only by its run", () => {
    expect(approvalRunKey(card({ id: "s", bundle_id: "h" }), "UTC")).toBeNull()
    expect(
      approvalRunKey(card({ id: "s", bundle_id: "h", metadata: { originRootRunId: "r" } }), "UTC"),
    ).toBeNull()
    expect(approvalRunKey(card({ id: "h", bundle_id: "h" }), "UTC")).toBeNull()
    expect(
      approvalRunKey(card({ id: "h", bundle_id: "h", metadata: { originRootRunId: "r" } }), "UTC"),
    ).toBe("run:r")
  })

  it("a zone the runtime rejects reads as UTC", () => {
    expect(civilDayIn("2026-11-30T23:30:00.000Z", "Not/AZone")).toBe("2026-11-30")
    expect(approvalGroupBasis("run:r")).toBe("run")
  })
})
