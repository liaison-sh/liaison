// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  ambiguousNameKeys,
  disambiguatedLabel,
  foldName,
  markAmbiguousNames,
} from "~/lib/name-collision"

describe("foldName", () => {
  it("lowercases", () => {
    expect(foldName("Dana Reyes")).toBe("dana reyes")
  })

  it("strips accents", () => {
    expect(foldName("Renée Côté")).toBe("renee cote")
  })

  it("treats accent and case variants as equal", () => {
    expect(foldName("RENÉE côté")).toBe(foldName("renee cote"))
  })

  it("trims surrounding whitespace", () => {
    expect(foldName("  Priya Nair  ")).toBe("priya nair")
  })
})

describe("ambiguousNameKeys", () => {
  it("is empty when every name is unique", () => {
    expect(ambiguousNameKeys(["Dana Reyes", "Priya Nair"]).size).toBe(0)
  })

  it("flags a name shared by two candidates", () => {
    const keys = ambiguousNameKeys(["Dana Reyes", "Dana Reyes"])
    expect(keys.has(foldName("Dana Reyes"))).toBe(true)
  })

  it("flags accent/case variants of the same name as one collision", () => {
    const keys = ambiguousNameKeys(["Renée Côté", "renee cote"])
    expect(keys.has(foldName("Renée Côté"))).toBe(true)
    expect(keys.size).toBe(1)
  })

  it("does not flag a name that appears only once, even alongside collisions", () => {
    const keys = ambiguousNameKeys(["Dana Reyes", "Dana Reyes", "Priya Nair"])
    expect(keys.has(foldName("Priya Nair"))).toBe(false)
  })

  it("ignores empty names", () => {
    expect(ambiguousNameKeys(["", "", ""]).size).toBe(0)
  })

  it("flags three-way collisions too", () => {
    const keys = ambiguousNameKeys(["Dana Reyes", "Dana Reyes", "dana reyes"])
    expect(keys.size).toBe(1)
  })
})

describe("markAmbiguousNames", () => {
  interface Person {
    name: string
    email: string
  }

  it("marks only the colliding candidates within the given list", () => {
    const people: Person[] = [
      { name: "Dana Reyes", email: "dana@a.example" },
      { name: "Dana Reyes", email: "dana@b.example" },
      { name: "Priya Nair", email: "priya@a.example" },
    ]
    const marked = markAmbiguousNames(people, (p) => p.name)
    expect(marked.map((m) => m.ambiguous)).toEqual([true, true, false])
  })

  it("marks nobody when every candidate is unique", () => {
    const people: Person[] = [
      { name: "Dana Reyes", email: "dana@a.example" },
      { name: "Priya Nair", email: "priya@a.example" },
    ]
    const marked = markAmbiguousNames(people, (p) => p.name)
    expect(marked.every((m) => !m.ambiguous)).toBe(true)
  })

  it("re-evaluates against the list passed in, not a global scope", () => {
    const onlyDana: Person[] = [{ name: "Dana Reyes", email: "dana@a.example" }]
    const marked = markAmbiguousNames(onlyDana, (p) => p.name)
    expect(marked[0]?.ambiguous).toBe(false)
  })
})

describe("disambiguatedLabel", () => {
  it("returns the plain name when unique", () => {
    expect(disambiguatedLabel("Dana Reyes", "dana@a.example", false)).toBe("Dana Reyes")
  })

  it("appends the email in parentheses when ambiguous", () => {
    expect(disambiguatedLabel("Dana Reyes", "dana@a.example", true)).toBe(
      "Dana Reyes (dana@a.example)",
    )
  })

  it("falls back to the plain name when ambiguous but no email is known", () => {
    expect(disambiguatedLabel("Dana Reyes", null, true)).toBe("Dana Reyes")
    expect(disambiguatedLabel("Dana Reyes", undefined, true)).toBe("Dana Reyes")
  })
})
