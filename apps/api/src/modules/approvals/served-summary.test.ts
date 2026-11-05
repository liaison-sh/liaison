// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { type SummaryRunner, withServedSummaries } from "~/modules/approvals/served-summary"
import { approvalSummarizerRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"

const ORG = "00000000-0000-0000-0000-000000000b01"
const USER = "00000000-0000-0000-0000-000000000b02"

// No ticket refs in these rows, so the client is never queried.
const tx = {} as RlsClient
// Runs the summarizer in place of the requester's own transaction.
const run: SummaryRunner = (row, summarize) => summarize({ tx, userId: row.requested_by ?? "" })

afterEach(() => approvalSummarizerRegistry.clear())

const titleOf = (row: { summary: unknown } | undefined) =>
  (row?.summary as { title?: string } | null | undefined)?.title
const linesOf = (row: { summary: unknown } | undefined) =>
  (row?.summary as { lines?: string[] } | null | undefined)?.lines

describe("withServedSummaries", () => {
  // The demo seed writes its approvals straight into the table, with no
  // summary: the card then printed "tickets:reply" as its title and the raw
  // payload as its body (iPhone walk, 2026-10-19).
  it("gives a row written without a summary the one its tool's summarizer writes", async () => {
    registerApprovalSummarizer(ORG, "tickets", "reply", async (params) => ({
      kind: "tickets.reply",
      title: `Reply on ${(params as { ticketId: string }).ticketId}`,
      lines: ["To: Tomoko"],
    }))
    const [row] = await withServedSummaries(
      tx,
      ORG,
      [
        {
          tool_name: "tickets:reply",
          summary: null,
          current_payload: { ticketId: "t-1" },
          requested_by: USER,
        },
      ],
      run,
    )
    expect(titleOf(row)).toBe("Reply on t-1")
    expect(linesOf(row)).toEqual(["To: Tomoko"])
  })

  it("replaces a stored summary whose title is the raw tool id", async () => {
    registerApprovalSummarizer(ORG, "mail", "compose", async () => ({
      kind: "mail.compose",
      title: "Compose via support@",
      lines: ["To: a@b.c"],
    }))
    const [row] = await withServedSummaries(
      tx,
      ORG,
      [
        {
          tool_name: "mail:compose",
          summary: { kind: "mail:compose", title: "mail:compose", lines: ["to: a@b.c"] },
          current_payload: { to: "a@b.c" },
          requested_by: USER,
        },
      ],
      run,
    )
    expect(titleOf(row)).toBe("Compose via support@")
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
    const out = await withServedSummaries(tx, ORG, rows, run)
    expect(out[0]?.summary).toBeNull()
  })

  it("leaves a written summary as it is", async () => {
    const summary = { kind: "k", title: "Create discount code: AUTUMN", lines: ["Code: AUTUMN"] }
    const rows = [
      { tool_name: "shopify:discounts_create", summary, current_payload: {}, requested_by: USER },
    ]
    const out = await withServedSummaries(tx, ORG, rows, run)
    expect(out[0]?.summary).toBe(summary)
  })
})
