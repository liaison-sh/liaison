// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { emojiForShortcode } from "@liaison/shared"
import { slackReactionToEmoji } from "~/cli/slack/emoji"

describe("slackReactionToEmoji", () => {
  it("reads the shared shortcode table", () => {
    expect(slackReactionToEmoji("+1")).toBe(emojiForShortcode("+1") ?? "")
    expect(slackReactionToEmoji("+1::skin-tone-3")).toBe("👍")
    expect(slackReactionToEmoji("tada")).toBe("🎉")
  })
  it("passes unicode through and keeps unknown names as :name:", () => {
    expect(slackReactionToEmoji("👍")).toBe("👍")
    expect(slackReactionToEmoji("custom_blob")).toBe(":custom_blob:")
  })
})
