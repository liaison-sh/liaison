// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The persisted and streamed copy of a mail tool result is redacted to ids and
// a length. A read the broker refused because the mailbox was locked must keep
// that one fact, so the chat can put an Unlock button under the turn. Pure: no
// database, unlike the Invariant K suite next to this file.
import { describe, expect, it } from "bun:test"
import { redactMailPlaintextResult } from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import { MAILBOX_LOCKED } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"

describe("mail plaintext redaction: the locked mailbox marker", () => {
  it("keeps the locked status, and only the status, of a refused read", () => {
    const out = redactMailPlaintextResult({
      needsPlaintext: { requestKind: "mail.read", messageIds: ["m1"], purpose: "x" },
      messages: [{ id: "m1", textBody: "secret words" }],
      mailbox: { status: MAILBOX_LOCKED, message: "the mailbox is locked" },
    })
    expect(out.mailbox).toEqual({ status: "MAILBOX_LOCKED" })
    expect(JSON.stringify(out)).not.toContain("secret words")
    expect(JSON.stringify(out)).not.toContain("the mailbox is locked")
  })

  it("adds no marker to a result the broker did not refuse", () => {
    const out = redactMailPlaintextResult({ messages: [{ id: "m1", textBody: "hello" }] })
    expect(out.mailbox).toBeUndefined()
  })

  it("tells the model to point at the Unlock button, not at another screen", async () => {
    const { fulfilMailboxMarker } = await import(
      "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
    )
    const out = await fulfilMailboxMarker({
      result: { needsPlaintext: { requestKind: "mail.read", messageIds: ["m1"], purpose: "x" } },
      orgId: "44444444-4444-4444-4444-444444444444",
      userId: "55555555-5555-5555-5555-555555555555",
      threadId: "66666666-6666-6666-6666-666666666666",
      frame: { runId: "run-1", rootRunId: "run-1", mailboxTurnNonce: "nonce-a" } as never,
      deps: { getUnlock: async () => ({ unlocked: false }) } as never,
    })
    const message = (out.result as { mailbox: { message: string } }).mailbox.message
    expect(message).toContain("Unlock below your reply")
    expect(message).not.toContain("mail view")
  })
})
