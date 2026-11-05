// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S13: the server checks a quote's excerpt against the message's STORED text,
// which is markdown with mention tokens, while the reader selects the RENDERED
// text. The excerpt sent is the selection mapped back onto the stored text.

import { describe, expect, it } from "vitest"
import { excerptForQuote, plainQuoteText } from "~/modules/threads/quote-excerpt"

describe("excerptForQuote", () => {
  it("maps a selection across emphasis back onto the markdown, markers included", () => {
    expect(excerptForQuote("brave world", "Hello **brave** world")).toBe("**brave** world")
    expect(excerptForQuote("Hello brave", "Hello **brave** world")).toBe("Hello **brave**")
  })

  it("maps a rendered mention back onto its token", () => {
    expect(excerptForQuote("@Alice can you", "Hi @[Alice](user:u-1) can you look?")).toBe(
      "@[Alice](user:u-1) can you",
    )
  })

  it("maps a rendered link back onto its markdown", () => {
    expect(excerptForQuote("the docs here", "See the [docs](https://x.test/d) here.")).toBe(
      "the [docs](https://x.test/d) here",
    )
  })

  it("collapses whitespace the way the server does", () => {
    expect(excerptForQuote("line one\n\nline   two", "line one\n\nline two")).toBe(
      "line one line two",
    )
  })

  it("keeps the selection when it cannot be mapped", () => {
    expect(excerptForQuote("not there", "Something else")).toBe("not there")
  })

  it("cuts an excerpt longer than 500 characters with an ellipsis", () => {
    const long = "a".repeat(800)
    const out = excerptForQuote(long, long)
    expect(out.length).toBe(500)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("plainQuoteText", () => {
  it("shows an excerpt without its markdown", () => {
    expect(plainQuoteText("**shared** drive, see @[Bob](user:u-2)")).toBe("shared drive, see @Bob")
  })
})
