// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { simpleParser } from "mailparser"
import { parseRfc2822, toRfc2822 } from "./rfc2822"

describe("toRfc2822", () => {
  it("round-trips through mailparser with intact headers and bodies", async () => {
    const mime = toRfc2822({
      from: { email: "a@x.test", name: "A" },
      replyTo: { email: "a+tkt_X@x.test", name: "A" },
      to: [{ email: "b@y.test" }],
      cc: [],
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
      headers: {
        messageId: "<m1@x.test>",
        inReplyTo: "<p0@y.test>",
        references: ["<p0@y.test>", "<p-1@y.test>"],
      },
    })
    const parsed = await simpleParser(mime)
    expect(parsed.subject).toBe("Hello")
    expect(parsed.messageId).toBe("<m1@x.test>")
    expect(parsed.inReplyTo).toBe("<p0@y.test>")
    expect(parsed.references).toEqual(["<p0@y.test>", "<p-1@y.test>"])
    expect(parsed.from?.value[0]).toEqual({ name: "A", address: "a@x.test" })
  })

  it("RFC 2047-encodes a non-ASCII subject and display names, keeping the header ASCII", async () => {
    const subject = `Liaison : accès aux stats Instagram ${"é".repeat(40)}`
    const mime = toRfc2822({
      from: { email: "a@x.test", name: "Équipe Support" },
      to: [{ email: "b@y.test", name: "Zoë" }],
      subject,
      text: "body",
    })
    const headerBlock = mime.slice(0, mime.indexOf("\r\n\r\n"))
    expect(headerBlock).toMatch(/^[\x20-\x7e\r\n]+$/)
    expect(headerBlock).toContain("From: =?UTF-8?B?")
    expect(headerBlock).toContain(" <a@x.test>")
    const parsed = await simpleParser(mime)
    expect(parsed.subject).toBe(subject)
    expect(parsed.from?.value[0]).toEqual({ name: "Équipe Support", address: "a@x.test" })
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to
    expect(to?.value[0]).toEqual({ name: "Zoë", address: "b@y.test" })
  })

  it("uses CRLF line endings", () => {
    const mime = toRfc2822({
      from: { email: "a@x.test" },
      to: [{ email: "b@y.test" }],
      subject: "S",
      text: "body",
    })
    expect(mime.includes("\r\n")).toBe(true)
    const noCr = mime.replace(/\r\n/g, "")
    expect(noCr.includes("\n")).toBe(false)
  })

  it("folds long header values to <=998 chars per line", () => {
    const longSubject = "x".repeat(300)
    const mime = toRfc2822({
      from: { email: "a@x.test" },
      to: [{ email: "b@y.test" }],
      subject: longSubject,
      text: "body",
    })
    for (const line of mime.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(998)
    }
  })

  it("omits empty cc/bcc/references headers", () => {
    const mime = toRfc2822({
      from: { email: "a@x.test" },
      to: [{ email: "b@y.test" }],
      cc: [],
      subject: "S",
      text: "body",
    })
    expect(mime).not.toMatch(/^Cc:/m)
    expect(mime).not.toMatch(/^References:/m)
  })

  it("multipart body when both text and html are present", () => {
    const mime = toRfc2822({
      from: { email: "a@x.test" },
      to: [{ email: "b@y.test" }],
      subject: "S",
      html: "<p>hi</p>",
      text: "hi",
    })
    expect(mime).toContain("multipart/alternative")
    expect(mime).toContain("text/plain")
    expect(mime).toContain("text/html")
  })

  it("emits multipart/mixed with a base64 attachment part when attachments are present", () => {
    const content = Buffer.from("PDF-BYTES").toString("base64")
    const mime = toRfc2822({
      from: { email: "a@x.test" },
      to: [{ email: "b@y.test" }],
      subject: "S",
      text: "see attached",
      attachments: [{ filename: "return-label.pdf", mimeType: "application/pdf", content }],
    })
    expect(mime).toContain("multipart/mixed")
    expect(mime).toContain('Content-Disposition: attachment; filename="return-label.pdf"')
    expect(mime).toContain("Content-Transfer-Encoding: base64")
    expect(mime).toContain(content)
  })

  it("round-trips an attachment through mailparser", async () => {
    const content = Buffer.from("hello-bytes").toString("base64")
    const mime = toRfc2822({
      from: { email: "a@x.test" },
      to: [{ email: "b@y.test" }],
      subject: "S",
      text: "body",
      attachments: [{ filename: "doc.txt", mimeType: "text/plain", content }],
    })
    const parsed = await simpleParser(mime)
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0].filename).toBe("doc.txt")
    expect(parsed.attachments[0].content.toString()).toBe("hello-bytes")
  })

  it("produces no multipart/mixed when attachments is empty", () => {
    const mime = toRfc2822({
      from: { email: "a@x.test" },
      to: [{ email: "b@y.test" }],
      subject: "S",
      text: "hi",
      attachments: [],
    })
    expect(mime).not.toContain("multipart/mixed")
  })
})

describe("parseRfc2822", () => {
  it("normalizes a Gmail-style blob into ParsedEmail shape", async () => {
    const blob =
      "From: a@x.test\r\nTo: b@y.test\r\nSubject: Hi\r\nMessage-ID: <m1@x.test>\r\n\r\nbody"
    const p = await parseRfc2822(blob)
    expect(p.messageId).toBe("<m1@x.test>")
    expect(p.from).toEqual({ email: "a@x.test", name: undefined })
    expect(p.to?.[0].email).toBe("b@y.test")
    expect(p.textBody?.trim()).toBe("body")
  })

  it("handles missing optional fields", async () => {
    const blob = "From: a@x.test\r\nSubject: empty\r\n\r\n"
    const p = await parseRfc2822(blob)
    expect(p.subject).toBe("empty")
    expect(p.cc).toBeUndefined()
  })

  it("extracts inbound attachments into ParsedEmail.attachments", async () => {
    const content = Buffer.from("attachment-bytes").toString("base64")
    const mime = toRfc2822({
      from: { email: "a@x.test" },
      to: [{ email: "b@y.test" }],
      subject: "With attachment",
      text: "see attached",
      attachments: [{ filename: "report.pdf", mimeType: "application/pdf", content }],
    })
    const p = await parseRfc2822(mime)
    expect(p.attachments).toHaveLength(1)
    expect(p.attachments?.[0].filename).toBe("report.pdf")
    expect(p.attachments?.[0].mimeType).toContain("application/pdf")
    expect(p.attachments?.[0].disposition).toBe("attachment")
    expect(Buffer.from(p.attachments?.[0].bytesBase64 ?? "", "base64").toString()).toBe(
      "attachment-bytes",
    )
  })
})
