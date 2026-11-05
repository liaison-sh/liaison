// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  buildDraftClaimReprompt,
  extractTicketIdFromTriggerEvent,
  postedTextClaimsDraft,
} from "~/modules/agent/routines/routine-draft-claim-guard"

describe("extractTicketIdFromTriggerEvent", () => {
  it("returns data.ticketId for a tickets event", () => {
    expect(
      extractTicketIdFromTriggerEvent({
        app: "tickets",
        entity: "ticket",
        action: "create",
        entityId: "aaaaaaaa-0000-0000-0000-000000000001",
        data: { ticketId: "aaaaaaaa-0000-0000-0000-000000000001", handle: "ticket-42" },
      }),
    ).toBe("aaaaaaaa-0000-0000-0000-000000000001")
  })

  it("falls back to entityId when data has no ticketId", () => {
    expect(
      extractTicketIdFromTriggerEvent({
        app: "tickets",
        entityId: "bbbbbbbb-0000-0000-0000-000000000002",
        data: {},
      }),
    ).toBe("bbbbbbbb-0000-0000-0000-000000000002")
  })

  it("ignores non-tickets events and absent events", () => {
    expect(extractTicketIdFromTriggerEvent({ app: "mail", entityId: "x" })).toBeNull()
    expect(extractTicketIdFromTriggerEvent(undefined)).toBeNull()
    expect(extractTicketIdFromTriggerEvent(null)).toBeNull()
    expect(extractTicketIdFromTriggerEvent("tickets")).toBeNull()
  })
})

describe("postedTextClaimsDraft", () => {
  it("matches the live fabrication shapes", () => {
    // Verbatim shape from the ticket-5096 incident tick.
    expect(
      postedTextClaimsDraft(
        "Gated Reply Drafted: I have prepared a gated email draft to the customer. Since this is a gated tool action, it is now pending your approval.",
      ),
    ).toBe(true)
    expect(
      postedTextClaimsDraft("A draft was prepared and queued; it is awaiting your approval."),
    ).toBe(true)
    expect(
      postedTextClaimsDraft("Please approve the pending reply so it reaches the customer."),
    ).toBe(true)
    // Second live shape (ticket-9923 recurrence): cites an approval entity link
    // and defers to "once approved" without any tickets__reply call this tick.
    expect(
      postedTextClaimsDraft(
        "Pending Action: @[Approval #c7253659](kernel:approval_request:c7253659-e67c-4bfc-8a8b-cc6dbd944742). Once approved, the draft will be dispatched to the customer.",
      ),
    ).toBe(true)
    expect(postedTextClaimsDraft("See Approval #12ab34cd for the reply.")).toBe(true)
  })

  it("does not match honest no-draft / stand-down summaries", () => {
    expect(
      postedTextClaimsDraft("Human teammate is driving this thread; standing down, no draft."),
    ).toBe(false)
    expect(
      postedTextClaimsDraft("Automated telemetry, no reply needed. Added an internal note only."),
    ).toBe(false)
    expect(postedTextClaimsDraft("We are awaiting the customer's reply; no action taken.")).toBe(
      false,
    )
    expect(postedTextClaimsDraft("")).toBe(false)
    expect(postedTextClaimsDraft(null)).toBe(false)
  })

  it("does not match generic mentions of approvals without a draft claim", () => {
    expect(
      postedTextClaimsDraft("Note: tickets:reply is a gated tool and requires human approval."),
    ).toBe(false)
  })
})

describe("buildDraftClaimReprompt", () => {
  it("names the ticket and demands a real tickets__reply call or an honest correction", () => {
    const s = buildDraftClaimReprompt("cccccccc-0000-0000-0000-000000000003")
    expect(s).toContain("cccccccc-0000-0000-0000-000000000003")
    expect(s).toContain("tickets__reply")
    expect(s).toContain("NO draft was created")
  })
})
