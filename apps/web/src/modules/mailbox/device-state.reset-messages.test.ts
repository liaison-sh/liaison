// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A mailbox reset (or a new keyring opened with the user's own secret) must drop
// the messages this tab already loaded. They are sealed to the OLD keys; left in
// memory, the next unlock's integrity check tried them with the NEW key, they
// did not open, and the user's own reset raised the persistent "this mailbox
// failed its encryption check" alarm, naming message ids the reset had deleted.
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  loadedMailMessageIds,
  loadMessages,
  resetMailMessageStore,
} from "~/modules/mail/mail-message-store"
import { forgetMailboxIntegrityState } from "~/modules/mailbox/device-state"

const OLD_ROW = "efb62cba-c15d-462b-86ae-9da741b4c0d9"

function apiWithOneMessage() {
  return {
    get: vi.fn(async () => ({
      conversation: { id: "conv-1", accountId: "acc-1", subject: "s" },
      messages: [{ id: OLD_ROW, conversationId: "conv-1", encVersion: 1, encKeyId: 1 }],
      nextMessageCursor: null,
    })),
  }
}

beforeEach(() => {
  resetMailMessageStore()
})

describe("forgetMailboxIntegrityState", () => {
  it("drops the messages loaded under the old keys", async () => {
    await loadMessages(apiWithOneMessage() as never, "conv-1")
    expect(loadedMailMessageIds(), "non-vacuity: a message is loaded").toContain(OLD_ROW)

    await forgetMailboxIntegrityState("user-1")

    expect(loadedMailMessageIds()).toEqual([])
  })
})
