// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { setupGmailMocks } from "~/tests/fixtures/email/msw-gmail"
import { OutboundError, sendOutbound } from "./send"

const baseEmail = {
  from: { email: "support@org.test", name: "Acme" },
  replyTo: { email: "support+tkt_x@org.test", name: "Acme" },
  to: [{ email: "alice@cust.test" }],
  cc: [],
  subject: "Re: Hello",
  html: "<p>hi</p>",
  text: "hi",
  headers: { messageId: "<m1@org.test>" },
}

describe("sendOutbound — Gmail", () => {
  let mocks: ReturnType<typeof setupGmailMocks>

  beforeEach(() => {
    mocks = setupGmailMocks([])
    mocks.start()
  })
  afterEach(() => mocks.stop())

  it("delivers via Gmail and returns rfc2822 + delivered state", async () => {
    mocks.queue("messages.send", { id: "g1", threadId: "T-1" })
    const r = await sendOutbound(
      baseEmail,
      { kind: "gmail", ctx: { connections_getToken: async () => "tok" } },
      { accountEmail: "support@org.test" },
    )
    expect(r.deliveryState).toBe("delivered")
    expect(r.externalThreadId).toBe("T-1")
    expect(r.rfc2822).toContain("Subject: Re: Hello")
  })

  it("throws OutboundError(rejected) on 4xx provider rejection", async () => {
    mocks.injectFailure("messages.send", { kind: "401" })
    await expect(
      sendOutbound(
        baseEmail,
        { kind: "gmail", ctx: { connections_getToken: async () => "tok" } },
        { accountEmail: "support@org.test" },
      ),
    ).rejects.toMatchObject({ reason: "rejected" })
  })

  it("throws OutboundError(preflight_failed) on 5xx (retryable)", async () => {
    mocks.injectFailure("messages.send", { kind: "5xx", status: 503 })
    try {
      await sendOutbound(
        baseEmail,
        { kind: "gmail", ctx: { connections_getToken: async () => "tok" } },
        { accountEmail: "support@org.test" },
      )
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(OutboundError)
      expect((err as OutboundError).reason).toBe("preflight_failed")
      expect((err as OutboundError).retryable).toBe(true)
    }
  })

  it("preflight failure short-circuits", async () => {
    await expect(
      sendOutbound(
        baseEmail,
        { kind: "gmail", ctx: { connections_getToken: async () => "tok" } },
        {
          accountEmail: "support@org.test",
          preflight: async () => {
            throw new Error("preflight nope")
          },
        },
      ),
    ).rejects.toMatchObject({ reason: "preflight_failed" })
  })
})

describe("sendOutbound — SMTP", () => {
  it("delivers via SMTP and returns delivered state", async () => {
    const r = await sendOutbound(
      baseEmail,
      {
        kind: "smtp",
        smtpSend: async () => ({ messageId: "<smtp-1@org.test>", deliveryState: "delivered" }),
      },
      { accountEmail: "support@org.test" },
    )
    expect(r.deliveryState).toBe("delivered")
    expect(r.externalMessageId).toBe("<smtp-1@org.test>")
  })

  it("ambiguous SMTP outcome throws OutboundError(ambiguous)", async () => {
    await expect(
      sendOutbound(
        baseEmail,
        {
          kind: "smtp",
          smtpSend: async () => ({ messageId: "", deliveryState: "ambiguous" }),
        },
        { accountEmail: "support@org.test" },
      ),
    ).rejects.toMatchObject({ reason: "ambiguous" })
  })

  it("rejected SMTP outcome throws OutboundError(rejected)", async () => {
    await expect(
      sendOutbound(
        baseEmail,
        {
          kind: "smtp",
          smtpSend: async () => ({ messageId: "", deliveryState: "rejected" }),
        },
        { accountEmail: "support@org.test" },
      ),
    ).rejects.toMatchObject({ reason: "rejected" })
  })

  it("EAUTH error mapped to auth_failed", async () => {
    await expect(
      sendOutbound(
        baseEmail,
        {
          kind: "smtp",
          smtpSend: async () => {
            const e = new Error("auth nope") as Error & { code?: string }
            e.code = "EAUTH"
            throw e
          },
        },
        { accountEmail: "support@org.test" },
      ),
    ).rejects.toMatchObject({ reason: "auth_failed" })
  })
})
