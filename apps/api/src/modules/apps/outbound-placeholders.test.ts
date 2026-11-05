// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  findOutboundPlaceholders,
  findPlaceholders,
  outboundPlaceholderMessage,
  todayInTimezone,
} from "./outbound-placeholders"

describe("findPlaceholders: unfilled slots are found", () => {
  const positives: Array<[string, string]> = [
    ["…and send it to you by [DATE].", "[DATE]"],
    ["Hi [Name], thanks for writing.", "[Name]"],
    ["Hello [Customer Name],", "[Customer Name]"],
    ["Hi [customer's first name],", "[customer's first name]"],
    ["Delivery on [INSERT DATE].", "[INSERT DATE]"],
    ["Please see [Insert link here].", "[Insert link here]"],
    ["Best, [Your Name]", "[Your Name]"],
    ["The ETA is [TBD].", "[TBD]"],
    ["Hi {{firstName}}, your order {{ orderName }} shipped.", "{{firstName}}"],
    ["Hi {first_name},", "{first_name}"],
    ["We will deliver on <insert date>.", "<insert date>"],
    ["We will deliver on <DATE>.", "<DATE>"],
    ["Signed, <SENDER NAME>", "<SENDER NAME>"],
    ["Your appointment is on XX/XX at 10am.", "XX/XX"],
    ["Paid on XX/XX/XXXX.", "XX/XX/XXXX"],
    ["Date: __/__/____", "__/__/____"],
    ["The total is $XX.XX.", "$XX.XX"],
    ["The total is XX €.", "XX €"],
    ["Shipping date TBD, we will confirm.", "TBD"],
    ["Release date: TBC", "TBC"],
  ]
  for (const [text, token] of positives) {
    test(JSON.stringify(text), () => {
      expect(findPlaceholders(text)).toContain(token)
    })
  }

  test("an HTML body: a bracket slot inside a paragraph", () => {
    expect(findPlaceholders("<p>We ship by [DATE].</p>", { html: true })).toEqual(["[DATE]"])
  })
  test("an HTML body: an escaped angle slot", () => {
    expect(findPlaceholders("<p>On &lt;insert date&gt; we ship.</p>", { html: true })).toEqual([
      "<insert date>",
    ])
  })
  test("an HTML body: an ALL-CAPS angled word that is no HTML element", () => {
    expect(findPlaceholders("<p>We ship on <DATE>.</p>", { html: true })).toEqual(["<DATE>"])
  })
})

describe("findPlaceholders: legitimate text passes", () => {
  const negatives: string[] = [
    "We will send it to you by Friday, October 30.",
    "See [our returns page](https://example.com/returns) for details.",
    "![logo](https://example.com/logo.png)",
    "See [the guide][guide].\n\n[guide]: https://example.com/guide",
    "As noted in the study [1], and again [^2], the results hold.",
    "> On Monday the customer wrote: please reply by [DATE] with [Name]\n\nThanks, we will reply by Friday.",
    "Run `curl -d '{name}' https://x` to test.",
    "```\nconst msg = `Hi {{name}} by [DATE]`\n```\nThat is the template we use.",
    "Your ticket [#4521] is resolved.",
    "Order [A-1234] shipped.",
    "[URGENT] has been removed from the subject.",
    "Re: [EXTERNAL] Question about your invoice",
    "The 20th century (XX century) saw many changes.",
    "Use the format DD/MM/YYYY when filling the form.",
    "Thanks for your patience!",
    "Price: €49.00, delivery in 3 days.",
    "Stand by. The TBDX flag is unrelated.",
    "A set like { a, b } is not a slot.",
  ]
  for (const text of negatives) {
    test(JSON.stringify(text), () => {
      expect(findPlaceholders(text)).toEqual([])
    })
  }

  test("an HTML body: quoted thread, code and ordinary tags are skipped", () => {
    const html =
      "<p>Hello Ana,</p><p>Your parcel ships on <strong>October 30</strong>.</p>" +
      "<pre>{{debug}}</pre><code>[DATE]</code>" +
      "<blockquote>Can you tell me by [DATE]? — [Name]</blockquote>" +
      '<div class="gmail_quote">On Mon, [Name] wrote: [DATE]</div>'
    expect(findPlaceholders(html, { html: true })).toEqual([])
  })
  test("an HTML body: <time> and <address> are elements, not slots", () => {
    expect(
      findPlaceholders("<p>Open <TIME>9am</TIME> at <ADDRESS>1 Main St</ADDRESS></p>", {
        html: true,
      }),
    ).toEqual([])
  })
  test("empty and non-string input", () => {
    expect(findPlaceholders("")).toEqual([])
    expect(findPlaceholders(undefined as unknown as string)).toEqual([])
  })
})

describe("findOutboundPlaceholders", () => {
  test("reads only the declared params, html params in HTML mode", () => {
    const hits = findOutboundPlaceholders(
      {
        textBody: "by [DATE]",
        htmlBody: "<p>Hi [Name]</p>",
        subject: "Your order",
        internalNote: "[TBD]",
      },
      ["subject", "textBody", "htmlBody"],
    )
    expect(hits).toEqual([
      { param: "textBody", placeholders: ["[DATE]"] },
      { param: "htmlBody", placeholders: ["[Name]"] },
    ])
  })
  test("no declaration, no judgement", () => {
    expect(findOutboundPlaceholders({ textBody: "[DATE]" }, undefined)).toEqual([])
    expect(findOutboundPlaceholders(null, ["textBody"])).toEqual([])
  })
})

describe("the refusal message", () => {
  test("names the placeholder and today's date in the person's timezone", () => {
    const today = todayInTimezone("Europe/Paris", new Date("2026-10-26T23:30:00Z"))
    expect(today).toBe("Tuesday, October 27, 2026 (Europe/Paris)")
    const msg = outboundPlaceholderMessage([{ param: "textBody", placeholders: ["[DATE]"] }], today)
    expect(msg).toContain("Your draft contains a placeholder ([DATE])")
    expect(msg).toContain("today is Tuesday, October 27, 2026 (Europe/Paris)")
    expect(msg).toContain("propose a realistic date (the approver can edit it)")
    expect(msg).toContain("say plainly in the message that you will confirm it")
  })
  test("an unknown timezone falls back to UTC", () => {
    expect(todayInTimezone("Not/AZone", new Date("2026-10-26T12:00:00Z"))).toBe(
      "Monday, October 26, 2026 (UTC)",
    )
  })
})
