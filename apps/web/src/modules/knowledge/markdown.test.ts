// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { renderMarkdown } from "~/modules/knowledge/markdown"

// The walk's "Conventions — Facturation mensuelle": a source hard-wrapped at
// ~80 columns rendered one <br> per wrap, so sentences broke mid-line.
const HARD_WRAPPED = [
  "Ce document est la **source unique** de « qui facturer ce mois-ci » (scénario",
  "steph#6). Il remplace les deux feuilles Drive héritées.",
  "",
  "Second paragraphe,",
  "sur deux lignes.",
  "",
  "1. Une ligne du tableau = un hub facturable. Pas de ligne, pas de facture,",
  "   le hub apparaît en SKIPPED-NO-ENTRY.",
  "2. Montant en centimes.",
  "",
  "```",
  "ligne un",
  "ligne deux",
  "```",
  "",
  "Adresse :  ",
  "12 rue de la Paix",
].join("\n")

describe("renderMarkdown (Knowledge documents)", () => {
  const html = renderMarkdown(HARD_WRAPPED)

  it("soft-wraps a hard-wrapped paragraph instead of breaking the sentence", () => {
    expect(html).toContain("(scénario\nsteph#6)")
    expect(html).not.toMatch(/\(scénario<br\s*\/?>/)
  })

  it("keeps blank-line paragraphs as separate paragraphs", () => {
    expect(html.match(/<p>/g)?.length).toBeGreaterThanOrEqual(3)
    expect(html).toContain("<p>Second paragraphe,\nsur deux lignes.</p>")
  })

  it("keeps list items, their continuation lines joined", () => {
    expect(html.match(/<li>/g)?.length).toBe(2)
    expect(html).not.toMatch(/facture,<br/)
  })

  it("keeps code blocks line for line", () => {
    expect(html).toContain("ligne un\nligne deux")
    expect(html).toContain("<pre>")
  })

  it("still honours an intentional CommonMark hard break (two trailing spaces)", () => {
    expect(html).toMatch(/Adresse :<br\s*\/?>/)
  })
})

describe("renderMarkdown: the editor's own syntax", () => {
  it("underlines ++text++ but leaves code and C++ alone", () => {
    const out = renderMarkdown("Un ++mot++ en C++.\n\n```\nx ++y++\n```")
    expect(out).toContain("<u>mot</u>")
    expect(out).toContain("en C++.")
    expect(out).toContain("x ++y++")
    expect(out.match(/<u>/g)).toHaveLength(1)
  })
})

describe("renderMarkdown: tables", () => {
  it("gives a table its own scroll box, so a wide one never widens the page", () => {
    const html = renderMarkdown("| Hub | Inscrits |\n|---|---:|\n| Cribbs Causeway | 139 |")
    const doc = new DOMParser().parseFromString(html, "text/html")
    const table = doc.querySelector("table")
    expect(table?.parentElement?.classList.contains("md-table-wrap")).toBe(true)
    expect(table?.parentElement?.style.overflowX).toBe("auto")
  })
})
