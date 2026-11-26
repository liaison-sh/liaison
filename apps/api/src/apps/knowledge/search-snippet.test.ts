// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readableText, snippetOf } from "./search-snippet"

const ID = "0b9f0e7c-2d0f-4c1e-9a55-3d6c1c5e8a10"

describe("search snippets", () => {
  it("shows the page's text as read: no markdown, no file or page tokens", () => {
    expect(
      readableText(
        `# Returns\n\n> [!NOTE]\n> Ask **first**.\n\n- [ ] Pack\n\n![](liaison-file:${ID})\n\nSee [the policy](https://x.example).`,
      ),
    ).toBe("Returns Ask first. Pack See the policy.")
  })

  it("cuts around the first word of the query found, accents and case aside", () => {
    const body = `${"Intro words here. ".repeat(20)}The refund window is thirty days for every order.${" More text.".repeat(30)}`
    const s = snippetOf(body, "REFUND")!
    expect(s.startsWith("… ")).toBe(true)
    expect(s.endsWith(" …")).toBe(true)
    expect(s).toContain("The refund window is thirty days")
    expect(s.length).toBeLessThan(200)
    expect(snippetOf("Délai de remboursement", "delai")).toBe("Délai de remboursement")
  })

  it("starts at the opening when only the title matched, and says nothing for an empty page", () => {
    expect(snippetOf("Short body", "title-only")).toBe("Short body")
    expect(snippetOf("", "x")).toBeUndefined()
  })
})
