// SPDX-License-Identifier: FSL-1.1-ALv2
// The fact extractor's model input is bounded, and its fenced JSON answer parses.
import { describe, expect, it } from "bun:test"
import { factExtractionInput, parseFactCandidates, type RegionMessage } from "./consolidation"

function message(i: number, chars: number): RegionMessage {
  return {
    id: `m-${i}`,
    content: `${i}:${"x".repeat(chars)}`,
    createdAt: new Date(0),
    requiredScopes: [],
    disclosureList: null,
    authorType: i % 2 === 0 ? "user" : "agent",
    authorId: null,
  }
}

describe("fact extraction input", () => {
  it("stays under the token budget for a region far larger than the window", () => {
    // 400 messages of 40,000 chars: about 4,000,000 estimated tokens.
    const region = Array.from({ length: 400 }, (_, i) => message(i, 40_000))
    const budget = 100_000
    const input = factExtractionInput(region, budget)
    expect(Math.ceil(input.length / 4)).toBeLessThanOrEqual(budget)
    // The newest message is always there, with its id for the candidates to cite.
    expect(input).toContain("m-399 agent: 399:")
    expect(input).not.toContain("m-0 user:")
  })

  it("clips a single message larger than the whole budget instead of sending it", () => {
    const input = factExtractionInput([message(0, 2_000_000)], 1_000)
    expect(input.length).toBeLessThanOrEqual(4_000)
    expect(input.startsWith("m-0 user: 0:")).toBe(true)
    expect(input.endsWith("[message clipped for length]")).toBe(true)
  })

  it("sends a small region whole, in order", () => {
    const region = [message(0, 10), message(1, 10)]
    expect(factExtractionInput(region, 10_000)).toBe(
      `m-0 user: 0:${"x".repeat(10)}\nm-1 agent: 1:${"x".repeat(10)}`,
    )
  })
})

describe("fact candidate parsing", () => {
  const candidate = { name: "ship-date", description: "d", body: "b", sourceMessageIds: ["m-1"] }

  it("parses a JSON array wrapped in a Markdown code fence", () => {
    const text = `\`\`\`json\n${JSON.stringify([candidate])}\n\`\`\``
    expect(parseFactCandidates(text)).toEqual([candidate])
  })

  it("parses a bare JSON array", () => {
    expect(parseFactCandidates(JSON.stringify([candidate]))).toEqual([candidate])
  })
})
