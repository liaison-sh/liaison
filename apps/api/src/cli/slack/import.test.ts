// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure-helper tests for the `slack import` CLI — subtype skip/system rules
// and Slack ts → Date conversion. The DB-touching import path needs a real
// Slack export + a live database and is exercised manually per the CLI spec
// (see apps/api/src/cli/slack/import.ts docblock); these tests cover the
// logic that's safe and meaningful to unit-test in isolation.
import { describe, expect, it } from "bun:test"
import {
  channelDescription,
  clip,
  compareSlackTs,
  isSlackHosted,
  isSlackReply,
  placeholderEmail,
  redactUrl,
  replyPlacement,
  shouldSkipMessage,
  slackTsToDate,
  systemSubtypeContent,
} from "./import"

describe("shouldSkipMessage", () => {
  it("skips channel_join / channel_leave", () => {
    expect(shouldSkipMessage({ ts: "1", subtype: "channel_join" })).toBe(true)
    expect(shouldSkipMessage({ ts: "1", subtype: "channel_leave" })).toBe(true)
  })

  it("skips sh_room_created / retention_threshold / bot_add / tombstone / huddle_thread", () => {
    for (const subtype of [
      "sh_room_created",
      "retention_threshold",
      "bot_add",
      "tombstone",
      "huddle_thread",
    ]) {
      expect(shouldSkipMessage({ ts: "1", subtype })).toBe(true)
    }
  })

  it("does not skip a null-subtype message", () => {
    expect(shouldSkipMessage({ ts: "1" })).toBe(false)
  })

  it("does not skip thread_broadcast or bot_message", () => {
    expect(shouldSkipMessage({ ts: "1", subtype: "thread_broadcast" })).toBe(false)
    expect(shouldSkipMessage({ ts: "1", subtype: "bot_message" })).toBe(false)
  })

  it("does not skip channel_purpose / channel_name / channel_archive (imported as system messages)", () => {
    expect(shouldSkipMessage({ ts: "1", subtype: "channel_purpose" })).toBe(false)
    expect(shouldSkipMessage({ ts: "1", subtype: "channel_name" })).toBe(false)
    expect(shouldSkipMessage({ ts: "1", subtype: "channel_archive" })).toBe(false)
  })

  it("skips a hidden message regardless of subtype", () => {
    expect(shouldSkipMessage({ ts: "1", hidden: true })).toBe(true)
  })
})

describe("systemSubtypeContent", () => {
  it("renders channel_purpose", () => {
    expect(
      systemSubtypeContent({ ts: "1", subtype: "channel_purpose", purpose: "ship stuff" }),
    ).toBe("Channel purpose set: ship stuff")
  })

  it("renders channel_name with old -> new", () => {
    expect(
      systemSubtypeContent({
        ts: "1",
        subtype: "channel_name",
        old_name: "general",
        name: "random",
      }),
    ).toBe("Channel renamed: general → random")
  })

  it("renders channel_archive", () => {
    expect(systemSubtypeContent({ ts: "1", subtype: "channel_archive" })).toBe("Channel archived")
  })
})

describe("slackTsToDate", () => {
  it("converts an epoch-seconds-with-fraction ts to the correct Date", () => {
    const d = slackTsToDate("1649672651.246279")
    expect(d.getTime()).toBe(Math.round(1649672651.246279 * 1000))
  })

  it("handles a ts with no fractional part", () => {
    const d = slackTsToDate("1540570155.000000")
    expect(d.toISOString()).toBe(new Date(1540570155 * 1000).toISOString())
  })

  it("orders two ts values correctly for sort comparisons", () => {
    // Slack ts carries microsecond precision; Date only resolves to the
    // millisecond, so two ts within the same ms round to equal getTime()
    // (message ORDER within that ms is instead preserved by sorting on the
    // raw ts string/float, not the Date — see the channel import loop).
    // A full-second apart is enough to prove monotonic ordering holds.
    const a = slackTsToDate("1620058176.000200")
    const b = slackTsToDate("1620058177.000300")
    expect(a.getTime()).toBeLessThan(b.getTime())
  })
})

describe("shouldSkipMessage — membership noise", () => {
  it("skips group_join / group_leave / bot_remove", () => {
    for (const subtype of ["group_join", "group_leave", "bot_remove"]) {
      expect(shouldSkipMessage({ ts: "1", subtype })).toBe(true)
    }
  })
})

describe("systemSubtypeContent — topic and visibility events", () => {
  it("renders channel_topic", () => {
    expect(systemSubtypeContent({ ts: "1", subtype: "channel_topic", topic: "Q3" })).toBe(
      "Channel topic set: Q3",
    )
  })
  it("renders channel_convert_to_public", () => {
    expect(systemSubtypeContent({ ts: "1", subtype: "channel_convert_to_public" })).toBe(
      "Channel made public",
    )
  })
})

describe("compareSlackTs", () => {
  it("orders numerically, not lexically", () => {
    const sorted = ["1000000000.000002", "999999999.000001", "1000000000.000001"].sort(
      compareSlackTs,
    )
    expect(sorted).toEqual(["999999999.000001", "1000000000.000001", "1000000000.000002"])
  })
})

describe("replyPlacement", () => {
  const roots = new Map([["100.000100", "root-uuid"]])

  it("a channel message has no root", () => {
    expect(replyPlacement({ ts: "100.000100" }, roots)).toEqual({
      replyRootId: null,
      alsoInChannel: false,
      orphan: false,
    })
    // A root carries thread_ts === ts: still a channel message.
    expect(isSlackReply({ ts: "100.000100", thread_ts: "100.000100" })).toBe(false)
  })

  it("a reply hangs under its root, not as a quote", () => {
    expect(replyPlacement({ ts: "101.0", thread_ts: "100.000100" }, roots)).toEqual({
      replyRootId: "root-uuid",
      alsoInChannel: false,
      orphan: false,
    })
  })

  it("a thread_broadcast reply also shows in the channel", () => {
    expect(
      replyPlacement({ ts: "101.0", thread_ts: "100.000100", subtype: "thread_broadcast" }, roots),
    ).toEqual({ replyRootId: "root-uuid", alsoInChannel: true, orphan: false })
  })

  it("a reply whose root was never exported becomes a flagged channel message", () => {
    expect(replyPlacement({ ts: "101.0", thread_ts: "50.0" }, roots)).toEqual({
      replyRootId: null,
      alsoInChannel: false,
      orphan: true,
    })
  })
})

describe("redactUrl", () => {
  it("never lets the export token through", () => {
    const url = "https://files.slack.com/files-pri/T1-F1/download/a.png?token=xoxe-123-abc&x=1"
    const out = redactUrl(url)
    expect(out).not.toContain("xoxe")
    expect(out).toContain("token=REDACTED")
    expect(redactUrl("https://files.slack.com/a.png?t=xoxe-9")).toBe(
      "https://files.slack.com/a.png?t=REDACTED",
    )
  })
})

describe("isSlackHosted", () => {
  it("is files.slack.com or a subdomain of it, nothing that merely ends the same way", () => {
    expect(isSlackHosted("https://files.slack.com/files-pri/T1-F1/a.png")).toBe(true)
    expect(isSlackHosted("https://eu.files.slack.com/a.png")).toBe(true)
    expect(isSlackHosted("https://notfiles.slack.com/a.png")).toBe(false)
    expect(isSlackHosted("https://files.slack.com.example.com/a.png")).toBe(false)
    expect(isSlackHosted("not a url")).toBe(false)
    expect(isSlackHosted(undefined)).toBe(false)
  })
})

describe("channelDescription / clip", () => {
  const base = { id: "C1", name: "general", created: 1, members: [] }
  it("carries the purpose", () => {
    expect(channelDescription({ ...base, purpose: { value: "Company news" } }, null)).toBe(
      "Company news",
    )
  })
  it("marks an archived channel with its archive date", () => {
    expect(
      channelDescription(
        { ...base, is_archived: true, purpose: { value: "Old" } },
        new Date("2021-03-04T10:00:00Z"),
      ),
    ).toBe("Archived in Slack on 2021-03-04.\n\nOld")
  })
  it("is null when there is nothing to say", () => {
    expect(channelDescription(base, null)).toBeNull()
  })
  it("clips to the column limit", () => {
    expect(clip("x".repeat(300), 250)).toHaveLength(250)
    expect(clip("short", 250)).toBe("short")
  })
})

describe("placeholderEmail", () => {
  it("is stable and address-safe", () => {
    expect(placeholderEmail("Jean.Dupont")).toBe("slack-import+jean.dupont@import.invalid")
    expect(placeholderEmail("bot-B01 X")).toBe("slack-import+bot-b01-x@import.invalid")
  })
})
