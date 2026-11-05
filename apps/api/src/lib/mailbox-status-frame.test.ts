// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { MAILBOX_UNLOCK_TTL_MS, parseMailboxStatusFrame } from "~/lib/mailbox-status-frame"

describe("mailbox status frame", () => {
  it("parses a well-formed unlock assertion and stamps a TTL (non-vacuity)", () => {
    const before = Date.now()
    const entry = parseMailboxStatusFrame({
      type: "status",
      scope: "mailbox",
      unlocked: true,
      keyIds: [1, 2],
    })
    expect(entry).not.toBeNull()
    expect(entry?.unlocked).toBe(true)
    expect(entry?.keyIds).toEqual([1, 2])
    expect(entry?.expiresAt).toBeGreaterThanOrEqual(before + MAILBOX_UNLOCK_TTL_MS - 1000)
  })

  it("parses a lock assertion", () => {
    const entry = parseMailboxStatusFrame({ type: "status", scope: "mailbox", unlocked: false })
    expect(entry?.unlocked).toBe(false)
    expect(entry?.keyIds).toEqual([])
  })

  it("ignores a frame that is not a mailbox status frame", () => {
    expect(parseMailboxStatusFrame({ type: "status", status: "online" })).toBeNull()
    expect(parseMailboxStatusFrame({ type: "typing" })).toBeNull()
    expect(parseMailboxStatusFrame(null)).toBeNull()
    expect(parseMailboxStatusFrame("mailbox")).toBeNull()
  })

  it("ignores a malformed mailbox frame rather than throwing", () => {
    expect(parseMailboxStatusFrame({ type: "status", scope: "mailbox" })).toBeNull()
    expect(
      parseMailboxStatusFrame({ type: "status", scope: "mailbox", unlocked: "yes" }),
    ).toBeNull()
  })

  it("drops an oversized or non-numeric key id list instead of storing it", () => {
    const oversized = parseMailboxStatusFrame({
      type: "status",
      scope: "mailbox",
      unlocked: true,
      keyIds: Array.from({ length: 500 }, (_, i) => i),
    })
    expect(oversized?.keyIds.length).toBe(64)
    const junk = parseMailboxStatusFrame({
      type: "status",
      scope: "mailbox",
      unlocked: true,
      keyIds: ["a", 3, null],
    })
    expect(junk?.keyIds).toEqual([3])
  })

  it("carries the client's open turns, capped, and leaves them absent for a client that sends none", () => {
    const withTurns = parseMailboxStatusFrame(
      { type: "status", scope: "mailbox", unlocked: false, keyIds: [], turns: ["t1", 7, "", "t2"] },
      1_000,
    )
    expect(withTurns?.turns).toEqual(["t1", "t2"])
    const many = parseMailboxStatusFrame({
      type: "status",
      scope: "mailbox",
      unlocked: true,
      keyIds: [],
      turns: Array.from({ length: 40 }, (_, i) => `t${i}`),
    })
    expect(many?.turns).toHaveLength(16)
    const legacy = parseMailboxStatusFrame({
      type: "status",
      scope: "mailbox",
      unlocked: true,
      keyIds: [],
    })
    expect(legacy && "turns" in legacy).toBe(false)
  })
})
