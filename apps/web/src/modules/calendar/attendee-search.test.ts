// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { type AttendeeSuggestion, rankSuggestions } from "./attendee-search"

const person = (name: string, email: string): AttendeeSuggestion => ({
  name,
  email,
  kind: "person",
})

describe("guest suggestions", () => {
  it("lists a name prefix match before people matched only on their domain", () => {
    const rows = [
      person("Henrik Larsen", "henrik@example.test"),
      person("Giulia Romano", "giulia@example.test"),
      person("Amina Diallo", "amina@example.test"),
    ]
    expect(rankSuggestions(rows, "am").map((r) => r.name)).toEqual([
      "Amina Diallo",
      "Henrik Larsen",
      "Giulia Romano",
    ])
  })

  it("ranks a last-name or address prefix first, then a match inside the name", () => {
    const rows = [
      person("Samira Ost", "samira@example.test"),
      person("Tobias Braun", "t.braun@example.test"),
      person("Clara Bram", "clara@example.test"),
    ]
    expect(rankSuggestions(rows, "bra").map((r) => r.name)).toEqual([
      "Tobias Braun",
      "Clara Bram",
      "Samira Ost",
    ])
  })
})
