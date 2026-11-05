// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { assemblePrompt, capMessages, INTERNAL_TAG, TRUNCATION_MARKER } from "./summary"

describe("capMessages", () => {
  it("caps at 20 messages, preserving the most recent", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      textBody: "x",
      kind: "inbound",
      sentAt: `2026-05-01T${String(i).padStart(2, "0")}:00:00Z`,
    }))
    const out = capMessages(msgs, { maxMessages: 20, maxInputTokens: 100000 })
    expect(out.messages.length).toBe(20)
    expect(out.messages[0].id).toBe("10")
    expect(out.truncated).toBe(true)
  })

  it("does not flag truncated when full set fits", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      textBody: "x",
      kind: "inbound",
      sentAt: "2026-05-01T10:00:00Z",
    }))
    const out = capMessages(msgs, { maxMessages: 20, maxInputTokens: 100000 })
    expect(out.messages.length).toBe(5)
    expect(out.truncated).toBe(false)
  })

  it("caps at token budget when shorter than message count", () => {
    const msgs = Array.from({ length: 20 }, () => ({
      id: "i",
      textBody: "x".repeat(4000),
      kind: "inbound",
      sentAt: "2026-05-01T10:00:00Z",
    }))
    const out = capMessages(msgs, { maxMessages: 20, maxInputTokens: 1000 })
    expect(out.messages.length).toBeLessThanOrEqual(1)
    expect(out.truncated).toBe(true)
  })
})

describe("assemblePrompt", () => {
  const skill = "Summarize this ticket."
  const ticket = {
    handle: "ticket-42",
    subject: "broken login",
    status: "open",
    priority: "normal",
    categoryName: null,
    contactName: "Alice",
    fromEmail: "a@x.com",
  }

  it("includes header, previous summary, and new messages", () => {
    const p = assemblePrompt({
      skill,
      ticket,
      previousSummary: "Old summary.",
      newMessages: [
        {
          kind: "inbound",
          textBody: "hello",
          sentAt: "2026-05-01T09:00:00Z",
          fromEmail: "a@x.com",
        },
      ],
      truncated: false,
    })
    expect(p).toContain("Summarize this ticket.")
    expect(p).toContain("Ticket #ticket-42: broken login")
    expect(p).toContain("Old summary.")
    expect(p).toContain("hello")
  })

  it("tags note kind with [INTERNAL]", () => {
    const p = assemblePrompt({
      skill,
      ticket,
      previousSummary: "",
      newMessages: [{ kind: "note", textBody: "off-record", sentAt: "2026-05-01T10:00:00Z" }],
      truncated: false,
    })
    expect(p).toContain(INTERNAL_TAG)
  })

  it("prepends truncation marker when truncated", () => {
    const p = assemblePrompt({
      skill,
      ticket,
      previousSummary: "",
      newMessages: [],
      truncated: true,
    })
    expect(p).toContain(TRUNCATION_MARKER)
  })

  it("falls back to fromEmail when contactName is null", () => {
    const p = assemblePrompt({
      skill,
      ticket: { ...ticket, contactName: null },
      previousSummary: "",
      newMessages: [],
      truncated: false,
    })
    expect(p).toContain("Contact: a@x.com")
  })
})
