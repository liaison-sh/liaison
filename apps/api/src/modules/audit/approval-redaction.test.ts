// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import {
  isApprovalAuditEntity,
  redactApprovalAuditChanges,
  redactUserAuditChanges,
} from "~/modules/audit/approval-redaction"
import { queryAuditLogPage } from "~/modules/audit/service"

const card = {
  id: "a1",
  handle: "apr_1",
  status: "pending",
  toolName: "mail:reply",
  payloadHash: "abc",
  requestedBy: { id: "u1", extra: "x" },
  currentPayload: { body: "Dear customer, your refund of 900 EUR" },
  summary: { title: "Reply to Jane", detail: "secret draft" },
  metadata: { diff: [{ from: "a", to: "b" }] },
  lastEdit: { diff: ["private"] },
  reason: "denied because ...",
  requester: { name: "Jane" },
}

describe("approval audit redaction", () => {
  it("keeps lifecycle fields and drops payload, summary, metadata and edit diffs", () => {
    const out = redactApprovalAuditChanges(card)
    expect(out).toEqual({
      id: "a1",
      handle: "apr_1",
      status: "pending",
      toolName: "mail:reply",
      payloadHash: "abc",
      requestedBy: { id: "u1" },
    })
    expect(JSON.stringify(out)).not.toContain("refund")
  })

  it("collapses anything that is not a plain object", () => {
    expect(redactApprovalAuditChanges("text")).toBeNull()
    expect(redactApprovalAuditChanges([card])).toBeNull()
  })

  it("only the approval_request entity is reduced", () => {
    expect(isApprovalAuditEntity("approval_request")).toBe(true)
    expect(isApprovalAuditEntity("ticket")).toBe(false)
  })

  it("drops settings and the avatar capability token from user events", () => {
    const out = redactUserAuditChanges({ id: "u", name: "N", settings: { a: 1 }, avatarKey: "k" })
    expect(out).toEqual({ id: "u", name: "N" })
  })

  it("the audit READ reduces approval rows written before the strip existed", async () => {
    const rows = [
      {
        id: "r1",
        entityType: "approval_request",
        app: "kernel",
        changes: card,
        total: 1,
      },
      { id: "r2", entityType: "ticket", app: "tickets", changes: { subject: "kept" }, total: 1 },
    ]
    const chain: Record<string, unknown> = {}
    for (const m of ["select", "from", "where", "orderBy", "limit"]) chain[m] = () => chain
    chain.offset = async () => rows
    const page = await queryAuditLogPage(chain as unknown as RlsClient, "org", {})
    const approval = page.entries.find((e) => e.id === "r1")
    expect(JSON.stringify(approval?.changes)).not.toContain("refund")
    expect((approval?.changes as { toolName?: string } | undefined)?.toolName).toBe("mail:reply")
    expect(page.entries.find((e) => e.id === "r2")?.changes).toEqual({ subject: "kept" })
  })
})
