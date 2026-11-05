// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  type ApprovalEditableField,
  type ApprovalLastEdit,
  type ApprovalLastFailure,
  type ApprovalRequestStatus,
  type ApprovalRequestSummary,
  approvalSummarySchema,
  truncateApprovalSummary,
} from "./approvals"

describe("approvalSummarySchema", () => {
  it("accepts a minimal summary", () => {
    const result = approvalSummarySchema.safeParse({
      kind: "mail.reply",
      title: "Re: Pricing",
      lines: ["To: hans@acme.de", "Hi Hans, ..."],
    })

    expect(result.success).toBe(true)
  })

  it("accepts a rich summary with subtitle and links", () => {
    const result = approvalSummarySchema.safeParse({
      kind: "mail.compose",
      title: "Hello",
      subtitle: "Compose via support@acme.com",
      lines: ["To: x@y.com", "Body preview..."],
      links: [
        { label: "Open conversation", app: "mail", entityType: "conversation", entityId: "abc" },
      ],
    })

    expect(result.success).toBe(true)
  })

  it("rejects missing required fields", () => {
    expect(approvalSummarySchema.safeParse({ kind: "x" }).success).toBe(false)
    expect(approvalSummarySchema.safeParse({ title: "x", lines: [] }).success).toBe(false)
  })

  it("rejects too many lines", () => {
    const lines = Array.from({ length: 9 }, (_, i) => `line ${i}`)
    expect(approvalSummarySchema.safeParse({ kind: "x", title: "x", lines }).success).toBe(false)
  })

  it("accepts exactly 8 lines", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`)
    expect(approvalSummarySchema.safeParse({ kind: "x", title: "x", lines }).success).toBe(true)
  })

  it("accepts a 500-character line", () => {
    expect(
      approvalSummarySchema.safeParse({ kind: "x", title: "x", lines: ["a".repeat(500)] }).success,
    ).toBe(true)
  })

  it("rejects line over 500 chars", () => {
    expect(
      approvalSummarySchema.safeParse({ kind: "x", title: "x", lines: ["a".repeat(501)] }).success,
    ).toBe(false)
  })
})

describe("ApprovalRequestSummary shape", () => {
  it("compiles with every required field", () => {
    const fields: ApprovalEditableField[] = [
      { field: "subject", label: "Subject", widget: "text" },
      { field: "textBody", label: "Body", widget: "richtext" },
    ]
    const lastEdit: ApprovalLastEdit = {
      editorUserId: "u-1",
      at: "2026-04-30T12:00:00.000Z",
      diff: [{ field: "subject", from: "old", to: "new" }],
    }
    const status: ApprovalRequestStatus = "pending"
    const lastFailure: ApprovalLastFailure = {
      code: "handler_failed",
      message: "The approved action failed to execute.",
      at: "2026-04-30T12:05:00.000Z",
    }
    const row: ApprovalRequestSummary = {
      id: "00000000-0000-0000-0000-000000000001",
      handle: "request-0001",
      status,
      createdAt: "2026-04-30T12:00:00.000Z",
      expiresAt: "2026-04-30T13:00:00.000Z",
      toolName: "mail:reply",
      summary: { kind: "mail.reply", title: "Re: Hi", lines: ["body"] },
      editableFields: fields,
      currentPayload: { subject: "Re: Hi", textBody: "body" },
      threadId: "11111111-1111-1111-1111-111111111111",
      originatingThreadId: "11111111-1111-1111-1111-111111111111",
      requestedBy: { id: "u-1" },
      requester: { kind: "user", id: "u-1", name: "Alice" },
      notifyUserIds: ["u-1"],
      bundleId: null,
      bundlePosition: null,
      dependsOnId: null,
      lastEdit,
      lastFailure,
    }
    expect(row.notifyUserIds).toHaveLength(1)
    expect(row.lastEdit?.diff[0].field).toBe("subject")
    expect(row.editableFields[1].widget).toBe("richtext")
    expect(row.lastFailure?.code).toBe("handler_failed")
  })

  it("supports a null lastFailure (no prior failed attempt)", () => {
    const row: Pick<ApprovalRequestSummary, "lastFailure"> = { lastFailure: null }
    expect(row.lastFailure).toBeNull()
  })
})

// S23/A10: a ticket approval card leads with the ticket id, carried as `ref`.
describe("approval summary ref", () => {
  it("accepts a ref up to 40 chars and refuses a longer one", () => {
    const base = { kind: "tickets.reply", title: "Where is my order", lines: [] }
    expect(approvalSummarySchema.safeParse({ ...base, ref: "ticket-B2B-123" }).success).toBe(true)
    expect(approvalSummarySchema.parse({ ...base, ref: "ticket-B2B-123" }).ref).toBe(
      "ticket-B2B-123",
    )
    expect(approvalSummarySchema.safeParse({ ...base, ref: "x".repeat(41) }).success).toBe(false)
  })

  it("truncateApprovalSummary keeps the ref, sliced to 40", () => {
    const out = truncateApprovalSummary({
      kind: "tickets.reply",
      title: "t",
      lines: [],
      ref: "x".repeat(60),
    })
    expect(out.ref).toBe("x".repeat(40))
    expect(truncateApprovalSummary({ kind: "k", title: "t", lines: [] }).ref).toBeUndefined()
  })

  // Walk 2026-10-12: a create-routine card's "Prompt: ..." line stopped mid-word
  // ("For each unread message found, re") with nothing saying it was cut.
  it("truncateApprovalSummary marks a cut line with an ellipsis, inside the 500 cap", () => {
    const long = `Prompt: ${"word ".repeat(150)}`
    const out = truncateApprovalSummary({ kind: "k", title: "t", lines: [long, "short"] })
    expect(out.lines[0]).toHaveLength(500)
    expect(out.lines[0].endsWith("…")).toBe(true)
    expect(out.lines[0].startsWith(long.slice(0, 499))).toBe(true)
    expect(out.lines[1]).toBe("short")
    expect(
      truncateApprovalSummary({ kind: "k", title: "t", lines: ["x".repeat(500)] }).lines[0],
    ).toBe("x".repeat(500))
  })
})
