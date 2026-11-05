// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression cover for the duplicate-outbound-reply bug (prod, org-wide from
// 2026-07-27): the mailbox sync re-ingested our own Sent copy as a second
// `outbound` message because the only dedupe key was an `external_message_id`
// Gmail had already rewritten. See self-send-marker.ts.

import { describe, expect, it } from "bun:test"
import { processInboundMessage } from "~/apps/tickets/inbound"
import { renderTicketEmail } from "~/apps/tickets/render"
import {
  isSelfSendEcho,
  SELF_SEND_HEADER,
  selfSendMarkerFor,
} from "~/apps/tickets/self-send-marker"

const M = selfSendMarkerFor("ticket-1")

describe("isSelfSendEcho", () => {
  it("detects our marker", () => {
    expect(isSelfSendEcho({ [SELF_SEND_HEADER]: M })).toBe(true)
  })

  // Any sender can add a header. A bare id (or a made-up MAC) must not make a
  // message look like our own Sent copy and silently drop it.
  it("does NOT fire on a marker without a valid MAC", () => {
    expect(isSelfSendEcho({ [SELF_SEND_HEADER]: "ticket-1" })).toBe(false)
    expect(isSelfSendEcho({ [SELF_SEND_HEADER]: "ticket-1.0000000000000000" })).toBe(false)
    expect(isSelfSendEcho({ [SELF_SEND_HEADER]: `ticket-2.${M.split(".").pop()}` })).toBe(false)
  })

  // Providers normalise header casing differently, and MIME header names are
  // case-insensitive — a case-sensitive lookup would silently stop deduping.
  it("is case-insensitive on the header name", () => {
    expect(isSelfSendEcho({ "x-liaison-ticket": M })).toBe(true)
    expect(isSelfSendEcho({ "X-LIAISON-TICKET": M })).toBe(true)
  })

  it("handles a repeated header arriving as an array", () => {
    expect(isSelfSendEcho({ [SELF_SEND_HEADER]: [M, M] })).toBe(true)
  })

  it("does NOT fire on ordinary mail", () => {
    expect(isSelfSendEcho(undefined)).toBe(false)
    expect(isSelfSendEcho({})).toBe(false)
    expect(isSelfSendEcho({ subject: "hi", "message-id": "<x@y>" })).toBe(false)
  })

  // An empty value is not a marker: it would make every header-bearing message
  // look like our own send and silently swallow real customer mail.
  it("does NOT fire on a present-but-empty value", () => {
    expect(isSelfSendEcho({ [SELF_SEND_HEADER]: "" })).toBe(false)
    expect(isSelfSendEcho({ [SELF_SEND_HEADER]: "   " })).toBe(false)
  })
})

describe("renderTicketEmail self-send marker", () => {
  const ticket = { id: "tkt-uuid-1", handle: "ABC123", subject: "Broken pedal", reply_token: "tok" }
  const inbox = {
    id: "ib",
    email_address: "support@fabrikam.example",
    from_display_name: "Support",
  }
  const org = { name: "Fabrikam" }

  it("stamps the ticket id so the sync can recognise the Sent copy", async () => {
    const email = await renderTicketEmail(ticket, { htmlBody: "<p>hello</p>" }, org, inbox, [], {
      kind: "reply",
    })
    expect(email.headers?.extra?.[SELF_SEND_HEADER]).toBe(selfSendMarkerFor("tkt-uuid-1"))
  })

  // The round trip that matters: what we render must be what the ingest side
  // recognises. Asserting both halves against the SAME constant is what stops
  // the two drifting apart.
  it("round-trips: a rendered email's headers are detected as a self-send echo", async () => {
    const email = await renderTicketEmail(ticket, { htmlBody: "<p>hello</p>" }, org, inbox, [], {
      kind: "reply",
    })
    expect(isSelfSendEcho(email.headers?.extra)).toBe(true)
  })
})

describe("processInboundMessage self-send drop", () => {
  const inbox = { id: "ib", org_id: "org", email_address: "support@fabrikam.example" }
  // Any DB touch is a failure: the drop must happen before we do routing work.
  const ctx = {
    orgId: "org",
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("db must not be touched for a self-send echo")
        },
      },
    ),
  } as never

  it("drops our own Sent copy without touching the database", async () => {
    const res = await processInboundMessage(
      {
        subject: "Re: Broken pedal [#ABC123]",
        from: { email: "support@fabrikam.example" },
        messageId: "<rewritten-by-gmail@mail.gmail.com>",
        headers: { [SELF_SEND_HEADER]: selfSendMarkerFor("tkt-uuid-1") },
      } as never,
      inbox as never,
      ctx,
    )
    expect(res).toEqual({ outcome: "dropped", reason: "self_send_echo" })
  })

  // Control: the SAME message without the marker is NOT dropped here — it goes
  // on to real routing (which trips the proxy, or first the trusted-sender
  // lookup for the org, which reads on its own connection). Without this, the
  // test above would still pass if the drop fired for the wrong reason.
  it("does not drop a message that lacks the marker", async () => {
    await expect(
      processInboundMessage(
        {
          subject: "Re: Broken pedal [#ABC123]",
          from: { email: "customer@example.com" },
          messageId: "<real-customer@example.com>",
          headers: {},
        } as never,
        inbox as never,
        ctx,
      ),
    ).rejects.toThrow(/db must not be touched|trusted_senders/)
  })
})
