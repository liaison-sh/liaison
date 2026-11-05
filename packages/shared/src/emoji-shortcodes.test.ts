// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { EMOJI_SHORTCODES, emojiForShortcode, searchEmojiShortcodes } from "./emoji-shortcodes"

describe("emoji shortcodes", () => {
  it("is a wide table of common names", () => {
    expect(Object.keys(EMOJI_SHORTCODES).length).toBeGreaterThan(400)
    expect(emojiForShortcode("smile")).toBe("😄")
    expect(emojiForShortcode("thumbsup")).toBe("👍")
    expect(emojiForShortcode("+1")).toBe("👍")
    expect(emojiForShortcode("no_such_emoji")).toBeUndefined()
    expect(emojiForShortcode("constructor")).toBeUndefined()
  })

  it("ranks exact, then prefix (shorter first), then substring, up to the limit", () => {
    const sm = searchEmojiShortcodes("sm")
    expect(sm[0]).toEqual({ name: "smile", emoji: "😄" })
    expect(sm.length).toBeLessThanOrEqual(8)
    expect(searchEmojiShortcodes("fire")[0]?.name).toBe("fire")
    expect(
      searchEmojiShortcodes("heart")
        .slice(0, 2)
        .map((s) => s.name),
    ).toEqual(["heart", "hearts"])
    expect(searchEmojiShortcodes("SMILE")[0]?.name).toBe("smile")
    expect(searchEmojiShortcodes("zzzzqq")).toEqual([])
    expect(searchEmojiShortcodes("")).toEqual([])
  })

  it("lists one row per emoji (aliases collapse)", () => {
    const rows = searchEmojiShortcodes("thumbs")
    expect(new Set(rows.map((r) => r.emoji)).size).toBe(rows.length)
  })
})
