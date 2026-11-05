// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { deriveProjectKey, formatTaskKey, parseTaskKey } from "~/apps/projects/service/task-key"

describe("deriveProjectKey", () => {
  it.each([
    ["Feature Requests", "FRQ"],
    ["QA to-do", "QAT"],
    ["Website bugs", "WEB"],
    ["Dealer Shipments", "DSH"],
    ["Support Shipments & Repairs", "SSR"],
    ["Logistique & Litiges Transporteurs", "LLT"],
  ])("derives the named key for %s", (name, expected) => {
    expect(deriveProjectKey(name)).toBe(expected)
  })

  it("matches a named key case-insensitively", () => {
    expect(deriveProjectKey("feature requests")).toBe("FRQ")
    expect(deriveProjectKey("FEATURE REQUESTS")).toBe("FRQ")
  })

  it("derives a 3-letter key from a single word", () => {
    expect(deriveProjectKey("Marketing")).toBe("MAR")
  })

  it("derives a 3-char key from two words (2+1)", () => {
    expect(deriveProjectKey("Product Roadmap")).toBe("PRR")
  })

  it("handles an accented single word by dropping non-letters", () => {
    // Accented letters are not [a-zA-Z] so they are stripped; "l t" -> "LT",
    // padded from the remaining letters ("t" alone), falling back to PRJ if
    // nothing usable survives.
    const key = deriveProjectKey("Été")
    expect(key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/)
  })

  it("falls back to PRJ for a punctuation-only name", () => {
    expect(deriveProjectKey("!!! --- ###")).toBe("PRJ")
  })

  it("falls back to PRJ for an empty name", () => {
    expect(deriveProjectKey("")).toBe("PRJ")
  })

  it("falls back to PRJ for a single-letter name", () => {
    expect(deriveProjectKey("X")).toBe("PRJ")
  })

  it("does not reach Object.prototype for a prototype-shaped project name", () => {
    // NAMED_KEYS is looked up by lowercased name; a project literally named
    // "constructor", "toString", etc. must not resolve to the inherited
    // Object.prototype member (a function), which fails the DB key CHECK.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const key = deriveProjectKey(name)
      expect(typeof key).toBe("string")
      expect(key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/)
    }
  })
})

describe("parseTaskKey", () => {
  it("parses a well-formed key", () => {
    expect(parseTaskKey("ERB-12")).toEqual({ key: "ERB", number: 12 })
  })

  it("is case-insensitive", () => {
    expect(parseTaskKey("erb-12")).toEqual({ key: "ERB", number: 12 })
  })

  it("rejects a bare UUID", () => {
    expect(parseTaskKey("00000000-0000-4000-8000-000000000001")).toBeNull()
  })

  it("rejects a key with no number", () => {
    expect(parseTaskKey("ERB")).toBeNull()
  })

  it("rejects a lowercase-only garbage string", () => {
    expect(parseTaskKey("not a key")).toBeNull()
  })

  it("round-trips with formatTaskKey", () => {
    const formatted = formatTaskKey("ERB", 42)
    expect(formatted).toBe("ERB-42")
    expect(parseTaskKey(formatted)).toEqual({ key: "ERB", number: 42 })
  })
})
