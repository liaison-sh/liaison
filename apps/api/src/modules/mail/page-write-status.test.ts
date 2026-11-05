// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { newConversationStatus, type PageMessage } from "~/modules/mail/page-write"

const msg = (direction: "inbound" | "outbound"): PageMessage =>
  ({ externalMessageId: `<${direction}@x>`, direction }) as PageMessage

// A Sent backfill must not flood the inbox with threads holding only the
// mailbox's own mail: those start archived (and show in Sent).
describe("newConversationStatus", () => {
  it("archives an outbound-only thread found by the IMAP Sent import", () => {
    expect(newConversationStatus([msg("outbound")], "imap-sent")).toBe("archived")
  })

  it("opens a thread with inbound mail, and every thread from other origins", () => {
    expect(newConversationStatus([msg("outbound"), msg("inbound")], "imap-sent")).toBe("open")
    expect(newConversationStatus([msg("outbound")], "sent")).toBe("open")
    expect(newConversationStatus([msg("inbound")], "imap")).toBe("open")
  })
})
