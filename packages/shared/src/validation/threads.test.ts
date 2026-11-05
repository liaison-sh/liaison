// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { z } from "zod"
import {
  addReactionSchema,
  createThreadSchema,
  editMessageSchema,
  isReactionEmoji,
  listReferencesResponseSchema,
  mentionQuerySchema,
  normalizeChannelTitle,
  searchPageQuerySchema,
  searchQuerySchema,
  sendMessageSchema,
  THREAD_MESSAGE_MAX_CHARS,
  THREAD_TITLE_MAX_CHARS,
  updateThreadSchema,
} from "./threads"

describe("thread validation schemas", () => {
  describe("createThreadSchema", () => {
    it("accepts valid thread with participants and initial message", () => {
      const result = createThreadSchema.safeParse({
        participantIds: ["550e8400-e29b-41d4-a716-446655440001"],
        initialMessage: { content: "Hello!" },
      })
      expect(result.success).toBe(true)
    })

    it("requires at least one participant for a direct message", () => {
      const result = createThreadSchema.safeParse({ participantIds: [] })
      expect(result.success).toBe(false)
    })

    it("accepts a channel created with nobody else in it", () => {
      const result = createThreadSchema.safeParse({
        participantIds: [],
        title: "growth-lab",
        discoverable: true,
      })
      expect(result.success).toBe(true)
    })

    it("refuses a whitespace-only title standing in for a channel name", () => {
      const result = createThreadSchema.safeParse({ participantIds: [], title: "   " })
      expect(result.success).toBe(false)
    })

    it("accepts optional title, isPinned, references", () => {
      const result = createThreadSchema.safeParse({
        participantIds: ["550e8400-e29b-41d4-a716-446655440001"],
        title: "Engineering",
        isPinned: true,
        references: [{ app: "tickets", entityType: "ticket", entityId: "t1" }],
      })
      expect(result.success).toBe(true)
    })

    it("rejects non-UUID participant IDs", () => {
      const result = createThreadSchema.safeParse({ participantIds: ["not-a-uuid"] })
      expect(result.success).toBe(false)
    })
  })

  describe("sendMessageSchema", () => {
    it("accepts valid message content", () => {
      const result = sendMessageSchema.safeParse({ content: "Hello world" })
      expect(result.success).toBe(true)
    })

    it("rejects empty content", () => {
      const result = sendMessageSchema.safeParse({ content: "" })
      expect(result.success).toBe(false)
    })

    it("accepts a pasted transcript well above the old 10000-character cap", () => {
      const result = sendMessageSchema.safeParse({ content: "x".repeat(60_000) })
      expect(result.success).toBe(true)
    })

    it("rejects content exceeding THREAD_MESSAGE_MAX_CHARS", () => {
      const result = sendMessageSchema.safeParse({
        content: "x".repeat(THREAD_MESSAGE_MAX_CHARS + 1),
      })
      expect(result.success).toBe(false)
    })
  })

  describe("editMessageSchema", () => {
    it("accepts valid content", () => {
      const result = editMessageSchema.safeParse({ content: "Updated" })
      expect(result.success).toBe(true)
    })
  })

  describe("addReactionSchema", () => {
    it("accepts valid emoji", () => {
      const result = addReactionSchema.safeParse({ emoji: "👍" })
      expect(result.success).toBe(true)
    })

    it("rejects empty emoji", () => {
      const result = addReactionSchema.safeParse({ emoji: "" })
      expect(result.success).toBe(false)
    })

    // S17 / A14: an RGI emoji, skin-tone and ZWJ sequences included (the
    // family is 8 UTF-16 units, a skin-toned ZWJ sequence goes past that).
    it.each(["👍", "👍🏽", "👨‍👩‍👧", "🇫🇷", "1️⃣", "❤️", "🧑🏽‍🤝‍🧑🏿"])("accepts %s", (emoji) => {
      expect(addReactionSchema.safeParse({ emoji }).success).toBe(true)
      expect(isReactionEmoji(emoji)).toBe(true)
    })

    it.each(["abc", "1", "", "👍 👍", "a👍", "x".repeat(40)])("refuses %j", (emoji) => {
      expect(addReactionSchema.safeParse({ emoji }).success).toBe(false)
      expect(isReactionEmoji(emoji)).toBe(false)
    })
  })

  describe("updateThreadSchema", () => {
    it("accepts title update", () => {
      const result = updateThreadSchema.safeParse({ title: "New Title" })
      expect(result.success).toBe(true)
    })

    it("accepts isPinned update", () => {
      const result = updateThreadSchema.safeParse({ isPinned: true })
      expect(result.success).toBe(true)
    })
  })

  describe("searchQuerySchema", () => {
    it("accepts valid query", () => {
      const result = searchQuerySchema.safeParse({ q: "hello", limit: 5 })
      expect(result.success).toBe(true)
    })

    it("defaults limit to 5", () => {
      const result = searchQuerySchema.safeParse({ q: "hello" })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.limit).toBe(5)
    })
  })
})

describe("mentionQuerySchema (Phase 10)", () => {
  it("accepts optional type filter", () => {
    expect(mentionQuerySchema.parse({ q: "ali", type: "user" }).type).toBe("user")
    expect(mentionQuerySchema.parse({ q: "tic", type: "entity" }).type).toBe("entity")
    expect(mentionQuerySchema.parse({ q: "ali" }).type).toBeUndefined()
  })

  it("accepts the two trigger narrowings the picker sends", () => {
    expect(mentionQuerySchema.parse({ q: "ali", type: "addressable" }).type).toBe("addressable")
    // `#` sends this instead of nothing at all, which is what filled a bare
    // `#` with contacts.
    expect(mentionQuerySchema.parse({ q: "", type: "reference" }).type).toBe("reference")
  })

  it("rejects unknown type filters", () => {
    expect(() => mentionQuerySchema.parse({ q: "ali", type: "anything" })).toThrow()
  })

  it("accepts empty q so the bare-`@` trigger can show top mentionables", () => {
    expect(mentionQuerySchema.parse({ q: "" }).q).toBe("")
    expect(mentionQuerySchema.parse({}).q).toBe("")
  })
})

describe("searchPageQuerySchema (Phase 10)", () => {
  it("supports offset and limit up to 50", () => {
    const ok = searchPageQuerySchema.parse({ q: "usb", offset: 20, limit: 50 })
    expect(ok.offset).toBe(20)
    expect(ok.limit).toBe(50)
  })
  it("rejects limit > 50", () => {
    expect(() => searchPageQuerySchema.parse({ q: "usb", limit: 51 })).toThrow()
  })
  it("accepts optional app and entityType filter arrays", () => {
    const ok = searchPageQuerySchema.parse({
      q: "x",
      app: "tickets,projects",
      entityType: "ticket",
    })
    expect(ok.app).toEqual(["tickets", "projects"])
    expect(ok.entityType).toEqual(["ticket"])
  })

  it("accepts manifest dimension filters as JSON", () => {
    const ok = searchPageQuerySchema.parse({
      q: "x",
      filters: JSON.stringify({ status: ["open"], team: "red" }),
    })
    expect(ok.filters).toEqual({ status: ["open"], team: ["red"] })
  })

  // I-SH-2: malformed filters must not throw 500 — they are silently coerced to {}
  it("returns empty filters for malformed JSON string instead of throwing", () => {
    const ok = searchPageQuerySchema.parse({ q: "x", filters: "{not valid json{{" })
    expect(ok.filters).toEqual({})
  })

  it("returns empty filters for truncated JSON", () => {
    const ok = searchPageQuerySchema.parse({ q: "x", filters: '{"status":' })
    expect(ok.filters).toEqual({})
  })

  it("returns empty filters when filters is a JSON array (not an object)", () => {
    const ok = searchPageQuerySchema.parse({ q: "x", filters: '["a","b"]' })
    expect(ok.filters).toEqual({})
  })

  it("returns empty filters when filters is absent", () => {
    const ok = searchPageQuerySchema.parse({ q: "x" })
    expect(ok.filters).toEqual({})
  })
})

describe("createThreadSchema type field", () => {
  it("accepts type: agent_chat", () => {
    const result = createThreadSchema.safeParse({
      participantIds: ["550e8400-e29b-41d4-a716-446655440000"],
      type: "agent_chat",
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe("agent_chat")
  })

  it("defaults type to 'thread' when omitted", () => {
    const result = createThreadSchema.safeParse({
      participantIds: ["550e8400-e29b-41d4-a716-446655440000"],
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe("thread")
  })

  it("rejects invalid type", () => {
    const result = createThreadSchema.safeParse({
      participantIds: ["550e8400-e29b-41d4-a716-446655440000"],
      type: "invalid",
    })
    expect(result.success).toBe(false)
  })
})

describe("updateThreadSchema type field", () => {
  it("accepts type: thread for promote", () => {
    const result = updateThreadSchema.safeParse({ type: "thread" })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBe("thread")
  })

  it("accepts type: agent_chat", () => {
    const result = updateThreadSchema.safeParse({ type: "agent_chat" })
    expect(result.success).toBe(true)
  })

  it("rejects invalid type", () => {
    const result = updateThreadSchema.safeParse({ type: "dm" })
    expect(result.success).toBe(false)
  })

  it("allows update without type", () => {
    const result = updateThreadSchema.safeParse({ title: "New title" })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.type).toBeUndefined()
  })
})

describe("listReferencesResponseSchema", () => {
  it("threads.references.list-response-shape", () => {
    const sample: z.infer<typeof listReferencesResponseSchema> = {
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          app: "projects",
          entityType: "task",
          entityId: "t1",
          tabType: "projects:task",
          label: "Build agent",
          icon: "FolderKanban",
          lastVisitedAt: "2026-05-06T00:00:00Z",
        },
      ],
    }
    expect(listReferencesResponseSchema.safeParse(sample).success).toBe(true)
  })

  it("threads.references.list-response-rejects-invalid-id", () => {
    expect(listReferencesResponseSchema.safeParse({ items: [{ id: "r1" }] }).success).toBe(false)
  })

  it("threads.references.list-response-rejects-missing-required-fields", () => {
    expect(
      listReferencesResponseSchema.safeParse({
        items: [{ id: "11111111-1111-4111-8111-111111111111" }],
      }).success,
    ).toBe(false)
  })
})

describe("updateThreadSchema agentModelId", () => {
  it("accepts an added model key up to 200 characters", async () => {
    const { updateThreadSchema } = await import("./threads")
    const key = `openrouter/${"a".repeat(189)}`
    expect(key.length).toBe(200)
    expect(updateThreadSchema.safeParse({ agentModelId: key }).success).toBe(true)
    expect(updateThreadSchema.safeParse({ agentModelId: `${key}x` }).success).toBe(false)
  })
})

describe("channel title normalisation", () => {
  it("drops a leading # and the surrounding whitespace", () => {
    for (const [raw, want] of [
      ["#general", "general"],
      [" ## a b ", "a b"],
      ["plain", "plain"],
      ["a #b", "a #b"],
    ] as const) {
      expect(normalizeChannelTitle(raw)).toBe(want)
    }
  })

  it("reads a fullwidth # as # and drops invisible format marks around it", () => {
    expect(normalizeChannelTitle("\uFF03general")).toBe("general")
    expect(normalizeChannelTitle("\u200B#general")).toBe("general")
    expect(normalizeChannelTitle("\u200F#general")).toBe("general")
    expect(normalizeChannelTitle("#\u200B#\uFEFF general\u200B")).toBe("general")
    expect(normalizeChannelTitle("\u200B#\u200F")).toBe("")
    expect(normalizeChannelTitle("a\u200Db")).toBe("a\u200Db")
  })

  it("keeps the same result around astral characters and unpaired surrogates", () => {
    expect(normalizeChannelTitle("a\u{E0001}")).toBe("a")
    expect(normalizeChannelTitle("a\u{1F600}")).toBe("a\u{1F600}")
    expect(normalizeChannelTitle("a\u{1F600}\u200B \t")).toBe("a\u{1F600}")
    expect(normalizeChannelTitle("a\uDC00")).toBe("a\uDC00")
    expect(normalizeChannelTitle("a\uD83D")).toBe("a\uD83D")
    expect(normalizeChannelTitle("   ")).toBe("")
  })

  it("stays fast on a long title, whatever its whitespace", () => {
    const long = `a${"\t".repeat(1_000_000)}b`
    const started = performance.now()
    expect(normalizeChannelTitle(long)).toBe(long)
    expect(normalizeChannelTitle(`a${"\t".repeat(1_000_000)}`)).toBe("a")
    expect(performance.now() - started).toBeLessThan(500)
  })

  it("caps the title at THREAD_TITLE_MAX_CHARS", () => {
    const base = { participantIds: ["00000000-0000-4000-8000-000000000001"] }
    const atCap = "a".repeat(THREAD_TITLE_MAX_CHARS)
    expect(createThreadSchema.safeParse({ ...base, title: atCap }).success).toBe(true)
    expect(createThreadSchema.safeParse({ ...base, title: `${atCap}a` }).success).toBe(false)
  })

  it("leaves the title to the server, which knows whether the room is a channel", () => {
    // An agent chat titled "#1 priority" keeps its #: only a channel's is stripped.
    const c = createThreadSchema.safeParse({ participantIds: [], title: "#1 priority" })
    expect(c.success && c.data.title).toBe("#1 priority")
    const u = updateThreadSchema.safeParse({ title: "#1 priority" })
    expect(u.success && u.data.title).toBe("#1 priority")
  })
})
