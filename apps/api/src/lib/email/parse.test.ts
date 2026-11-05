// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { parseGmailPayload, parseImapMessage } from "./parse"
import { toRfc2822 } from "./rfc2822"

function b64url(text: string): string {
  return Buffer.from(text, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

describe("parseGmailPayload", () => {
  it("extracts headers and bodies from a single-part text message", () => {
    const r = parseGmailPayload({
      id: "g1",
      threadId: "t1",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "Message-Id", value: "<g1@x.test>" },
          { name: "From", value: "Alice <alice@x.test>" },
          { name: "To", value: "bob@y.test" },
          { name: "Subject", value: "Hi" },
          { name: "Date", value: "Mon, 01 Jan 2026 00:00:00 +0000" },
        ],
        body: { data: b64url("hello world") },
      },
    })
    expect(r.messageId).toBe("<g1@x.test>")
    expect(r.from).toEqual({ email: "alice@x.test", name: "Alice" })
    expect(r.to?.[0].email).toBe("bob@y.test")
    expect(r.subject).toBe("Hi")
    expect(r.textBody).toBe("hello world")
    expect(r.sentAt).toBeDefined()
  })

  it("multipart/alternative with text and html", () => {
    const r = parseGmailPayload({
      id: "g2",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "Message-Id", value: "<g2@x.test>" },
          { name: "From", value: "a@x.test" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: b64url("plain") } },
          { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
        ],
      },
    })
    expect(r.textBody).toBe("plain")
    expect(r.htmlBody).toBe("<p>html</p>")
  })

  it("falls back to message id when Message-Id header missing", () => {
    const r = parseGmailPayload({ id: "abc", payload: { headers: [] } })
    expect(r.messageId).toBe("<abc@mail.gmail.com>")
  })

  it("extracts references[] correctly", () => {
    const r = parseGmailPayload({
      id: "g3",
      payload: {
        headers: [
          { name: "References", value: "<a@x.test> <b@x.test>" },
          { name: "In-Reply-To", value: "<b@x.test>" },
        ],
      },
    })
    expect(r.references).toEqual(["<a@x.test>", "<b@x.test>"])
    expect(r.inReplyTo).toBe("<b@x.test>")
  })

  it("returns undefined bodies when there are none", () => {
    const r = parseGmailPayload({ id: "g4", payload: { headers: [] } })
    expect(r.textBody).toBeUndefined()
    expect(r.htmlBody).toBeUndefined()
  })

  it("does not throw on a malformed Date header (poison-pill) and falls back to internalDate", () => {
    expect(() =>
      parseGmailPayload({
        id: "g5",
        internalDate: "1735689600000",
        payload: { headers: [{ name: "Date", value: "not-a-real-date" }] },
      }),
    ).not.toThrow()
    const r = parseGmailPayload({
      id: "g5",
      internalDate: "1735689600000",
      payload: { headers: [{ name: "Date", value: "garbage!!!" }] },
    })
    // Invalid Date header is ignored; sentAt comes from the numeric internalDate.
    expect(r.sentAt).toBe(new Date(1735689600000).toISOString())
  })

  it("leaves sentAt undefined when both Date and internalDate are unparseable", () => {
    const r = parseGmailPayload({
      id: "g6",
      internalDate: "not-a-number",
      payload: { headers: [{ name: "Date", value: "???" }] },
    })
    expect(r.sentAt).toBeUndefined()
  })

  it("collects attachments (inline bytes and provider-id parts)", () => {
    const r = parseGmailPayload({
      id: "g7",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "From", value: "a@x.test" }],
        parts: [
          { mimeType: "text/plain", body: { data: b64url("body") } },
          {
            mimeType: "application/pdf",
            filename: "invoice.pdf",
            body: { attachmentId: "att-123", size: 4096 },
          },
          {
            mimeType: "image/png",
            filename: "logo.png",
            headers: [
              { name: "Content-Id", value: "<logo@x.test>" },
              { name: "Content-Disposition", value: "inline" },
            ],
            body: { data: b64url("PNGBYTES") },
          },
        ],
      },
    })
    expect(r.attachments).toHaveLength(2)
    const pdf = r.attachments?.find((a) => a.filename === "invoice.pdf")
    expect(pdf?.providerAttachmentId).toBe("att-123")
    expect(pdf?.disposition).toBe("attachment")
    const png = r.attachments?.find((a) => a.filename === "logo.png")
    expect(png?.disposition).toBe("inline")
    expect(png?.contentId).toBe("logo@x.test")
    expect(png?.bytesBase64).toBeDefined()
  })
})

describe("parseGmailPayload — quoted display names with commas (RFC 5322)", () => {
  it("does not split a quoted display name at the comma", () => {
    // RFC 5322 allows display names like "Smith, Alice" <alice@example.com>.
    // A naive comma-split would produce ["Smith", "Alice <alice@example.com>"]
    // and drop the email. The RFC-5322-compliant parser must treat the comma
    // inside the quoted string as part of the name, not as a field separator.
    const r = parseGmailPayload({
      id: "qn1",
      payload: {
        headers: [
          { name: "From", value: "sender@x.test" },
          {
            name: "To",
            value: '"Smith, Alice" <alice@example.com>, Bob <bob@example.com>',
          },
          {
            name: "Cc",
            value: '"Jones, Charlie" <charlie@example.com>',
          },
        ],
      },
    })
    expect(r.to).toHaveLength(2)
    expect(r.to?.[0]).toEqual({ email: "alice@example.com", name: "Smith, Alice" })
    expect(r.to?.[1]).toEqual({ email: "bob@example.com", name: "Bob" })
    expect(r.cc).toHaveLength(1)
    expect(r.cc?.[0]).toEqual({ email: "charlie@example.com", name: "Jones, Charlie" })
  })
})

describe("sender addresses: crafted headers cannot pick the parsed address", () => {
  // Each header below names attacker@evil.example as the only RFC 5322 address. Older
  // nodemailer addressparser builds pulled the address out of a comment or a quoted local
  // part instead, so the message was stored as coming from the victim address.
  const crafted = [
    "Customer (x(y) <ceo@victim-org.example>) <attacker@evil.example>",
    "G: (a; <ceo@victim-org.example>) <attacker@evil.example>;",
  ]
  for (const from of crafted) {
    it(`Gmail From ${JSON.stringify(from)} parses to the real address`, () => {
      const r = parseGmailPayload({
        id: "spoof",
        payload: { headers: [{ name: "From", value: from }] },
      })
      expect(r.from?.email).not.toBe("ceo@victim-org.example")
      expect(r.from?.email).toBe("attacker@evil.example")
    })
    it(`IMAP From ${JSON.stringify(from)} parses to the real address`, async () => {
      const r = await parseImapMessage(
        `From: ${from}\r\nSubject: s\r\nMessage-ID: <m@x.test>\r\n\r\nbody`,
      )
      expect(r.from?.email).not.toBe("ceo@victim-org.example")
      expect(r.from?.email).toBe("attacker@evil.example")
    })
  }
})

describe("parseImapMessage", () => {
  it("delegates to parseRfc2822", async () => {
    const blob = "From: a@x.test\r\nSubject: Hello\r\nMessage-ID: <m@x.test>\r\n\r\nbody"
    const r = await parseImapMessage(blob)
    expect(r.messageId).toBe("<m@x.test>")
    expect(r.subject).toBe("Hello")
  })

  it("extracts attachments from a multipart message with an attachment", async () => {
    const content = Buffer.from("pdf-bytes-here").toString("base64")
    const mime = toRfc2822({
      from: { email: "sender@x.test" },
      to: [{ email: "recipient@y.test" }],
      subject: "Attached",
      text: "See attached file.",
      attachments: [{ filename: "report.pdf", mimeType: "application/pdf", content }],
    })
    const r = await parseImapMessage(mime)
    expect(r.attachments).toHaveLength(1)
    const att = r.attachments?.[0]
    expect(att?.filename).toBe("report.pdf")
    expect(att?.mimeType).toContain("application/pdf")
    expect(att?.disposition).toBe("attachment")
    expect(att?.bytesBase64).toBeDefined()
    expect(Buffer.from(att?.bytesBase64 ?? "", "base64").toString()).toBe("pdf-bytes-here")
  })

  it("extracts an inline attachment with a content-id", async () => {
    const content = Buffer.from("png-bytes").toString("base64")
    const mime = toRfc2822({
      from: { email: "sender@x.test" },
      to: [{ email: "recipient@y.test" }],
      subject: "Inline image",
      html: '<img src="cid:logo@x.test">',
      attachments: [
        {
          filename: "logo.png",
          mimeType: "image/png",
          content,
          disposition: "inline",
          contentId: "logo@x.test",
        },
      ],
    })
    const r = await parseImapMessage(mime)
    expect(r.attachments).toHaveLength(1)
    const att = r.attachments?.[0]
    expect(att?.filename).toBe("logo.png")
    expect(att?.disposition).toBe("inline")
  })
})

describe("parseGmailPayload — the body is the message, never an attachment", () => {
  type Part = import("./parse").GmailMessagePayload
  const leaf = (mimeType: string, text: string): Part => ({
    mimeType,
    filename: "",
    headers: [{ name: "Content-Type", value: `${mimeType}; charset="UTF-8"` }],
    body: { size: text.length, data: b64url(text) },
  })
  const fileLeaf = (mimeType: string, filename: string, text: string, disposition: string) => ({
    ...leaf(mimeType, text),
    filename,
    headers: [
      { name: "Content-Type", value: `${mimeType}; name="${filename}"` },
      { name: "Content-Disposition", value: `${disposition}; filename="${filename}"` },
    ],
  })
  const parse = (payload: Part) =>
    parseGmailPayload({
      id: "body-1",
      payload: { headers: [{ name: "From", value: "a@x.test" }], ...payload },
    })

  it("a text or HTML file attached after a plain-text body does not become the body", () => {
    const r = parse({
      mimeType: "multipart/mixed",
      parts: [
        leaf("text/plain", "The real message."),
        fileLeaf("text/html", "page.html", "<p>ATTACHED PAGE</p>", "attachment"),
        fileLeaf("text/plain", "notes.txt", "ATTACHED NOTES", "attachment"),
      ],
    })
    expect(r.textBody).toBe("The real message.")
    expect(r.htmlBody).toBeUndefined()
    expect(r.attachments?.map((a) => a.filename)).toEqual(["page.html", "notes.txt"])
  })

  it("a body sent as an inline named text part is still the body", () => {
    const named: Part = {
      ...leaf("text/plain", "Body carried by a named part."),
      filename: "message.txt",
      headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"; name="message.txt"' }],
    }
    expect(parse(named).textBody).toBe("Body carried by a named part.")
    const mixed = parse({
      mimeType: "multipart/mixed",
      parts: [named, fileLeaf("text/plain", "notes.txt", "ATTACHED NOTES", "attachment")],
    })
    expect(mixed.textBody).toBe("Body carried by a named part.")
  })

  it("an inline named text part does not join a message that has its own unnamed body", () => {
    const r = parse({
      mimeType: "multipart/mixed",
      parts: [
        leaf("text/plain", "The real message."),
        {
          ...leaf("text/plain", "INLINE NOTES"),
          filename: "notes.txt",
          headers: [{ name: "Content-Type", value: 'text/plain; name="notes.txt"' }],
        },
      ],
    })
    expect(r.textBody).toBe("The real message.")
  })

  it("an HTML body split around an inline attachment keeps every fragment", () => {
    const r = parse({
      mimeType: "multipart/alternative",
      parts: [
        leaf("text/plain", "Hello, the quote is attached.\n\nRegards"),
        {
          mimeType: "multipart/mixed",
          filename: "",
          parts: [
            leaf("text/html", "<html><body><div>Hello, the quote is attached.</div>"),
            {
              mimeType: "application/pdf",
              filename: "quote.pdf",
              headers: [
                { name: "Content-Type", value: 'application/pdf; name="quote.pdf"' },
                { name: "Content-Disposition", value: 'inline; filename="quote.pdf"' },
              ],
              body: { attachmentId: "ANG_quote", size: 90000 },
            },
            leaf("text/html", "<div>Regards</div></body></html>"),
          ],
        },
      ],
    })
    expect(r.htmlBody).toBe(
      "<html><body><div>Hello, the quote is attached.</div><div>Regards</div></body></html>",
    )
    expect(r.textBody).toBe("Hello, the quote is attached.\n\nRegards")
  })

  it("a forwarded message attached as .eml does not supply the body", () => {
    const r = parse({
      mimeType: "multipart/mixed",
      parts: [
        leaf("text/plain", "See the mail below."),
        {
          mimeType: "message/rfc822",
          filename: "",
          headers: [{ name: "Content-Type", value: "message/rfc822" }],
          body: { size: 0 },
          parts: [
            {
              mimeType: "multipart/alternative",
              filename: "",
              parts: [
                leaf("text/plain", "INNER MESSAGE"),
                leaf("text/html", "<p>INNER MESSAGE</p>"),
              ],
            },
          ],
        },
      ],
    })
    expect(r.textBody).toBe("See the mail below.")
    expect(r.htmlBody).toBeUndefined()
  })
})

describe("parseImapMessage — the body is the message, never an attachment", () => {
  const CRLF = "\r\n"
  const mime = (lines: string[]) => lines.join(CRLF)

  it("ignores attached text/HTML files, joins a split HTML body and skips a forwarded .eml", async () => {
    const r = await parseImapMessage(
      mime([
        "From: a@x.test",
        "Message-ID: <imap-body@x.test>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="OUT"',
        "",
        "--OUT",
        'Content-Type: text/html; charset="UTF-8"',
        "",
        "<div>Hello</div>",
        "--OUT",
        'Content-Type: application/pdf; name="q.pdf"',
        'Content-Disposition: inline; filename="q.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("pdf").toString("base64"),
        "--OUT",
        'Content-Type: text/html; charset="UTF-8"',
        "",
        "<div>Regards</div>",
        "--OUT",
        'Content-Type: text/plain; name="notes.txt"',
        'Content-Disposition: attachment; filename="notes.txt"',
        "",
        "ATTACHED NOTES",
        "--OUT",
        "Content-Type: message/rfc822",
        "",
        "From: inner@x.test",
        "Subject: inner",
        "Content-Type: text/plain",
        "",
        "INNER MESSAGE",
        "--OUT--",
        "",
      ]),
    )
    expect(r.htmlBody).toContain("Hello")
    expect(r.htmlBody).toContain("Regards")
    expect(r.htmlBody).not.toContain("ATTACHED NOTES")
    expect(r.htmlBody).not.toContain("INNER MESSAGE")
    expect(r.textBody ?? "").not.toContain("ATTACHED NOTES")
    expect(r.textBody ?? "").not.toContain("INNER MESSAGE")
  })
})
