// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { buildDictationCleanupPrompt, buildProofreadSystemPrompt } from "./proofread-prompt"

describe("buildProofreadSystemPrompt", () => {
  it("instructs plain correction with no meaning change for text format", () => {
    const p = buildProofreadSystemPrompt({ format: "text", instructions: null })
    expect(p).toMatch(/spelling/i)
    expect(p).toMatch(/grammar/i)
    expect(p).toMatch(/do not (change|alter).*(meaning)/i)
    expect(p).not.toMatch(/HTML/i)
  })

  it("adds HTML-preservation rules for html format", () => {
    const p = buildProofreadSystemPrompt({ format: "html", instructions: null })
    expect(p).toMatch(/HTML/)
    expect(p).toMatch(/preserve.*tag/i)
    expect(p).toMatch(/mention|span/i) // pills must survive
  })

  it("appends the user instruction when present", () => {
    const p = buildProofreadSystemPrompt({
      format: "text",
      instructions: "Use British spelling.",
    })
    expect(p).toContain("Use British spelling.")
  })

  it("omits any guidance block when instruction is null or blank", () => {
    const p = buildProofreadSystemPrompt({ format: "text", instructions: null })
    expect(p).not.toMatch(/Additional (style )?guidance/i)
  })
})

describe("buildDictationCleanupPrompt", () => {
  it("asks for filler removal, language preservation and verbatim facts, plain text out", () => {
    const p = buildDictationCleanupPrompt({ instructions: null })
    expect(p).toMatch(/never translate/i)
    expect(p).toMatch(/euh/)
    expect(p).toMatch(/false starts/i)
    expect(p).toMatch(/names?, numbers?/i)
    expect(p).toMatch(/plain text/i)
    expect(p).not.toMatch(/HTML/)
  })

  it("keeps a self-correction as spoken: both words stay, choosing is not the clean-up's call", () => {
    const p = buildDictationCleanupPrompt({ instructions: null })
    expect(p).toMatch(/corrects? (a|the) word/i)
    expect(p).toMatch(/keep both/i)
  })

  it("names the language when known and appends the user's instructions", () => {
    const p = buildDictationCleanupPrompt({ instructions: "Tutoiement.", language: "fr" })
    expect(p).toContain('"fr"')
    expect(p).toContain("Tutoiement.")
  })
})
