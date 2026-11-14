// SPDX-License-Identifier: FSL-1.1-ALv2
import type { HelpDocsIndex } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import { helpSiteUrl, helpTargetOf, searchHelp } from "./help-docs"

const INDEX: HelpDocsIndex = {
  landing: { url: "", title: "Liaison documentation" },
  sections: [],
  entries: [
    {
      url: "apps/mail",
      title: "Mail",
      section: "Apps",
      description: "Read and answer email.",
      headings: [{ depth: 2, text: "Connect Gmail", id: "connect-gmail" }],
      text: "Mail keeps every mailbox of the organization. Réglages live in Settings.",
    },
    {
      url: "agents/approvals",
      title: "Approvals",
      section: "Agents",
      description: "Approve what agents do.",
      headings: [],
      text: "An approval holds a gated action until a person decides. Gmail drafts wait here too.",
    },
  ],
}

describe("searchHelp", () => {
  it("ranks a heading above a mention in the text, and needs every word", () => {
    const hits = searchHelp(INDEX, "gmail")
    expect(hits.map((h) => [h.entry.url, h.heading?.id ?? null])).toEqual([
      ["apps/mail", "connect-gmail"],
      ["agents/approvals", null],
    ])
    expect(hits[1]?.snippet).toContain("Gmail drafts")
    expect(searchHelp(INDEX, "gmail nowhere")).toEqual([])
  })

  it("matches a title first, case and accents aside", () => {
    expect(searchHelp(INDEX, "APPROVALS")[0]?.entry.url).toBe("agents/approvals")
    expect(searchHelp(INDEX, "reglages")[0]?.entry.url).toBe("apps/mail")
  })

  it("finds nothing for an empty query", () => {
    expect(searchHelp(INDEX, "   ")).toEqual([])
  })
})

describe("links", () => {
  it("reads a docs page link and leaves the rest alone", () => {
    expect(helpTargetOf("/help")).toEqual({ url: "", hash: "" })
    expect(helpTargetOf("/help/apps/mail#connect-gmail")).toEqual({
      url: "apps/mail",
      hash: "connect-gmail",
    })
    expect(helpTargetOf("/helpdesk")).toBeNull()
    expect(helpTargetOf("https://example.com/help/x")).toBeNull()
  })

  it("opens the same page on the published site", () => {
    expect(helpSiteUrl({ url: "apps/mail", hash: "connect-gmail" })).toBe(
      "https://liaison.sh/docs/apps/mail/#connect-gmail",
    )
    expect(helpSiteUrl({ url: "", hash: "" })).toBe("https://liaison.sh/docs/")
  })
})
