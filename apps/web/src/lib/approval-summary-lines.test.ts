// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Walk 2026-10-12: the create-routine approval card ended on "ROUTINE-SIZING
// HONESTY — your reply MUST make clear (so the user is not misled into
// expecting autopilot):", an instruction the summarizer writes for the agent
// that proposed the routine (it reads the same summary back before it replies).
// A reviewer must not read orders addressed to the agent.
import { describe, expect, it } from "vitest"
import { quotedParts, readableSummaryLines } from "~/lib/approval-summary-lines"

describe("readableSummaryLines", () => {
  it("drops the blocks addressed to the proposing agent, keeps the facts around them", () => {
    const lines = readableSummaryLines([
      "Read new mail in the Sales mailbox and draft replies",
      "cron: 0 8 * * * (UTC)",
      "EVENT-COALESCE HONESTY — your reply MUST state (so the user is not misled about real-time behavior):",
      "• The exact in-tree event it subscribes to: mail:message:create",
      "• Events are COALESCED on a ~30s window",
      "Scope ceiling: mail:conversations:read",
      "HONESTY DISCLOSURES — your reply should make clear (so the user is not misled):",
      "• It polls, it is not real time",
      "Prompt: Search the mail inbox for unread messages.",
      "ROUTINE-SIZING HONESTY — your reply MUST make clear (so the user is not misled into expecting autopilot):",
    ])
    expect(lines).toEqual([
      "Read new mail in the Sales mailbox and draft replies",
      "cron: 0 8 * * * (UTC)",
      "Scope ceiling: mail:conversations:read",
      "Prompt: Search the mail inbox for unread messages.",
    ])
  })

  it("keeps a bullet that does not follow an agent block", () => {
    expect(readableSummaryLines(["Items:", "• two monitors"])).toEqual(["Items:", "• two monitors"])
  })

  it("still expands a stored JSON line into key: value lines", () => {
    expect(readableSummaryLines(['{"hub_id":"h1","customer_id":"c1"}'])).toEqual([
      "hub_id: h1",
      "customer_id: c1",
    ])
  })

  it("keeps the outside-text marking, and splits a line into its words and the quote", () => {
    const stored =
      '15 tickets. E.g. <external-content source="untrusted">\n{"subject":"Printer <b>jam</b>"}\n</external-content>'
    expect(readableSummaryLines([stored])).toEqual([stored])
    expect(quotedParts(stored)).toEqual([
      { text: "15 tickets. E.g.", quoted: false },
      { text: '{"subject":"Printer <b>jam</b>"}', quoted: true },
    ])
    // A fence clipped before its closing tag quotes the rest of the line.
    expect(quotedParts('E.g. <external-content source="untrusted">\n{"a":1')).toEqual([
      { text: "E.g.", quoted: false },
      { text: '{"a":1', quoted: true },
    ])
    expect(quotedParts("Plain line")).toEqual([{ text: "Plain line", quoted: false }])
  })
})
