// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { withServedSummaries } from "~/modules/approvals/served-summary"
import { approvalSummarizerRegistry } from "~/modules/apps/app-registries"
import {
  genericApprovalSummary,
  registerApprovalSummarizer,
} from "~/modules/apps/approval-summarizers"

const ORG = "00000000-0000-0000-0000-000000000b01"
const USER = "00000000-0000-0000-0000-000000000b02"

// No ticket refs in these rows, so the client is never queried.
const tx = {} as RlsClient

afterEach(() => approvalSummarizerRegistry.clear())

const titleOf = (row: { summary: unknown } | undefined) =>
  (row?.summary as { title?: string } | null | undefined)?.title

describe("withServedSummaries", () => {
  // Serving reads storage only: the summary is written when the request is
  // made (and rebuilt when its payload is edited); a row that has none (an
  // older row, one written outside executeTool) gets the generic summary of
  // its payload until the backfill stores the real one. No summarizer runs
  // while a card, a list or the feed is served (no app code on a read path).
  it("gives a row written without a summary the generic summary, without running the summarizer", async () => {
    let calls = 0
    registerApprovalSummarizer(ORG, "tickets", "reply", async (params) => {
      calls++
      return {
        kind: "tickets.reply",
        title: `Reply on ${(params as { ticketId: string }).ticketId}`,
        lines: ["To: Tomoko"],
      }
    })
    const [row] = await withServedSummaries(tx, ORG, [
      {
        tool_name: "tickets:reply",
        summary: null as unknown,
        current_payload: { ticketId: "t-1" },
        requested_by: USER,
      },
    ])
    expect(calls).toBe(0)
    expect(row?.summary).toEqual(genericApprovalSummary("tickets:reply", { ticketId: "t-1" }))
    expect(titleOf(row)).not.toBe("tickets:reply")
  })

  it("replaces a stored summary whose title is the raw tool id with the generic one", async () => {
    let calls = 0
    registerApprovalSummarizer(ORG, "mail", "compose", async () => {
      calls++
      return { kind: "mail.compose", title: "Compose via support@", lines: ["To: a@b.c"] }
    })
    const [row] = await withServedSummaries(tx, ORG, [
      {
        tool_name: "mail:compose",
        summary: { kind: "mail:compose", title: "mail:compose", lines: ["to: a@b.c"] },
        current_payload: { to: "a@b.c" },
        requested_by: USER,
      },
    ])
    expect(calls).toBe(0)
    expect(row?.summary).toEqual(genericApprovalSummary("mail:compose", { to: "a@b.c" }))
    expect(titleOf(row)).not.toBe("mail:compose")
  })

  it("leaves a row whose tool has no summarizer to the feed's payload-derived title", async () => {
    const rows = [
      {
        tool_name: "kernel:contacts_merge",
        summary: null,
        current_payload: {},
        requested_by: USER,
      },
    ]
    const out = await withServedSummaries(tx, ORG, rows)
    expect(out[0]?.summary).toBeNull()
  })

  it("leaves a written summary as it is", async () => {
    const summary = { kind: "k", title: "Create discount code: AUTUMN", lines: ["Code: AUTUMN"] }
    const rows = [
      { tool_name: "shopify:discounts_create", summary, current_payload: {}, requested_by: USER },
    ]
    const out = await withServedSummaries(tx, ORG, rows)
    expect(out[0]?.summary).toBe(summary)
  })
})
