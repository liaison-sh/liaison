// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins the quoted-history stripper: agent reads of ticket/mail bodies drop the
// re-quoted conversation tail (the dominant token cost of thread reads) while
// plain prose, inline single-line quotes, and marker-less bodies pass through
// untouched. Shapes mirror real prod messages (EN/FR/DE clients, Outlook,
// quote pyramids).
import { describe, expect, it } from "bun:test"
import { stripQuotedHistory, stripQuotedHtml } from "~/lib/email/strip-quoted"

const REPLY = "Thanks, the new unit arrived and works great!"

describe("stripQuotedHistory", () => {
  it("cuts at an EN gmail attribution line", () => {
    const body = `${REPLY}\n\nOn Mon, 20 Jul 2026 at 11:40, Fabrikam Support <support@fabrikam.example> wrote:\n> Hello Ivan,\n> Thank you for the video.\n> We do apologise for this.`
    const out = stripQuotedHistory(body)
    expect(out.text).toContain(REPLY)
    expect(out.text).not.toContain("Thank you for the video")
    expect(out.text).toContain("[quoted history trimmed:")
    expect(out.trimmedChars).toBeGreaterThan(50)
  })

  it("cuts at a FR attribution line", () => {
    const body = `Merci beaucoup !\n\nLe 20 juil. 2026 à 11:40, Fabrikam <support@fabrikam.example> a écrit :\n> Bonjour,\n> Voici la marche à suivre.\n> Cordialement.`
    const out = stripQuotedHistory(body)
    expect(out.text).toContain("Merci beaucoup !")
    expect(out.text).not.toContain("marche à suivre")
  })

  it("cuts at a DE attribution line", () => {
    const body = `Alles klar, danke!\n\nAm 20.07.2026 um 11:40 schrieb Fabrikam Support <support@fabrikam.example>:\n> Hallo Ivan,\n> bitte senden Sie uns ein Video.`
    const out = stripQuotedHistory(body)
    expect(out.text).toContain("Alles klar, danke!")
    expect(out.text).not.toContain("senden Sie uns ein Video")
  })

  it("cuts at an Outlook From:/Sent: header block", () => {
    const body = `${REPLY}\n\nFrom: Fabrikam Support <support@fabrikam.example>\nSent: Monday, July 20, 2026 11:40 AM\nTo: ivan@web.de\nSubject: RE: About my Order #1846\n\nHello Ivan, earlier reply text here.`
    const out = stripQuotedHistory(body)
    expect(out.text).toContain(REPLY)
    expect(out.text).not.toContain("earlier reply text")
  })

  it("cuts a trailing '>' pyramid even without an attribution line", () => {
    const body = `${REPLY}\n\n> Hello Ivan,\n> Thank you for the video.\n> We do apologise for this,\n> best regards`
    const out = stripQuotedHistory(body)
    expect(out.text).toContain(REPLY)
    expect(out.text).not.toContain("apologise")
  })

  it("keeps a short inline quote the customer is answering (under 3 quoted lines)", () => {
    const body = `> Did you try another cable?\nYes, I tried three different cables, same result.`
    const out = stripQuotedHistory(body)
    expect(out.trimmedChars).toBe(0)
    expect(out.text).toBe(body)
  })

  it("passes marker-less prose through untouched", () => {
    const body =
      "Hello,\nmy Tessera 2 is stuck in a boot loop after the firmware update.\nI power it On and it restarts forever. What can I do?"
    expect(stripQuotedHistory(body)).toEqual({ text: body, trimmedChars: 0 })
  })

  it("does not treat body prose containing 'wrote:' mid-line as a marker", () => {
    const body = "As the manual wrote: hold RETURN while powering on. It did not help though."
    expect(stripQuotedHistory(body).trimmedChars).toBe(0)
  })

  it("keeps a bounded head when the whole body is a LONG quoted chain", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `> quoted line ${i} with some padding text`)
    const body = `On Mon, 20 Jul 2026 at 11:40, Support <s@e.com> wrote:\n${lines.join("\n")}`
    const out = stripQuotedHistory(body)
    expect(out.text.length).toBeGreaterThan(0)
    expect(out.text.length).toBeLessThan(600)
    expect(out.text).toContain("[quoted history trimmed:")
  })

  it("a short whole-quote body passes through unchanged (nothing worth saving)", () => {
    const body = `On Mon, 20 Jul 2026 at 11:40, Support <s@e.com> wrote:\n> line one\n> line two\n> line three`
    expect(stripQuotedHistory(body).text).toBe(body)
  })

  it("handles empty input", () => {
    expect(stripQuotedHistory("")).toEqual({ text: "", trimmedChars: 0 })
  })
})

describe("stripQuotedHtml", () => {
  const longQuote =
    "<div>The entire prior conversation quoted verbatim, long enough to be worth trimming from the payload.</div>"

  it("cuts at a blockquote and appends the marker note", () => {
    const html = `<div>Latest reply.</div><blockquote>${longQuote}</blockquote>`
    const out = stripQuotedHtml(html)
    expect(out.trimmedChars).toBeGreaterThan(0)
    expect(out.html).toContain("Latest reply.")
    expect(out.html).not.toContain("prior conversation")
    expect(out.html).toContain("[quoted history trimmed:")
  })

  it("cuts at a client quote-container class (gmail_quote)", () => {
    const html = `<div dir="ltr">Thanks, fixed!</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Jan 5, 2026, Support wrote:</div><blockquote>${longQuote}</blockquote></div>`
    const out = stripQuotedHtml(html)
    expect(out.trimmedChars).toBeGreaterThan(0)
    expect(out.html).toContain("Thanks, fixed!")
    expect(out.html).not.toContain("wrote:")
    expect(out.html).toContain("[quoted history trimmed:")
  })

  it("passes a quote-free body through untouched", () => {
    const html = "<div>Just a reply with no quoted history at all.</div>"
    expect(stripQuotedHtml(html)).toEqual({ html, trimmedChars: 0 })
  })

  it("does not trim a trivially short tail", () => {
    const html = "<div>My reply.</div><blockquote>ok</blockquote>"
    expect(stripQuotedHtml(html).trimmedChars).toBe(0)
  })

  it("never hides the whole message (quote-only body passes through)", () => {
    const html = `<blockquote>${longQuote}</blockquote>`
    expect(stripQuotedHtml(html).trimmedChars).toBe(0)
  })

  it("handles empty input", () => {
    expect(stripQuotedHtml("")).toEqual({ html: "", trimmedChars: 0 })
  })
})
