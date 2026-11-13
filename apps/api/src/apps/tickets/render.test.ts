// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { plainTextToHtml, renderTicketEmail, ticketEmailLocale } from "./render"

const ticket = {
  id: "t1",
  handle: "ticket_AB12",
  subject: "Help with login",
  reply_token: "abc123",
}
const inbox = { id: "i1", email_address: "support@org.test", from_display_name: "Acme Support" }
const orgSettings = {
  name: "Acme",
  tickets: { emailTemplate: { accentColor: "#ff8800", headerName: "Acme Help" } },
}

describe("renderTicketEmail", () => {
  it("produces structured email with reply-to token", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Hi there</p>" },
      orgSettings,
      inbox,
      [],
      { kind: "reply" },
    )
    expect(r.subject).toContain("Re: Help with login")
    expect(r.subject).toContain("[#ticket_AB12]")
    expect((r.replyTo as { email: string }).email).toBe("support+tkt_abc123@org.test")
    expect(r.html).toContain("Hi there")
  })

  it("strips dangerous HTML from agent body", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Hi</p><script>alert(1)</script>" },
      orgSettings,
      inbox,
      [],
      { kind: "reply" },
    )
    expect(r.html).not.toContain("<script>")
    expect(r.html).toContain("Hi")
  })

  it("includes prior message quote with sanitized HTML", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>reply</p>" },
      orgSettings,
      inbox,
      [
        {
          externalMessageId: "<m0@x.test>",
          kind: "inbound" as const,
          htmlBody: "<p>customer asked</p><script>x</script>",
          textBody: "customer asked",
          sentAt: "2026-05-01T00:00:00Z",
          from: { email: "alice@cust.test", name: "Alice" },
        },
      ],
      { kind: "reply" },
    )
    expect(r.html).toContain("customer asked")
    expect(r.html).not.toContain("<script>")
    expect(r.headers?.inReplyTo).toBe("<m0@x.test>")
    expect(r.headers?.references).toEqual(["<m0@x.test>"])
  })

  it("reply From name uses the inbox display name, never a person", async () => {
    const r = await renderTicketEmail(ticket, { htmlBody: "<p>x</p>" }, orgSettings, inbox, [], {
      kind: "reply",
    })
    expect((r.from as { name?: string }).name).toBe("Acme Support")
    expect((r.replyTo as { name?: string }).name).toBe("Acme Support")
  })

  it("reply From name falls back to the org email-template header name when the inbox has none", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>x</p>" },
      orgSettings,
      { ...inbox, from_display_name: null },
      [],
      { kind: "reply" },
    )
    expect((r.from as { name?: string }).name).toBe("Acme Help")
  })

  it("reply From name falls back to the org name when neither inbox nor template name is set", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>x</p>" },
      { name: "Acme" },
      { ...inbox, from_display_name: null },
      [],
      { kind: "reply" },
    )
    expect((r.from as { name?: string }).name).toBe("Acme")
  })

  it("derives plain-text fallback from HTML when textBody not provided", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Body line</p>" },
      orgSettings,
      inbox,
      [],
      { kind: "reply" },
    )
    expect(r.text).toContain("Body line")
  })

  // TIC-05 (S21): an agent-supplied plain-text body used to ship verbatim, so
  // the text/plain part carried no ticket reference while the HTML did.
  it("adds the ticket reference to an agent-supplied plain-text body, once", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Hello</p>", textBody: "Hello\n\nBest regards" },
      orgSettings,
      inbox,
      [],
      { kind: "reply" },
    )
    expect(r.text?.startsWith("Hello\n\nBest regards")).toBe(true)
    expect((r.text ?? "").split(`Ticket reference: [#${ticket.handle}]`).length - 1).toBe(1)
  })

  it("does not add a second reference when the plain-text body already carries the tag", async () => {
    for (const [handle, body] of [
      [ticket.handle, `Hello\n\nTicket reference: [#${ticket.handle}]`],
      ["ticket-B2B-12", "Hello, about [#ticket-12]"],
    ] as const) {
      const r = await renderTicketEmail(
        { ...ticket, handle },
        { htmlBody: "<p>Hello</p>", textBody: body },
        orgSettings,
        inbox,
        [],
        { kind: "reply" },
      )
      expect(r.text).toBe(body)
    }
  })

  it("reply kind includes the reply-by-email CTA and a ticket reference in the body", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Hi there</p>" },
      orgSettings,
      inbox,
      [],
      { kind: "reply" },
    )
    expect(r.html).toContain("You can reply directly to this email to continue the conversation.")
    expect(r.html).toContain(`[#${ticket.handle}]`)
  })

  it("non-reply kinds omit the reply-by-email CTA but still carry the ticket reference", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Closing this out</p>" },
      orgSettings,
      inbox,
      [],
      { kind: "close" },
    )
    expect(r.html).not.toContain("You can reply directly to this email")
    expect(r.html).toContain(`[#${ticket.handle}]`)
  })

  it("renders an ack email with no Re: prefix but the ticket handle in the subject", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>We got your request.</p>" },
      orgSettings,
      inbox,
      [],
      { kind: "ack" },
    )
    expect(r.subject).not.toContain("Re:")
    expect(r.subject).toContain(`[#${ticket.handle}]`)
    expect(r.html).toContain("We got your request.")
  })

  it("ack renders the mailbox's configured signature (config-driven system send)", async () => {
    const inboxWithSignature = {
      ...inbox,
      signature_html: "<p>The Acme Team</p>",
      signature_text: "The Acme Team",
    }
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>We got your request.</p>" },
      orgSettings,
      inboxWithSignature,
      [],
      { kind: "ack" },
    )
    expect(r.html).toContain("The Acme Team")
  })

  it("ack derives the signature from signature_text when no HTML signature is set", async () => {
    const inboxWithSignature = { ...inbox, signature_text: "Line one\nLine two" }
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>We got your request.</p>" },
      orgSettings,
      inboxWithSignature,
      [],
      { kind: "ack" },
    )
    expect(r.html).toContain("Line one<br />Line two")
  })

  it("reply never renders a signature server-side, even when the inbox has one (WYSIWYG: the signature lives in the composed body)", async () => {
    const inboxWithSignature = { ...inbox, signature_html: "<p>Mailbox Signature</p>" }
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Hi</p>" },
      orgSettings,
      inboxWithSignature,
      [],
      { kind: "reply" },
    )
    expect(r.html).not.toContain("Mailbox Signature")
  })

  it("defaults the footer to the mailbox signature text when the org footer is unset", async () => {
    const inboxWithSignature = { ...inbox, signature_text: "Acme Support Team" }
    const orgSettingsNoFooter = { name: "Acme", tickets: { emailTemplate: {} } }
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Hi</p>" },
      orgSettingsNoFooter,
      inboxWithSignature,
      [],
      { kind: "reply" },
    )
    expect(r.html).toContain("Acme Support Team")
  })

  it("defaults the footer to the inbox's own sender identity when both org footer and mailbox signature are unset", async () => {
    const orgSettingsNoFooter = { name: "Acme", tickets: { emailTemplate: {} } }
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Hi</p>" },
      orgSettingsNoFooter,
      inbox,
      [],
      { kind: "reply" },
    )
    expect(r.html).toContain("Acme Support<br />")
    expect(r.html).not.toContain("Fabrikam")
  })

  it("an inbox with no configured identity renders the org's own identity, never another org's", async () => {
    const bareInbox = {
      id: "i2",
      email_address: "help@acme.test",
      from_display_name: null,
      reply_to_email: null,
      signature_text: null,
    }
    const orgSettingsBare = { name: "Acme" }
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Hi</p>" },
      orgSettingsBare,
      bareInbox,
      [],
      { kind: "ack" },
    )
    expect(r.replyTo).toEqual({ email: "help+tkt_abc123@acme.test", name: "Acme" })
    expect(r.html).toContain("Acme<br />")
    expect(`${r.html}\n${r.text}`).not.toMatch(/fabrikam/i)
  })

  it("builds the reply-to plus-token address on the configured reply_to_email base, not the inbox's own address", async () => {
    const inboxWithReplyTo = { ...inbox, reply_to_email: "support@fabrikam.example" }
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Hi</p>" },
      orgSettings,
      inboxWithReplyTo,
      [],
      { kind: "reply" },
    )
    expect((r.replyTo as { email: string }).email).toBe(
      `support+tkt_${ticket.reply_token}@fabrikam.example`,
    )
  })

  it("no customer-facing string uses an em dash, en dash, or double-hyphen as punctuation", async () => {
    const inboxWithSignature = {
      ...inbox,
      signature_html: "<p>The Acme Team</p>",
      signature_text: "The Acme Team",
    }
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>We got your request.</p>" },
      orgSettings,
      inboxWithSignature,
      [
        {
          externalMessageId: "<m0@x.test>",
          kind: "inbound" as const,
          htmlBody: "<p>customer asked</p>",
          textBody: "customer asked",
          sentAt: "2026-05-01T00:00:00Z",
          from: { email: "alice@cust.test", name: "Alice" },
        },
      ],
      { kind: "ack" },
    )
    expect(r.subject).not.toMatch(/[—–]|--/)
    expect(r.html).not.toMatch(/[—–]|--/)
    expect(r.text).not.toMatch(/[—–]|--/)
  })

  // Regression: replying to a web-form-created ticket sent Gmail an empty `To:`
  // and the provider rejected it with a 400 (send_preflight_failed). The `to`
  // field was built from `priorMessages[0]` (the MOST RECENT message overall),
  // but a ticket's most recent message can be a system send with no `from`
  // (e.g. the create-time acknowledgement, sent right after the ticket's
  // ONLY inbound message) — that has `from.email === ""`, so `to` became
  // `[{ email: "" }]`: non-empty, so the caller's `email.to.length === 0`
  // fallback never triggered. A web-form ticket's first inbound message also
  // has an empty `externalMessageId` (there is nothing to thread against yet)
  // — this test exercises BOTH conditions together on the same prior-messages
  // list a real ticket would carry.
  it("reply on a web-form ticket resolves the customer To: even with a from-less ack after it and no externalMessageId on the inbound message", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Following up</p>" },
      orgSettings,
      inbox,
      [
        // Most recent: the create-time acknowledgement — system send, no from.
        {
          externalMessageId: "<ack-1@org.test>",
          kind: "outbound" as const,
          htmlBody: "<p>We got your request.</p>",
          textBody: "We got your request.",
          sentAt: "2026-05-01T00:05:00Z",
          from: { email: "", name: null },
        },
        // Earlier: the web-form ticket's ONLY inbound message — real customer
        // address, but no externalMessageId (nothing arrived over email/Gmail
        // to thread against).
        {
          externalMessageId: null,
          kind: "inbound" as const,
          htmlBody: "<p>I need help</p>",
          textBody: "I need help",
          sentAt: "2026-05-01T00:00:00Z",
          from: { email: "customer@example.com", name: "Customer" },
        },
      ],
      { kind: "reply" },
    )
    expect(r.to).toEqual([{ email: "customer@example.com" }])
    // The ack DOES have an externalMessageId, so it's a valid thread anchor —
    // it should NOT be silently dropped from In-Reply-To/References just
    // because it lacks a `from`.
    expect(r.headers?.inReplyTo).toBe("<ack-1@org.test>")
    expect(r.headers?.references).toEqual(["<ack-1@org.test>"])
  })

  // Regression: outbound rows now persist OUR from identity (the inbox
  // address) so the conversation view can show an author. The recipient pick
  // must therefore be direction-aware — "most recent message with a from.email"
  // would select the outbound row and address the customer reply to ourselves.
  it("reply recipient skips outbound messages that carry the inbox's own from identity", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Following up</p>" },
      orgSettings,
      inbox,
      [
        {
          externalMessageId: "<out-1@org.test>",
          kind: "outbound" as const,
          htmlBody: "<p>Earlier agent reply.</p>",
          textBody: "Earlier agent reply.",
          sentAt: "2026-05-01T00:10:00Z",
          from: { email: inbox.email_address, name: "Support" },
        },
        {
          externalMessageId: "<m0@x.test>",
          kind: "inbound" as const,
          htmlBody: "<p>I need help</p>",
          textBody: "I need help",
          sentAt: "2026-05-01T00:00:00Z",
          from: { email: "customer@example.com", name: "Customer" },
        },
      ],
      { kind: "reply" },
    )
    expect(r.to).toEqual([{ email: "customer@example.com" }])
  })
})

describe("renderTicketEmail recipients and quote", () => {
  const prior = [
    {
      // The newest message, from someone who is not on the ticket.
      externalMessageId: "<stranger@attacker.test>",
      kind: "inbound" as const,
      htmlBody: "<p>stranger text</p>",
      textBody: "stranger text",
      sentAt: "2030-01-01T00:00:00Z",
      from: { email: "mallory@attacker.test", name: "Mallory" },
    },
    {
      externalMessageId: "<a1@cust.test>",
      kind: "inbound" as const,
      htmlBody: "<p>customer order 4411</p>",
      textBody: "customer order 4411",
      sentAt: "2026-05-01T00:00:00Z",
      from: { email: "alice@cust.test", name: "Alice" },
    },
  ]

  it("addresses the stored requester and copies participants, never the newest sender", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>reply</p>" },
      orgSettings,
      inbox,
      prior,
      {
        kind: "reply",
        requester: "alice@cust.test",
        participants: ["bob@cust.test"],
      },
    )
    expect(r.to).toEqual([{ email: "alice@cust.test" }])
    expect(r.cc).toEqual([{ email: "bob@cust.test" }])
  })

  it("quotes only messages the recipients could already see", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>reply</p>" },
      orgSettings,
      inbox,
      prior,
      {
        kind: "reply",
        requester: "alice@cust.test",
      },
    )
    expect(r.html).toContain("customer order 4411")
    expect(r.html).not.toContain("stranger text")
    expect(r.headers?.references).not.toContain("<stranger@attacker.test>")
  })

  it("an acknowledgement quotes nothing", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>ack</p>" },
      orgSettings,
      inbox,
      prior,
      {
        kind: "ack",
        requester: "alice@cust.test",
      },
    )
    expect(r.html).not.toContain("customer order 4411")
  })

  it("an acknowledgement to an unverified address carries a fixed subject", async () => {
    const r = await renderTicketEmail(
      { ...ticket, subject: "Your account is locked, call +1 555 0100 http://evil.test/x" },
      { htmlBody: "<p>ack</p>" },
      orgSettings,
      inbox,
      [],
      { kind: "ack", requester: "victim@cust.test", echoSubject: false },
    )
    expect(r.subject).not.toContain("locked")
    expect(r.subject).toContain("[#ticket_AB12]")
  })

  it("an acknowledgement echoing the subject drops links from it", async () => {
    const r = await renderTicketEmail(
      { ...ticket, subject: "Help http://evil.test/x www.evil.test/y" },
      { htmlBody: "<p>ack</p>" },
      orgSettings,
      inbox,
      [],
      { kind: "ack", requester: "alice@cust.test" },
    )
    expect(r.subject).not.toContain("evil.test")
  })
})

describe("plainTextToHtml", () => {
  it("escapes HTML-significant characters so a typed signature can't inject markup", () => {
    expect(plainTextToHtml("Alex <alex@acme.test> & team")).toBe(
      "Alex &lt;alex@acme.test&gt; &amp; team",
    )
  })

  it("preserves line breaks as <br> for multi-line signatures", () => {
    expect(plainTextToHtml("Alex Rivera\nTessera Support")).toBe("Alex Rivera<br>Tessera Support")
  })

  it("returns an empty string for an empty or whitespace-only signature", () => {
    expect(plainTextToHtml("")).toBe("")
    expect(plainTextToHtml("   \n  ")).toBe("")
  })
})

// A French customer read "Votre ticket ... Ticket reference: [#...]" and an
// English reply hint and quote header around a French answer. Everything the
// email itself says follows the ticket's language, else the org's.
describe("ticket email language", () => {
  const quoted = [
    {
      externalMessageId: "<m0@x.test>",
      kind: "inbound" as const,
      htmlBody: "<p>Bonjour</p>",
      textBody: "Bonjour",
      sentAt: "2026-05-01T08:30:00Z",
      from: { email: "alice@cust.test", name: "Alice" },
    },
  ]

  it("a French org's ticket with no language gets a wholly French email", async () => {
    const r = await renderTicketEmail(
      ticket,
      { htmlBody: "<p>Voici la réponse.</p>" },
      { ...orgSettings, defaultLocale: "fr-FR", timezone: "Europe/Paris" },
      inbox,
      quoted,
      { kind: "reply" },
    )
    expect(r.html).toContain("Référence du ticket : [#ticket_AB12]")
    expect(r.html).toContain("Vous pouvez répondre directement à ce mail")
    expect(r.html).toContain("Le 1 mai 2026")
    expect(r.html).toContain("Alice a écrit :")
    expect(r.html).not.toMatch(/Ticket reference|reply directly|wrote:/)
  })

  it("the ticket's own language beats the org default, display names included", async () => {
    const r = await renderTicketEmail(
      { ...ticket, language: "English" },
      { htmlBody: "<p>Here you go.</p>" },
      { ...orgSettings, defaultLocale: "fr" },
      inbox,
      [],
      { kind: "reply" },
    )
    expect(r.html).toContain("Ticket reference: [#ticket_AB12]")
    expect(ticketEmailLocale("fr", "en-US")).toBe("fr")
    expect(ticketEmailLocale("French", "en-US")).toBe("fr")
    expect(ticketEmailLocale(null, null)).toBe("en")
  })
})

// S21/A13: the subject and body carry the DISPLAY handle, and a subject that
// already carries an older form of the same ticket id (`[#ticket-12]` before
// the org segmented, or a stale segment) is not tagged twice.
describe("renderTicketEmail with a display handle", () => {
  const segmented = { ...ticket, handle: "ticket-B2B-12" }

  it("tags the subject and body with the display handle", async () => {
    const r = await renderTicketEmail(segmented, { htmlBody: "<p>x</p>" }, orgSettings, inbox, [], {
      kind: "reply",
    })
    expect(r.subject).toBe("Re: Help with login [#ticket-B2B-12]")
    expect(r.html).toContain("[#ticket-B2B-12]")
  })

  it("replaces an older form of the same id instead of appending a second tag", async () => {
    for (const old of ["[#ticket-12]", "[#ticket-B2C-12]", "[#TICKET-b2b-12]"]) {
      const r = await renderTicketEmail(
        { ...segmented, subject: `Re: Help with login ${old}` },
        { htmlBody: "<p>x</p>" },
        orgSettings,
        inbox,
        [],
        { kind: "reply" },
      )
      expect(r.subject).toBe("Re: Help with login [#ticket-B2B-12]")
    }
  })

  it("keeps another ticket's tag", async () => {
    const r = await renderTicketEmail(
      { ...segmented, subject: "Re: Help [#ticket-120]" },
      { htmlBody: "<p>x</p>" },
      orgSettings,
      inbox,
      [],
      { kind: "reply" },
    )
    expect(r.subject).toBe("Re: Help [#ticket-120] [#ticket-B2B-12]")
  })
})

describe("renderTicketEmail {{team}}", () => {
  const teamInbox = {
    ...inbox,
    from_display_name: "Help Desk - {{team}}",
    signature_text: "L'équipe Support pour {{team}}",
    signature_html: "<p>L'équipe Support pour <b>{{team}}</b></p>",
  }
  const render = (
    team: string | null | undefined,
    inboxRow: typeof teamInbox | typeof inbox,
    kind: "reply" | "ack" = "ack",
  ) =>
    renderTicketEmail(
      { ...ticket, team },
      { htmlBody: "<p>Hello</p>" },
      orgSettings,
      inboxRow,
      [],
      {
        kind,
        requester: "cust@example.com",
      },
    )

  it("names the ticket's team in the sender name, on replies too", async () => {
    for (const kind of ["ack", "reply"] as const) {
      const r = await render("Riverside Office", teamInbox, kind)
      expect((r.from as { name?: string }).name).toBe("Help Desk - Riverside Office")
      expect((r.replyTo as { name: string }).name).toBe("Help Desk - Riverside Office")
    }
  })

  it("names the team in the acknowledgement signature (html wins over text)", async () => {
    const r = await render("Riverside Office", teamInbox)
    expect(r.html).toContain("L'équipe Support pour <b>Riverside Office</b>")
    expect(r.html).not.toContain("{{team}}")
  })

  it("derives the acknowledgement signature from the text when there is no html", async () => {
    const r = await render("Riverside Office", { ...teamInbox, signature_html: undefined })
    expect(r.html).toContain("L'équipe Support pour Riverside Office")
  })

  it("escapes the team in the html signature and keeps it out of markup", async () => {
    const r = await render(`<img src=x onerror=alert(1)> & "Co"`, teamInbox)
    expect(r.html).not.toContain("<img src=x")
    expect(r.html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;")
  })

  it("a ticket without a team drops the placeholder and its separator", async () => {
    for (const team of [null, undefined, "", "  "]) {
      const r = await render(team, teamInbox)
      expect((r.from as { name?: string }).name).toBe("Help Desk")
      expect(r.html).not.toContain("{{")
      expect(r.html).toContain("L'équipe Support")
      expect(r.html).not.toContain("pour")
    }
  })

  it("a sender name that is only the placeholder falls back to the org header name", async () => {
    const r = await render(null, { ...teamInbox, from_display_name: "{{team}}" })
    expect((r.from as { name?: string }).name).toBe("Acme Help")
  })

  it("an inbox without the placeholder renders exactly as before, team or not", async () => {
    const plain = {
      ...inbox,
      signature_text: "The Acme team",
      signature_html: "<p>The Acme team</p>",
    }
    const withTeam = await render("Riverside Office", plain)
    const without = await render(null, plain)
    expect((withTeam.from as { name?: string }).name).toBe("Acme Support")
    expect(withTeam.html).toContain("<p>The Acme team</p>")
    expect(withTeam.html).toBe(without.html)
    expect(withTeam.text).toBe(without.text)
  })
})
