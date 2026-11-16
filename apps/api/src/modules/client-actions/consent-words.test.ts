// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a signer types against what was asked: the typed name matches the name given at the
// code step after trim, lower case and space collapse; a required phrase also folds accents,
// so a phone keyboard that drops them still passes.
import { describe, expect, it } from "bun:test"
import { phraseMatches, sameName } from "./decide"

describe("the words a signer types", () => {
  it("a name matches after trim, lower case and space collapse, never across accents", () => {
    expect(sameName("  Léa   ROUX ", "léa roux")).toBe(true)
    expect(sameName("Lea Roux", "Léa Roux")).toBe(false)
    expect(sameName("Léa Rou", "Léa Roux")).toBe(false)
  })

  it("a required phrase matches after trim, case, space collapse and accent folding", () => {
    expect(phraseMatches("  lu et APPROUVE ", "Lu et approuvé")).toBe(true)
    expect(phraseMatches("bon pour accord", "Bon  pour  accord")).toBe(true)
    expect(phraseMatches("lu et approuve", "Lu et approuvé, bon pour accord")).toBe(false)
    expect(phraseMatches("", "Lu et approuvé")).toBe(false)
  })
})
