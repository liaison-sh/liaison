// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression for appendSourceCitation (competitive-teardown-task-with-source-citations). The weak
// agent fanned web research into one task per comparison axis and built every body correctly, but
// reliably DROPPED the source-URL citation on the 3rd/4th task of the fan-out (price + expression cited,
// connectivity + software not) — failing the rubric's "each task with a Tideboard data point (cited
// URL)" clause across a 3× gate. The fix makes citation a discrete, enforceable `sourceUrl` input
// on the `create` task tool: the host appends a `Source: <url> (web-sourced — verify)` line to the
// stored body so the URL ALWAYS lands in the workspace, idempotently. This pure helper is that host
// step — tested fails-without (no URL → no citation possible) / passes-with (URL → citation present).

import { describe, expect, it } from "bun:test"
import { appendSourceCitation } from "~/apps/projects/service/tasks"

describe("appendSourceCitation", () => {
  it("appends a Source citation line to a non-empty body when a sourceUrl is given", () => {
    const out = appendSourceCitation(
      "Tideboard CREST 2 is 1,399 EUR vs our Kestrel 6 at 699 EUR.",
      "https://corvane.example/products/tideboard-crest-2",
    )
    expect(out).toContain("Tideboard CREST 2 is 1,399 EUR")
    expect(out).toContain("Source: https://corvane.example/products/tideboard-crest-2")
    expect(out).toContain("web-sourced")
  })

  it("returns just the citation when the body is empty/blank", () => {
    expect(appendSourceCitation("", "https://corvane.example/x")).toBe(
      "Source: https://corvane.example/x (web-sourced — verify)",
    )
    expect(appendSourceCitation(null, "https://corvane.example/x")).toBe(
      "Source: https://corvane.example/x (web-sourced — verify)",
    )
  })

  it("is idempotent — does NOT append a duplicate when the URL is already inlined in the body", () => {
    const body = "Spec from https://corvane.example/products/tideboard-crest-2 — 5D touch surface."
    const out = appendSourceCitation(body, "https://corvane.example/products/tideboard-crest-2")
    // No second occurrence of the URL: the agent already cited it inline.
    expect(out).toBe(body)
    const occurrences = (String(out).match(/corvane\.example/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it("leaves the body untouched when no sourceUrl is given (purely internal task)", () => {
    expect(appendSourceCitation("Internal follow-up.", null)).toBe("Internal follow-up.")
    expect(appendSourceCitation("Internal follow-up.", "  ")).toBe("Internal follow-up.")
    expect(appendSourceCitation(undefined, undefined)).toBeUndefined()
  })
})
