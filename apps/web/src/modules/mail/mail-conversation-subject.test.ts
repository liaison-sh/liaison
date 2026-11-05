// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The conversation subject fallback chain. It is on a phone path (the mail
// conversation's own header), so its fallbacks are translated rather than
// hardcoded English.
import { describe, expect, it } from "vitest"
import type { Conversation } from "~/modules/mail/mail-conversation-store"
import { deriveSubject, openedSubjectOf } from "~/modules/mail/mail-conversation-subject"

/** A translator that echoes the key, so a hardcoded string cannot pass. */
const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}:${Object.values(params).join(",")}` : key

function conversation(fields: Partial<Conversation>): Conversation {
  return { id: "c1", ...fields } as Conversation
}

describe("deriveSubject", () => {
  it("translates every fallback rather than printing English", () => {
    expect(deriveSubject(undefined, false, t)).toBe("kernel.mailSubjectFallback")
    expect(deriveSubject(conversation({ subject: "  " }), true, t)).toBe("kernel.mailSubjectLocked")
    expect(deriveSubject(conversation({ senderName: "Alice" }), false, t)).toBe(
      "kernel.mailSubjectWithSender:Alice",
    )
    expect(deriveSubject(conversation({ snippet: "   " }), false, t)).toBe(
      "kernel.mailSubjectFallback",
    )
  })

  it("prefers the real subject, then the snippet", () => {
    expect(deriveSubject(conversation({ subject: " Pedal not detected " }), false, t)).toBe(
      "Pedal not detected",
    )
    expect(deriveSubject(conversation({ snippet: "First line" }), false, t)).toBe("First line")
  })

  it("never says no subject for a sealed conversation, and uses an opened subject", () => {
    const sealed = conversation({ subject: "", senderName: "Alice", sealed: true })
    expect(deriveSubject(sealed, false, t)).toBe("kernel.mailSubjectLocked")
    expect(deriveSubject(sealed, false, t, "Quarterly numbers")).toBe("Quarterly numbers")
    expect(
      openedSubjectOf([
        { encState: "opened", subject: "Older" },
        { encState: "locked", subject: "" },
        { encState: "opened", subject: "Newest" },
      ]),
    ).toBe("Newest")
  })
})
