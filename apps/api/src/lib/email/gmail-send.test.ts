// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { setupGmailMocks } from "~/tests/fixtures/email/msw-gmail"
import { GmailSendError, sendViaGmail } from "./gmail-send"

let mocks: ReturnType<typeof setupGmailMocks>

beforeEach(() => {
  mocks = setupGmailMocks([])
  mocks.start()
})

afterEach(() => {
  mocks.stop()
})

const ctx = {
  connections_getToken: async () => "tok",
}

describe("sendViaGmail", () => {
  it("POSTs raw base64url body and returns providerId", async () => {
    mocks.queue("messages.send", { id: "g1", threadId: "t1" })
    const r = await sendViaGmail(
      ctx,
      "support@x.test",
      "From: a@x.test\r\nTo: b@y.test\r\nSubject: Hi\r\n\r\nbody",
    )
    expect(r.providerId).toBe("g1")
    expect(r.threadId).toBe("t1")
    const requests = mocks.requests()
    const sendReq = requests.find((r) => r.route === "messages.send")
    expect(sendReq).toBeDefined()
    expect((sendReq!.body as { raw: string }).raw).toBeDefined()
  })

  // Regression (prod, org-wide from 2026-07-27): Gmail REWRITES the Message-ID we
  // render, so persisting ours made the ticket mailbox sync's dedupe (an exact
  // external_message_id match) miss and store our own Sent copy as a duplicate
  // outbound message. The delivered id is only knowable by reading it back.
  it("reads back the DELIVERED rfc822 Message-ID after sending", async () => {
    mocks.queue("messages.send", { id: "g-del", threadId: "t-del" })
    mocks.queue("messages.get", {
      id: "g-del",
      payload: { headers: [{ name: "Message-ID", value: "<real-delivered@mail.gmail.com>" }] },
    })
    const r = await sendViaGmail(ctx, "support@x.test", "From: a@x.test\r\n\r\nx")
    expect(r.rfc822MessageId).toBe("<real-delivered@mail.gmail.com>")
    // NOT the internal id: that never appears in a mail header.
    expect(r.rfc822MessageId).not.toBe(r.providerId)
  })

  it("matches the Message-ID header case-insensitively", async () => {
    mocks.queue("messages.send", { id: "g-ci", threadId: "t" })
    mocks.queue("messages.get", {
      id: "g-ci",
      payload: { headers: [{ name: "message-id", value: "<lower@mail.gmail.com>" }] },
    })
    const r = await sendViaGmail(ctx, "support@x.test", "From: a@x.test\r\n\r\nx")
    expect(r.rfc822MessageId).toBe("<lower@mail.gmail.com>")
  })

  // The read-back is best effort: the send already succeeded, so a failure here
  // must degrade to the synthetic id, never fail the send.
  it("still returns a successful send when the Message-ID read-back fails", async () => {
    mocks.queue("messages.send", { id: "g-nofetch", threadId: "t" })
    mocks.injectFailure("messages.get", { kind: "5xx" })
    const r = await sendViaGmail(ctx, "support@x.test", "From: a@x.test\r\n\r\nx")
    expect(r.providerId).toBe("g-nofetch")
    expect(r.rfc822MessageId).toBeUndefined()
  })

  it("returns undefined rather than an empty string when the header is absent", async () => {
    mocks.queue("messages.send", { id: "g-nohdr", threadId: "t" })
    mocks.queue("messages.get", { id: "g-nohdr", payload: { headers: [] } })
    const r = await sendViaGmail(ctx, "support@x.test", "From: a@x.test\r\n\r\nx")
    expect(r.rfc822MessageId).toBeUndefined()
  })

  it("attaches threadId when provided", async () => {
    mocks.queue("messages.send", { id: "g2", threadId: "T-1" })
    await sendViaGmail(ctx, "support@x.test", "From: a@x.test\r\n\r\nx", "T-1")
    const sendReq = mocks.requests().find((r) => r.route === "messages.send")
    expect(sendReq).toBeDefined()
    expect((sendReq!.body as { threadId: string }).threadId).toBe("T-1")
  })

  it("throws GmailSendError with providerRejected=true on 4xx", async () => {
    mocks.injectFailure("messages.send", { kind: "401" })
    await expect(
      sendViaGmail(ctx, "support@x.test", "From: a@x.test\r\n\r\nx"),
    ).rejects.toMatchObject({ code: "GMAIL_SEND_FAILED", providerRejected: true, status: 401 })
  })

  it("throws with retryable hint on 5xx", async () => {
    mocks.injectFailure("messages.send", { kind: "5xx", status: 503 })
    try {
      await sendViaGmail(ctx, "support@x.test", "From: a@x.test\r\n\r\nx")
      throw new Error("expected to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(GmailSendError)
      const e = err as GmailSendError
      expect(e.providerRejected).toBe(false)
      expect(e.status).toBe(503)
    }
  })
})
