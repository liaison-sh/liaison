// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { extractLinkedNames, resolveMemoryLinks } from "./memory-links"

describe("memory link resolution", () => {
  it("extractLinkedNames pulls every [[name]] reference", () => {
    const body = "Refers to [[team-leads]] and [[q3-launch]]; not [single brackets]."
    expect(extractLinkedNames(body)).toEqual(["team-leads", "q3-launch"])
  })

  it("resolveMemoryLinks turns [[name]] into structured link tokens", () => {
    const entries = [{ name: "team-leads", description: "Team leads" }]
    const result = resolveMemoryLinks("See [[team-leads]] and [[missing]].", entries)
    expect(result).toEqual([
      { kind: "text", value: "See " },
      { kind: "link", name: "team-leads", description: "Team leads", broken: false },
      { kind: "text", value: " and " },
      { kind: "link", name: "missing", description: null, broken: true },
      { kind: "text", value: "." },
    ])
  })

  it("empty body returns empty token list", () => {
    expect(resolveMemoryLinks("", [])).toEqual([])
  })

  it("rejects malformed link syntax (uppercase or special chars)", () => {
    expect(extractLinkedNames("[[Bad]] [[also bad]] [[ok-1]]")).toEqual(["ok-1"])
  })
})
