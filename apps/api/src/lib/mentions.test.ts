// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { messagePreview, parseMentions } from "./mentions"

describe("parseMentions", () => {
  it("parses user mention with UUID", () => {
    const result = parseMentions("Hi @[Alice](user:550e8400-e29b-41d4-a716-446655440000)")
    expect(result).toEqual([{ type: "user", id: "550e8400-e29b-41d4-a716-446655440000" }])
  })

  it("parses thread mention with UUID", () => {
    const result = parseMentions("See @[Bug Thread](thread:660e8400-e29b-41d4-a716-446655440001)")
    expect(result).toEqual([{ type: "thread", id: "660e8400-e29b-41d4-a716-446655440001" }])
  })

  it("parses entity mention with UUID", () => {
    const result = parseMentions("Check @[Ticket](crm:ticket:770e8400-e29b-41d4-a716-446655440002)")
    expect(result).toEqual([
      {
        type: "entity",
        app: "crm",
        entityType: "ticket",
        id: "770e8400-e29b-41d4-a716-446655440002",
      },
    ])
  })

  it("parseMentions extracts a specific agent id from an agent mention token", () => {
    const result = parseMentions(
      "Hey @[Support](agent:880e8400-e29b-41d4-a716-446655440003) can you help?",
    )
    expect(result).toEqual([{ type: "agent", id: "880e8400-e29b-41d4-a716-446655440003" }])
  })

  it("parseMentions drops an agent mention token with a malformed id", () => {
    // The bare marker is gone: a mention that names no agent addresses nobody.
    expect(parseMentions("Hey @[Liaison](agent:kernel) can you help?")).toEqual([])
  })

  it("parses mixed mentions including agent", () => {
    const result = parseMentions(
      "@[Support](agent:880e8400-e29b-41d4-a716-446655440003) check @[Alice](user:550e8400-e29b-41d4-a716-446655440000)",
    )
    expect(result).toEqual([
      { type: "agent", id: "880e8400-e29b-41d4-a716-446655440003" },
      { type: "user", id: "550e8400-e29b-41d4-a716-446655440000" },
    ])
  })

  it("skips mentions with invalid UUID for user/thread types", () => {
    const result = parseMentions("@[Bad](user:not-a-uuid)")
    expect(result).toEqual([])
  })

  it("deduplicates multiple agent mentions", () => {
    const result = parseMentions(
      "@[Support](agent:880e8400-e29b-41d4-a716-446655440003) and @[Support](agent:880e8400-e29b-41d4-a716-446655440003)",
    )
    // parseMentions returns all matches — dedup is caller responsibility
    expect(result).toEqual([
      { type: "agent", id: "880e8400-e29b-41d4-a716-446655440003" },
      { type: "agent", id: "880e8400-e29b-41d4-a716-446655440003" },
    ])
  })

  it("returns empty array for no mentions", () => {
    expect(parseMentions("Hello world")).toEqual([])
  })

  it("returns empty array for empty string", () => {
    expect(parseMentions("")).toEqual([])
  })
  // Quoting a mention is not addressing it: a token inside a code span or a
  // fenced block is being SHOWN, and showing an agent's handle in an example
  // must not summon it.
  const AGENT = "880e8400-e29b-41d4-a716-446655440003"

  it("ignores a mention inside an inline code span", () => {
    expect(parseMentions(`write \`@[Support](agent:${AGENT})\` to ask`)).toEqual([])
  })

  it("ignores a mention inside a fenced code block", () => {
    expect(
      parseMentions(`here is the syntax\n\`\`\`\n@[Support](agent:${AGENT})\n\`\`\`\nthat is all`),
    ).toEqual([])
  })

  it("ignores a mention inside a tilde-fenced block", () => {
    expect(parseMentions(`~~~md\n@[Support](agent:${AGENT})\n~~~`)).toEqual([])
  })

  it("still parses a real mention that sits beside a code span", () => {
    expect(parseMentions(`run \`ls\` then @[Support](agent:${AGENT}) please`)).toEqual([
      { type: "agent", id: AGENT },
    ])
  })

  it("a stray backtick on one line never swallows a mention on another", () => {
    // An inline span is a single-line construct. Letting the pair match across
    // newlines made one unclosed backtick eat every line up to the next one,
    // and a mention caught between them fired nothing.
    expect(
      parseMentions(`what does \` do\nanyway @[Support](agent:${AGENT})?\nand \` again`),
    ).toEqual([{ type: "agent", id: AGENT }])
  })

  it("still parses a real mention after a closed fence", () => {
    expect(parseMentions(`\`\`\`\nsome code\n\`\`\`\n@[Support](agent:${AGENT})`)).toEqual([
      { type: "agent", id: AGENT },
    ])
  })
})

describe("messagePreview", () => {
  const AGENT = "6c7de388-0000-4000-8000-000000000001"
  it("renders a mention as @Label, not its markup", () => {
    expect(messagePreview(`@[Base](agent:${AGENT}) can you check this?`)).toBe(
      "@Base can you check this?",
    )
    expect(messagePreview("hi @[Alice Chen](user:11111111-1111-1111-1111-111111111111)")).toBe(
      "hi @Alice Chen",
    )
  })

  it("caps at 140 characters after rendering the mentions", () => {
    const long = `@[Base](agent:${AGENT}) ${"x".repeat(200)}`
    const preview = messagePreview(long)
    expect(preview.startsWith("@Base x")).toBe(true)
    expect(preview.length).toBe(141)
    expect(preview.endsWith("…")).toBe(true)
  })

  it("leaves plain text unchanged", () => {
    expect(messagePreview("plain text")).toBe("plain text")
  })
})

describe("messagePreview renders markup as plain text", () => {
  it("links, bold and code spans read as text", () => {
    expect(messagePreview("see **this** [doc](https://x.test/d) and `npm ci`")).toBe(
      "see this doc and npm ci",
    )
  })
})
