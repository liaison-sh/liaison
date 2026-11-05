// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { firstExternalInboundSender, ticketParticipantEmail } from "./mail-participant"

const OWN = ["support@company.example", "Sales@Company.example"]

describe("firstExternalInboundSender", () => {
  it("skips an outbound first message: the customer is the first inbound sender", () => {
    expect(
      firstExternalInboundSender(
        [
          {
            direction: "outbound",
            fromEmail: "support@company.example",
            sentAt: "2026-01-01T10:00:00Z",
          },
          {
            direction: "inbound",
            fromEmail: "Jane@Customer.example",
            sentAt: "2026-01-02T10:00:00Z",
          },
        ],
        OWN,
      ),
    ).toBe("jane@customer.example")
  })

  it("skips an inbound copy from one of the org's own mailboxes", () => {
    expect(
      firstExternalInboundSender(
        [
          {
            direction: "inbound",
            fromEmail: "sales@company.example",
            sentAt: "2026-01-01T10:00:00Z",
          },
          {
            direction: "inbound",
            fromEmail: "jane@customer.example",
            sentAt: "2026-01-02T10:00:00Z",
          },
        ],
        OWN,
      ),
    ).toBe("jane@customer.example")
  })

  it("orders by sent time, not by input order", () => {
    expect(
      firstExternalInboundSender(
        [
          {
            direction: "inbound",
            fromEmail: "late@customer.example",
            sentAt: "2026-01-03T10:00:00Z",
          },
          {
            direction: "inbound",
            fromEmail: "early@customer.example",
            sentAt: "2026-01-01T10:00:00Z",
          },
        ],
        OWN,
      ),
    ).toBe("early@customer.example")
  })

  it("is null for a thread with only our own mail", () => {
    expect(
      firstExternalInboundSender(
        [{ direction: "outbound", fromEmail: "support@company.example", sentAt: null }],
        OWN,
      ),
    ).toBeNull()
  })
})

describe("ticketParticipantEmail (P2-SK5)", () => {
  const inbound = [
    { direction: "inbound", fromEmail: "support@company.example", sentAt: "2026-01-01T09:00:00Z" },
    { direction: "inbound", fromEmail: "First@Customer.example", sentAt: "2026-01-01T10:00:00Z" },
  ]
  it("takes the requester first", () => {
    expect(
      ticketParticipantEmail(
        { requesterEmail: " Req@Customer.example ", contactEmail: "c@customer.example", inbound },
        OWN,
      ),
    ).toBe("req@customer.example")
  })
  it("then the linked contact, when the requester is null", () => {
    expect(
      ticketParticipantEmail(
        { requesterEmail: null, contactEmail: "C@customer.example", inbound },
        OWN,
      ),
    ).toBe("c@customer.example")
  })
  it("then the first inbound sender that is not one of our own addresses", () => {
    expect(ticketParticipantEmail({ requesterEmail: null, contactEmail: null, inbound }, OWN)).toBe(
      "first@customer.example",
    )
  })
  it("skips a candidate the caller's address rule refuses", () => {
    const strict = (e: string) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)
    expect(
      ticketParticipantEmail(
        { requesterEmail: '"x y"@customer.example', contactEmail: null, inbound },
        OWN,
        strict,
      ),
    ).toBe("first@customer.example")
  })
  it("is null when there is nobody", () => {
    expect(
      ticketParticipantEmail({ requesterEmail: "", contactEmail: null, inbound: [] }, OWN),
    ).toBeNull()
  })
})
