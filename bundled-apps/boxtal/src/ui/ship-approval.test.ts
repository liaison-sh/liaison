// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One decision per label purchase, taken on the shipping grid: the parked purchase is recognised as
// parked (never as a bought label), paired with its row, described by its own card, and decided
// through the boxtal-scoped feed only.

import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"
import {
  type ApprovalRow,
  SHIP_APPROVALS_PATH,
  approvalCardText,
  decideBody,
  decidePath,
  decisionNote,
  pendingShipApprovalsByDraft,
  shipApprovalForRow,
  shipOutcome,
} from "./ship-approval"

const approval = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: "a-1",
  status: "pending",
  toolName: "boxtal:create_shipment",
  currentPayload: { draft_id: "doc-1", offer_code: "ups" },
  summary: { title: "Buy label for order #3360 (INV-2026-0042), Alice Example, via ups", lines: ["Carrier: ups, 18.40 EUR TTC"] },
  requester: { name: "Logistics" },
  createdAt: "2026-10-05T08:00:00.000Z",
  ...over,
})

describe("a Ship click's outcome", () => {
  it("a gated call's blocked envelope is a parked purchase, never a bought label", () => {
    const res = { blocked: { reason: "gated", approvalRequestId: "req-9", requesterCanApprove: false, summary: {} } }
    expect(shipOutcome(res)).toEqual({ kind: "pending", approvalRequestId: "req-9", requesterCanApprove: false })
  })

  it("a handler error is an error, and only a plain result is a bought label", () => {
    expect(shipOutcome({ error: { code: "duplicate", message: "Already shipped" } })).toEqual({
      kind: "error",
      message: "Already shipped",
    })
    expect(shipOutcome({ shipment_id: "s-1", status: "created" })).toEqual({ kind: "shipped" })
  })

  it("the grid routes the create_shipment result through shipOutcome, not a status field", () => {
    const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
    const shipRow = src.slice(src.indexOf("const shipRow = "), src.indexOf("const decideShip = "))
    expect(shipRow).toContain("shipOutcome(")
    expect(shipRow).not.toContain('res?.status === "pending_approval"')
  })
})

describe("pending purchases on their rows", () => {
  it("pairs each pending create_shipment with the row whose document it ships", () => {
    const byDraft = pendingShipApprovalsByDraft([
      approval(),
      approval({ id: "other-tool", toolName: "boxtal:cancel_shipment", currentPayload: { draft_id: "doc-2" } }),
      approval({ id: "decided", status: "approved", currentPayload: { draft_id: "doc-3" } }),
    ])
    expect([...byDraft.keys()]).toEqual(["doc-1"])
    expect(shipApprovalForRow({ document_ref: "doc-1" }, byDraft)?.id).toBe("a-1")
    expect(shipApprovalForRow({ document_ref: "doc-2" }, byDraft)).toBeNull()
    expect(shipApprovalForRow({ document_ref: null }, byDraft)).toBeNull()
  })

  it("keeps the newest request when several are pending for one draft", () => {
    const byDraft = pendingShipApprovalsByDraft([
      approval({ id: "new", createdAt: "2026-10-05T09:00:00.000Z" }),
      approval({ id: "old", createdAt: "2026-10-05T08:00:00.000Z" }),
    ])
    expect(byDraft.get("doc-1")?.id).toBe("new")
  })

  it("the card says what is bought and who asked", () => {
    expect(approvalCardText(approval())).toEqual({
      title: "Buy label for order #3360 (INV-2026-0042), Alice Example, via ups",
      lines: ["Carrier: ups, 18.40 EUR TTC"],
      requester: "Logistics",
    })
  })

  it("reads and decides through the boxtal-scoped feed only", () => {
    expect(SHIP_APPROVALS_PATH).toBe("/api/approvals?status=pending&decidableByMe=true&app=boxtal")
    expect(decidePath("a-1")).toBe("/api/approvals/a-1/decide")
  })

  it("says what the decision did", () => {
    expect(decisionNote("approve", { status: "approved" })).toBe("Approved. The label is bought.")
    expect(decisionNote("approve", { status: "pending" })).toMatch(/Another approver/)
    expect(decisionNote("deny", { status: "denied" })).toBe("Declined. No label was bought.")
  })
})

describe("deciding from the grid", () => {
  it("an approve names the version of the purchase the row showed; a decline needs none", () => {
    expect(decideBody(approval({ payloadHash: "abc" }), "approve")).toEqual({
      decision: "approve",
      payloadHash: "abc",
    })
    expect(decideBody(approval({ payloadHash: "abc" }), "deny")).toEqual({ decision: "deny" })
  })

  it("the grid decides through the host with that body's fingerprint, never a raw kernel route", () => {
    const grid = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
    expect(grid).toContain("const body = decideBody(approval, decision)")
    expect(grid).toContain("app.decideApproval(approval.id, decision, body.payloadHash)")
    expect(grid).toContain("app.listMyApprovals()")
    // A framed screen reaches no kernel route: no approvals fetch, no org from a token alone.
    expect(grid).not.toContain("hostFetch")
    expect(grid).not.toContain('navigate("/approvals")')
    expect(grid).toContain("getContext()?.orgId")
  })
})
