// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { summarizeTicketClose, summarizeTicketNudge, summarizeTicketReply } from "./summarizers"

// Ticket ids are uuids on the wire (a `ticket-<n>` handle is resolved to one
// before any query), so the fakes use a real uuid.
const T1 = "11111111-1111-4111-8111-111111111111"

function fakeCtx(rows: Record<string, unknown>[] = []) {
  return {
    tx: {
      execute: async () => ({ rows }) as never,
    } as never,
    orgId: "org-1",
    userId: "u-1",
  }
}

describe("summarizeTicketReply", () => {
  it("shows the address the reply will actually go to, and flags one that is not the contact's", async () => {
    const ctx = fakeCtx([
      {
        id: T1,
        handle: "ticket_AB12",
        subject: "Help me",
        reply_token: "tok",
        contact_email: "alice@cust.test",
        contact_name: "Alice",
        requester_email: "someone-else@cust.test",
        participant_emails: ["bob@cust.test"],
      },
    ])
    const r = await summarizeTicketReply({ ticketId: T1, textBody: "Sure thing!" }, ctx)
    expect(r.lines).toContain("To: someone-else@cust.test")
    expect(r.lines.some((l) => l.includes("bob@cust.test"))).toBe(true)
    expect(r.lines.some((l) => l.includes("differs from the linked contact"))).toBe(true)
    expect(r.subtitle).toContain("someone-else@cust.test")
  })

  it("produces tickets.reply summary with subject + preview", async () => {
    const ctx = fakeCtx([
      {
        id: T1,
        handle: "ticket_AB12",
        subject: "Help me",
        reply_token: "tok",
        contact_email: "alice@cust.test",
        contact_name: "Alice",
      },
    ])
    const r = await summarizeTicketReply({ ticketId: T1, textBody: "Sure thing!" }, ctx)
    expect(r.kind).toBe("tickets.reply")
    expect(r.title).toBe("Help me")
    // S23/A9: the id leads the card as `ref`; the subtitle is the action + customer.
    expect(r.subtitle).toBe("Reply to Alice")
    expect(r.ref).toBe("ticket_AB12")
    // No body-preview line — the full reply text is rendered by the approval
    // card's own Message block (sourced from the payload), not duplicated here.
    expect(r.lines.some((l) => l.includes("Sure thing!"))).toBe(false)
  })

  it("names every Cc recipient on the approval card", async () => {
    const ctx = fakeCtx([{ id: T1, handle: "ticket_AB12", subject: "Help me" }])
    const r = await summarizeTicketReply(
      { ticketId: T1, textBody: "hi", cc: ["boss@cust.test", "ops@cust.test"] },
      ctx,
    )
    expect(r.lines).toContain("Cc: boss@cust.test, ops@cust.test")
  })

  it("falls back when ticket missing", async () => {
    const ctx = fakeCtx([])
    const r = await summarizeTicketReply({ ticketId: "missing" }, ctx)
    expect(r.title).toBe("(no subject)")
  })
})

/** Extract raw SQL text from a drizzle `sql` object so a mock can branch on it. */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? []
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown }).value
      return Array.isArray(v) ? v.join("") : ""
    })
    .join(" ")
    .toLowerCase()
}

/**
 * SQL-aware ctx for attachment summary tests — branches the `execute` mock by
 * which query is running (ticket summary / file origin / origin-root lookup).
 */
function attachCtx(opts: {
  ticket: Record<string, unknown>
  fileOrigin?: Record<string, unknown>
  originRootTicketId?: string
}) {
  return {
    tx: {
      execute: async (q: unknown) => {
        const t = sqlText(q)
        // `${K}` raw chunks are space-joined by sqlText, so match single tokens.
        if (t.includes(".files") && t.includes("left join")) {
          return opts.fileOrigin ? [opts.fileOrigin] : []
        }
        // resolveOriginRoot — the only query that SELECTS ticket_id as a top-level column
        // (the ticket-summary query below also references `m.ticket_id` in its last-message
        // subquery, so match the more specific "select ticket_id" prefix, not a bare substring).
        if (t.includes("select ticket_id")) {
          return opts.originRootTicketId ? [{ ticket_id: opts.originRootTicketId }] : []
        }
        return [opts.ticket]
      },
    } as never,
    orgId: "org-1",
    userId: "u-1",
  }
}

const TICKET_ROW = {
  id: "ticket-A",
  handle: "ticket_AB12",
  subject: "Help me",
  reply_token: "tok",
  contact_email: "alice@cust.test",
  contact_name: "Alice",
}

describe("summarizeTicketReply attachments", () => {
  it("lists an attachment from the same ticket with 📎 and no ⚠", async () => {
    const ctx = attachCtx({
      ticket: TICKET_ROW,
      fileOrigin: {
        filename: "same-ticket.pdf",
        app: "tickets",
        entityType: "message",
        entityId: "tm-A",
        sessionApp: null,
      },
      originRootTicketId: "ticket-A",
    })
    const r = await summarizeTicketReply(
      { ticketId: "ticket-A", textBody: "Here", attachments: ["f1"] },
      ctx,
    )
    const line = r.lines.find((l) => l.includes("same-ticket.pdf"))
    expect(line).toBeDefined()
    expect(line).toContain("📎")
    expect(line).not.toContain("⚠")
  })

  it("flags an attachment from a DIFFERENT ticket with ⚠", async () => {
    const ctx = attachCtx({
      ticket: TICKET_ROW,
      fileOrigin: {
        filename: "other-customer.pdf",
        app: "tickets",
        entityType: "message",
        entityId: "tm-B",
        sessionApp: null,
      },
      originRootTicketId: "ticket-B",
    })
    const r = await summarizeTicketReply(
      { ticketId: "ticket-A", textBody: "x", attachments: ["f1"] },
      ctx,
    )
    const line = r.lines.find((l) => l.includes("other-customer.pdf"))
    expect(line).toBeDefined()
    expect(line).toContain("⚠")
  })

  it("renders an unresolved @ref attachment as a placeholder", async () => {
    const ctx = attachCtx({ ticket: TICKET_ROW })
    const r = await summarizeTicketReply(
      {
        ticketId: "ticket-A",
        textBody: "x",
        attachments: ["@ref:11111111-1111-4111-8111-111111111111:label_pdf"],
      },
      ctx,
    )
    expect(r.lines.some((l) => l.includes("📎") && /step|earlier/i.test(l))).toBe(true)
  })
})

describe("summarizeTicketNudge", () => {
  it("returns tickets.nudge kind", async () => {
    const ctx = fakeCtx([
      {
        id: T1,
        handle: "ticket_X",
        subject: "S",
        reply_token: "tok",
        contact_email: null,
        contact_name: null,
      },
    ])
    const r = await summarizeTicketNudge({ ticketId: T1, textBody: "Still there?" }, ctx)
    expect(r.kind).toBe("tickets.nudge")
    // No body-preview line — see the identical note in summarizeTicketReply's test.
    expect(r.lines.some((l) => l.includes("Still there?"))).toBe(false)
  })
})

describe("summarizeTicketClose", () => {
  it("silent close mentions no-email", async () => {
    const ctx = fakeCtx([
      {
        id: T1,
        handle: "h",
        subject: "S",
        reply_token: "t",
        contact_email: null,
        contact_name: null,
      },
    ])
    const r = await summarizeTicketClose({ ticketId: T1, closedReason: "resolved" }, ctx)
    expect(r.lines[0]).toContain("Reason: resolved")
    expect(r.lines[1]).toContain("silent close")
    // Silent close is org-internal and reversible.
    expect(r.impact).toBe("internal")
  })

  it("defaults the reason to resolved when none is given", async () => {
    const ctx = fakeCtx([
      {
        id: T1,
        handle: "h",
        subject: "S",
        reply_token: "t",
        contact_email: null,
        contact_name: null,
      },
    ])
    const r = await summarizeTicketClose({ ticketId: T1 }, ctx)
    expect(r.lines[0]).toContain("Reason: resolved")
  })

  it("with-body close omits the body-preview line (Message block owns the text)", async () => {
    const ctx = fakeCtx([
      {
        id: T1,
        handle: "h",
        subject: "S",
        reply_token: "t",
        contact_email: null,
        contact_name: null,
      },
    ])
    const r = await summarizeTicketClose(
      { ticketId: T1, closedReason: "duplicate", textBody: "Closing as dup" },
      ctx,
    )
    expect(r.lines[0]).toContain("Reason: duplicate")
    expect(r.lines.some((l) => l.includes("Closing as dup"))).toBe(false)
    expect(r.lines.some((l) => l.includes("silent close"))).toBe(false)
    // A close WITH a body emails the customer — external blast radius.
    expect(r.impact).toBe("external")
  })

  it("html-only body close is also external", async () => {
    const ctx = fakeCtx([
      {
        id: T1,
        handle: "h",
        subject: "S",
        reply_token: "t",
        contact_email: null,
        contact_name: null,
      },
    ])
    const r = await summarizeTicketClose({ ticketId: T1, htmlBody: "<p>Closing note</p>" }, ctx)
    expect(r.impact).toBe("external")
  })
})
