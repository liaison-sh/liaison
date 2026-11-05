// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { parseMentions, serializeMention } from "~/lib/mention-format"

describe("serializeMention", () => {
  it("serializes user mention", () => {
    expect(serializeMention({ type: "user", id: "u1", label: "Alice" })).toBe("@[Alice](user:u1)")
  })

  it("serializes thread mention", () => {
    expect(serializeMention({ type: "thread", id: "t1", label: "General" })).toBe(
      "@[General](thread:t1)",
    )
  })

  it("serializes entity mention with app and entityType", () => {
    expect(
      serializeMention({
        type: "entity",
        id: "e1",
        label: "Release 2.0",
        app: "tracker",
        entityType: "release",
      }),
    ).toBe("@[Release 2.0](tracker:release:e1)")
  })
})

describe("parseMentions", () => {
  it("parses a single user mention", () => {
    const result = parseMentions("Hello @[Alice](user:u1)")
    expect(result).toEqual([{ type: "user", id: "u1", label: "Alice" }])
  })

  it("parses a single thread mention", () => {
    const result = parseMentions("See @[General](thread:t1)")
    expect(result).toEqual([{ type: "thread", id: "t1", label: "General" }])
  })

  it("parses an entity mention", () => {
    const result = parseMentions("Check @[Bug 42](tracker:bug:e1)")
    expect(result).toEqual([
      { type: "entity", id: "e1", label: "Bug 42", app: "tracker", entityType: "bug" },
    ])
  })

  it("parses consecutive mentions", () => {
    const result = parseMentions("@[Alice](user:u1) and @[Bob](user:u2)")
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: "user", id: "u1", label: "Alice" })
    expect(result[1]).toEqual({ type: "user", id: "u2", label: "Bob" })
  })

  it("parses mixed mention types", () => {
    const result = parseMentions(
      "Hey @[Alice](user:u1), check @[General](thread:t1) and @[Bug](tracker:bug:e1)",
    )
    expect(result).toHaveLength(3)
    expect(result[0].type).toBe("user")
    expect(result[1].type).toBe("thread")
    expect(result[2].type).toBe("entity")
  })

  it("returns empty array for text with no mentions", () => {
    expect(parseMentions("No mentions here")).toEqual([])
  })

  it("returns empty array for empty string", () => {
    expect(parseMentions("")).toEqual([])
  })

  it("ignores malformed mentions with missing parts", () => {
    // Only one colon-separated part — not user/thread/entity with id
    expect(parseMentions("@[Label](onlyone)")).toEqual([])
  })

  it("does not share regex state across calls", () => {
    // Call twice to verify no stale lastIndex issues
    const first = parseMentions("@[A](user:u1) @[B](user:u2)")
    const second = parseMentions("@[C](user:u3)")
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe("u3")
  })
})

describe("round-trip", () => {
  it("serializes and parses user mention", () => {
    const input = { type: "user" as const, id: "u42", label: "Jane" }
    const serialized = serializeMention(input)
    const parsed = parseMentions(serialized)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual(input)
  })

  it("serializes and parses thread mention", () => {
    const input = { type: "thread" as const, id: "t99", label: "Engineering" }
    const serialized = serializeMention(input)
    const parsed = parseMentions(serialized)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual(input)
  })

  it("serializes and parses entity mention", () => {
    const input = {
      type: "entity" as const,
      id: "e5",
      label: "Sprint 3",
      app: "pm",
      entityType: "sprint",
    }
    const serialized = serializeMention(input)
    const parsed = parseMentions(serialized)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual(input)
  })

  it("round-trips a label containing ]", () => {
    const input = { type: "user" as const, id: "u1", label: "Alice [Admin]" }
    const serialized = serializeMention(input)
    const parsed = parseMentions(serialized)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].label).toBe("Alice [Admin]")
  })

  it("round-trips a label containing backslash", () => {
    const input = { type: "user" as const, id: "u1", label: "path\\to\\file" }
    const serialized = serializeMention(input)
    const parsed = parseMentions(serialized)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].label).toBe("path\\to\\file")
  })
})
