// SPDX-License-Identifier: FSL-1.1-ALv2
// Quoted-history splitting on the real mail shapes that used to stay unfolded:
// a Foxmail reply wrapped in leading cite blockquotes, Outlook header blocks
// (desktop and web), localized header labels, dividers. Ticket bodies and
// non-sealed mail bodies reach the browser through the server sanitizer
// (class, id, type and style stripped, <style> dropped), so every shape runs
// twice: raw, as a sealed mailbox renders it, and sanitized, as tickets do.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { htmlToText } from "@liaison/shared"
import { describe, expect, it, vi } from "vitest"
import { sanitizeCustomerHtml } from "../../../api/src/lib/email/sanitize"
import {
  createQuoteCache,
  linkQuotedEntries,
  parseQuotedEntries,
  splitQuotedHtml,
} from "./email-quote"

const FOXMAIL = readFileSync(
  join(import.meta.dirname, "__fixtures__/foxmail-nested-thread.html"),
  "utf8",
)

const text = (html: string) => htmlToText(html, { singleLine: true })

// Outlook desktop (Word HTML): the reply, its signature, then a top-level
// wrapper holding the border-top From/Sent/To/Cc/Subject block. The quoted
// email follows as plain sibling paragraphs (no blockquote); Gmail-style
// blockquotes only appear deeper down.
const OUTLOOK_DESKTOP = `<html><head><style>p.MsoNormal { margin: 0cm; }</style></head><body lang="EN-CA" link="blue" style="word-wrap:break-word"><div class="WordSection1">
<p class="MsoNormal"><span style="font-size:11.0pt">Hi Marc,<o:p></o:p></span></p>
<p class="MsoNormal"><span style="font-size:11.0pt">Thanks for the update. The revised drawings are attached and the crane is booked for Thursday morning.<o:p></o:p></span></p>
<p class="MsoNormal"><span style="font-size:11.0pt">Best regards,<o:p></o:p></span></p>
<p class="MsoNormal"><b><span style="font-size:11.0pt;color:#6D6C70">Julie Tremblay | Project Manager</span></b><o:p></o:p></p>
<div>
<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">
<p class="MsoNormal"><b><span lang="EN-US" style="font-size:11.0pt">From:</span></b><span lang="EN-US" style="font-size:11.0pt"> Marc Dubois &lt;marc@example.com&gt;<br>
<b>Sent:</b> Monday, November 2, 2026 9:14 AM<br>
<b>To:</b> Julie Tremblay &lt;julie@example.org&gt;<br>
<b>Cc:</b> Site Office &lt;office@example.org&gt;<br>
<b>Subject:</b> RE: Site visit<o:p></o:p></span></p>
</div>
</div>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<p class="MsoNormal"><span lang="EN-GB">Hello Julie,<o:p></o:p></span></p>
<p class="MsoNormal"><span lang="EN-GB">Could you send the revised drawings before Thursday? The inspector wants them on site.<o:p></o:p></span></p>
<p class="MsoNormal"><b><span lang="EN-GB" style="color:#6D6C70">Marc Dubois | Operations</span></b><o:p></o:p></p>
<p class="MsoNormal"><span lang="EN-GB" style="font-size:7.5pt">CONFIDENTIALITY NOTICE: this message and its attachments are intended only for the addressee.<o:p></o:p></span></p>
<div class="gmail_quote"><div class="gmail_attr">On Fri, Oct 30, 2026 at 4:02 PM Julie Tremblay &lt;julie@example.org&gt; wrote:</div><blockquote class="gmail_quote"><div>Here is the first draft of the site visit plan for next week.</div></blockquote></div>
</div></body></html>`

const MODES: Array<[string, (html: string) => string]> = [
  ["raw", (html) => html],
  ["sanitized", sanitizeCustomerHtml],
]

describe.each(MODES)("splitQuotedHtml (%s)", (_mode, prep) => {
  const split = (html: string) => splitQuotedHtml(prep(html))

  it("folds a Foxmail reply wrapped in leading cite blockquotes at the body-level header blockquote", () => {
    const { visibleHtml, quotedHtml } = split(FOXMAIL)
    expect(text(visibleHtml)).toContain("production of the stands starts on Monday")
    expect(text(visibleHtml)).toContain("sales@clearform-acrylic.example")
    expect(text(visibleHtml)).not.toContain("The deposit went out this morning")
    expect(text(quotedHtml)).toContain("From:")
    expect(text(quotedHtml)).toContain("The deposit went out this morning")
    expect(text(quotedHtml)).toContain("countertop stands with an engraved logo")
  })

  it("folds an Outlook desktop reply at the first header block, not the deeper blockquote", () => {
    const { visibleHtml, quotedHtml } = split(OUTLOOK_DESKTOP)
    expect(text(visibleHtml)).toContain("the crane is booked for Thursday morning")
    expect(text(visibleHtml)).toContain("Julie Tremblay | Project Manager")
    expect(text(visibleHtml)).not.toContain("Could you send the revised drawings")
    expect(text(visibleHtml)).not.toContain("CONFIDENTIALITY NOTICE")
    expect(text(quotedHtml)).toMatch(/^From: Marc Dubois/)
    expect(text(quotedHtml)).toContain("first draft of the site visit plan")
  })

  it("folds an Outlook web reply (appendonsend marker, hr, divRplyFwdMsg header), hr included", () => {
    const html = `<div>Sounds good, see you on Monday at the warehouse.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri" color="#000000"><b>From:</b> Sam Lee &lt;sam@example.com&gt;<br><b>Sent:</b> Tuesday, November 3, 2026 10:02<br><b>To:</b> Ops &lt;ops@example.org&gt;<br><b>Subject:</b> Meeting</font><div>&nbsp;</div></div><div>Can we meet on Monday to go through the inventory count together?</div>`
    const { visibleHtml, quotedHtml } = split(html)
    expect(text(visibleHtml)).toBe("Sounds good, see you on Monday at the warehouse.")
    expect(visibleHtml).not.toContain("<hr")
    expect(quotedHtml).toContain("<hr")
    expect(text(quotedHtml)).toContain("go through the inventory count")
  })

  it("folds a French Outlook header (De : / Envoyé : with a no-break space before the colon)", () => {
    const html = `<p>Merci, c'est noté pour la livraison de vendredi.</p><hr><div><b>De&nbsp;:</b> Claire Petit &lt;claire@example.fr&gt;<br><b>Envoyé&nbsp;:</b> lundi 2 novembre 2026 09:30<br><b>À&nbsp;:</b> Équipe<br><b>Objet&nbsp;:</b> Livraison</div><p>Bonjour, pouvez-vous confirmer la livraison de vendredi matin ?</p>`
    const { visibleHtml, quotedHtml } = split(html)
    expect(text(visibleHtml)).toBe("Merci, c'est noté pour la livraison de vendredi.")
    expect(text(quotedHtml)).toContain("pouvez-vous confirmer")
  })

  it("folds a Chinese header block (发件人： / 发送时间：)", () => {
    const html = `<div>Received, the crates leave the workshop tomorrow.</div><div><div><b>发件人：</b>&nbsp;Omar Haddad</div><div><b>发送时间：</b>&nbsp;2026-06-18&nbsp;14:30</div><div><b>收件人：</b>&nbsp;Nadia</div></div><div>Hello Nadia, could the crates leave the workshop before the weekend?</div>`
    const { visibleHtml, quotedHtml } = split(html)
    expect(text(visibleHtml)).toBe("Received, the crates leave the workshop tomorrow.")
    expect(text(quotedHtml)).toContain("could the crates leave the workshop")
  })

  it("folds at an -----Original Message----- divider", () => {
    const html = `<div>Approved, go ahead with the order.</div><div>-----Original Message-----</div><div>From: Buyer &lt;buyer@example.com&gt;</div><div>Sent: Monday, November 2, 2026</div><div>Please approve the attached purchase order for the new chairs.</div>`
    const { visibleHtml, quotedHtml } = split(html)
    expect(text(visibleHtml)).toBe("Approved, go ahead with the order.")
    expect(text(quotedHtml)).toContain("-----Original Message-----")
    expect(text(quotedHtml)).toContain("purchase order")
  })

  it("does not take a From/Date line inside the reply's own text for a boundary", () => {
    const long = "We looked at the logs again. ".repeat(25)
    const html = `<div>Hi there,</div><div>From: the very start of the project we agreed on weekly calls. ${long} Date: still to be decided.</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("keeps an inline reply whole (answers between the quotes)", () => {
    const html = `<div>See my answers below.</div><blockquote><div>Can you deliver 200 units by Friday?</div></blockquote><div>Yes, we can deliver them on Thursday.</div><blockquote><div>And can you include the mounting brackets as well?</div></blockquote><div>No, those ship separately.</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("keeps a short bottom-posted answer visible (no fold)", () => {
    const html = `<div>Hello team,</div><blockquote><div>Should we move the review meeting to Wednesday afternoon?</div></blockquote><div>Yes.</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("folds when only a signature sits below the quote", () => {
    const html = `<div>Thanks, the new date works for us.</div><div>On Mon, Nov 2, 2026 at 9:14 AM Sam Lee &lt;sam@example.com&gt; wrote:</div><blockquote><div>Can we move the delivery to the 12th instead of the 9th?</div></blockquote><div>-- <br>Ada Moreau<br>12 Rue des Lilas, Lyon</div>`
    const s = split(html)
    expect(text(s.visibleHtml)).toBe("Thanks, the new date works for us.")
    expect(text(s.quotedHtml)).toContain("Ada Moreau")
  })

  it("folds when only a ticket reference footer sits below the quote", () => {
    const html = `<div>Great, I will try the firmware update tonight.</div><blockquote><div>Please install version 2.4 and restart the unit before testing again.</div></blockquote><div>Support team<br>Ticket reference: [#ticket-4821]</div>`
    const s = split(html)
    expect(text(s.visibleHtml)).toBe("Great, I will try the firmware update tonight.")
    expect(text(s.quotedHtml)).toContain("[#ticket-4821]")
  })

  it("keeps a contact-form notification whole (From and Date labels but no To/Cc/Subject)", () => {
    const html = `<p>New enquiry from the website:</p><div>From: Jane Roe<br>Date: 4 Nov<br>Message: My order arrived broken, refund please</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("keeps a reply that cites a ticket reference in a sentence below the quote", () => {
    const html = `<div>Hello,</div><blockquote><div>Could you refund the cracked display stand from my last order, please?</div></blockquote><div>Done, refunded under [#4521]</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("keeps a long PS written after the signature below the quote", () => {
    const html = `<div>Thanks, the new date works for us.</div><div>On Mon, Nov 2, 2026 at 9:14 AM Sam Lee &lt;sam@example.com&gt; wrote:</div><blockquote><div>Can we move the delivery to the 12th instead of the 9th?</div></blockquote><div>-- <br>Ada Moreau<br>PS: the second pallet also arrived with a cracked corner, could you add a replacement panel to the next delivery?</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("does not take a closing sentence ending in 'wrote' (no colon) for an attribution", () => {
    const html = `<p>Thanks for the notes from the meeting.</p><p>On the call yesterday, this is exactly what John wrote</p>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("keeps a bottom-posted answer visible even when a signature follows it", () => {
    const html = `<div>Hello,</div><blockquote><div>Which layout were you using when the pads stopped responding?</div></blockquote><div>The drum layout, right after calibrating.</div><div>-- <br>Ada Moreau</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("keeps a leading-quote inline reply whole", () => {
    const html = `<blockquote><div>First question about the delivery window for next week?</div></blockquote><div>Monday works.</div><blockquote><div>Second question about the invoice address for this order?</div></blockquote><div>Same as last time.</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("does not split an Outlook forward with no comment", () => {
    const html = `<div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Sam Lee &lt;sam@example.com&gt;<br><b>Sent:</b> Tuesday, November 3, 2026 10:02<br><b>Subject:</b> Report</div><div>Here is the monthly report with all the figures for October.</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("does not split a reply hidden in leading cite blockquotes when no later boundary exists", () => {
    const html = `<blockquote type="cite"><div>Thanks, the parcel arrived this morning in perfect condition.</div></blockquote><div>Best wishes</div>`
    expect(split(html).quotedHtml).toBe("")
  })

  it("still splits a Gmail quote and a bare blockquote after the reply", () => {
    const gmail = `<div dir="ltr">Thanks, that fixed it!</div><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Jan 5, 2026 at 9:00 AM Support &lt;support@acme.test&gt; wrote:</div><blockquote class="gmail_quote"><div>Please try reinstalling and let us know if the problem persists.</div></blockquote></div>`
    const g = split(gmail)
    expect(text(g.visibleHtml)).toBe("Thanks, that fixed it!")
    expect(text(g.quotedHtml)).toContain("wrote:")
    const bare = `<div>Got it, thank you.</div><blockquote><div>Here is my original question about the device settings.</div></blockquote>`
    const b = split(bare)
    expect(text(b.visibleHtml)).toBe("Got it, thank you.")
    expect(text(b.quotedHtml)).toContain("original question")
  })

  it("does not split a message that is all quote", () => {
    const html = `<blockquote><div>This entire message is just a quoted block of some length here.</div></blockquote>`
    expect(split(html).quotedHtml).toBe("")
  })
})

describe("splitQuotedHtml document mode", () => {
  it("keeps the head styles and the body attributes of the visible part", () => {
    const { visibleHtml, quotedHtml } = splitQuotedHtml(OUTLOOK_DESKTOP, { document: true })
    expect(visibleHtml).toContain("p.MsoNormal { margin: 0cm; }")
    expect(visibleHtml).toMatch(/<body[^>]*style="word-wrap:break-word"/)
    expect(text(visibleHtml)).not.toContain("Could you send the revised drawings")
    expect(text(quotedHtml)).toContain("Could you send the revised drawings")
  })

  it("returns the input unchanged when nothing folds", () => {
    const html = "<html><head></head><body><p>Just a reply.</p></body></html>"
    expect(splitQuotedHtml(html, { document: true })).toEqual({ visibleHtml: html, quotedHtml: "" })
  })
})

describe.each(MODES)("parseQuotedEntries (%s)", (_mode, prep) => {
  it("lists every earlier email of the Foxmail chain with sender, date and first line", () => {
    const { quotedHtml } = splitQuotedHtml(prep(FOXMAIL))
    const entries = parseQuotedEntries(quotedHtml)
    expect(entries.map((e) => e.sender)).toEqual([
      "Hugo Lambert",
      "Mei",
      "Hugo Lambert",
      "Rosa",
      "Hugo Lambert",
      "Daniel Chen",
      "Hugo Lambert",
    ])
    expect(entries[0]).toMatchObject({
      date: "2026-11-03 15:20",
      firstLine: "The deposit went out this morning, the bank reference is in the attachment.",
    })
    expect(entries[1].firstLine).toMatch(/^Attached is the updated pro forma/)
    expect(entries[2].firstLine).toBe(
      "The pro forma matches what we agreed. The deposit will follow before Friday.",
    )
    expect(entries[4].firstLine).toMatch(/^The prototypes look great/)
    expect(entries[5].firstLine).toMatch(/^Please find our offer for 300 countertop stands/)
    // Entry text holds the body, not the header block it was split at.
    expect(entries[0].text).not.toContain("Subject:")
    expect(entries[0].text).not.toContain("Attached is the updated")
  })
})

describe("parseQuotedEntries sender and date", () => {
  const first = (quoted: string) => parseQuotedEntries(quoted, "text")[0]

  it("reads a From header with an address in angle brackets or [mailto:]", () => {
    expect(first("From: Ana Silva <ana@example.com>\nSent: Monday\n\nThe body text.").sender).toBe(
      "Ana Silva",
    )
    expect(
      first("From: Ana Silva [mailto:ana@example.com]\nSent: Monday\n\nThe body text.").sender,
    ).toBe("Ana Silva")
  })

  it("reads a Gmail English attribution", () => {
    const e = first(
      "On Tue, Jul 21, 2026 at 4:05 AM Jo Park <jo@example.com> wrote:\n> Body line here.",
    )
    expect(e.sender).toBe("Jo Park")
    expect(e.date.length).toBeLessThanOrEqual(24)
    expect(e.date).toMatch(/^Tue, Jul 21, 2026/)
    expect(e.firstLine).toBe("Body line here.")
  })

  it("reads a French attribution", () => {
    const e = first(
      "Le mer. 15 janv. 2025 à 08:17, Jean Roy <jean@example.fr> a écrit :\nTexte du message.",
    )
    expect(e.sender).toBe("Jean Roy")
    expect(e.date).toMatch(/^mer\. 15 janv\. 2025/)
  })

  it("reads a Chinese header", () => {
    expect(first("发件人： Li Wei\n发送时间： 2026-06-18 14:30\n\n正文内容在这里。").sender).toBe(
      "Li Wei",
    )
  })

  it("falls back to the address when no name precedes it", () => {
    expect(first("On Wed, Dec 4, 2024 at 9:07 AM <kim@example.com> wrote:\nHello.").sender).toBe(
      "kim@example.com",
    )
  })

  it("returns no entries for a tail without any attribution or header", () => {
    expect(parseQuotedEntries("<blockquote>Just some quoted words here.</blockquote>")).toEqual([])
  })

  it("caps the list at 60 entries, merging the rest into the last", () => {
    const chain = Array.from(
      { length: 70 },
      (_, i) =>
        `On Mon, Jan 5, 2026 at 9:00 AM Person ${i} <p${i}@example.com> wrote:\nMessage number ${i}.`,
    ).join("\n")
    const entries = parseQuotedEntries(chain, "text")
    expect(entries).toHaveLength(60)
    expect(entries[59].text).toContain("Message number 69.")
  })
})

describe("linkQuotedEntries", () => {
  const entry = (t: string) => ({ sender: "X", date: "", firstLine: t.split("\n")[0], text: t })

  it("links an entry to the thread message that holds its text", () => {
    const entries = [
      entry(
        "Hello Hugo,\nCould you confirm the delivery   address for the prototypes? They leave by courier.",
      ),
    ]
    const messages = [
      { id: "m1", text: "Something else entirely, nothing in common with the quote." },
      {
        id: "m2",
        text: "Dear Hugo,\n\ncould you confirm the delivery address for the prototypes? They leave by courier.",
      },
    ]
    expect(linkQuotedEntries(entries, messages)).toEqual(["m2"])
  })

  it("links a quoted canned reply to the message that holds all of it, not one sharing its opening", () => {
    const opening =
      "Thank you for contacting the support team. We have received your request and looked into your order in detail."
    const entries = [
      entry(`Hello Ana,\n${opening} Your replacement stand ships tomorrow by courier.`),
    ]
    const messages = [
      { id: "m1", text: `Hello Ana,\n${opening} Your refund was issued to the original card.` },
      {
        id: "m2",
        text: `Hello Ana,\n${opening} Your replacement stand ships tomorrow by courier.`,
      },
    ]
    expect(linkQuotedEntries(entries, messages)).toEqual(["m2"])
  })

  it("links to the latest message when several hold the entry's text", () => {
    const body = "Your replacement stand ships tomorrow by courier, tracking follows tonight."
    const entries = [entry(body)]
    const messages = [
      { id: "m1", text: body },
      { id: "m2", text: "Something unrelated in between." },
      { id: "m3", text: `Resending: ${body}` },
    ]
    expect(linkQuotedEntries(entries, messages)).toEqual(["m3"])
  })

  it("returns null when no thread message holds the text", () => {
    const entries = [entry("A message that was never part of this thread at all, honestly.")]
    expect(linkQuotedEntries(entries, [{ id: "m1", text: "Unrelated." }])).toEqual([null])
  })

  it("returns null when the entry text is too short to link safely", () => {
    const entries = [entry("Hi,\nThanks!")]
    expect(linkQuotedEntries(entries, [{ id: "m1", text: "thanks! and more" }])).toEqual([null])
  })
})

describe("createQuoteCache", () => {
  it("computes once per message body and again when the body changes", () => {
    const cache = createQuoteCache<number>(2)
    const compute = vi.fn(() => 1)
    cache.get("a", "body one", compute)
    cache.get("a", "body one", compute)
    expect(compute).toHaveBeenCalledTimes(1)
    cache.get("a", "body two", compute)
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it("evicts the least recently used entry past its limit", () => {
    const cache = createQuoteCache<string>(2)
    const compute = vi.fn((v: string) => v)
    cache.get("a", "x", () => compute("a"))
    cache.get("b", "x", () => compute("b"))
    cache.get("a", "x", () => compute("a"))
    cache.get("c", "x", () => compute("c"))
    cache.get("a", "x", () => compute("a"))
    cache.get("b", "x", () => compute("b"))
    expect(compute.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c", "b"])
  })
})
