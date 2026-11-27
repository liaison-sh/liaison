// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { EmailRateLimitError, ResendEmailProvider } from "./email"

describe("ResendEmailProvider", () => {
  it("posts to /emails with Idempotency-Key header and reply_to", async () => {
    const calls: { url: string; init: any }[] = []
    const provider = new ResendEmailProvider({
      apiKey: "re_x",
      from: "Liaison <a@b.test>",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response(JSON.stringify({ id: "em_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })
    await provider.send({
      to: "x@y.test",
      subject: "s",
      html: "<p>h</p>",
      text: "h",
      replyTo: "r@y.test",
      idempotencyKey: "k-1",
    })
    expect(calls[0].url).toBe("https://api.resend.com/emails")
    expect(calls[0].init.headers["Idempotency-Key"]).toBe("k-1")
    expect(calls[0].init.headers.Authorization).toBe("Bearer re_x")
    const body = JSON.parse(calls[0].init.body)
    expect(body.reply_to).toBe("r@y.test")
    expect(body.from).toBe("Liaison <a@b.test>")
    expect(body.to).toBe("x@y.test")
  })

  it("sends an inline image with its content_id, a plain attachment without", async () => {
    const calls: { init: any }[] = []
    const provider = new ResendEmailProvider({
      apiKey: "re_x",
      from: "a@b.test",
      fetch: async (_url, init) => {
        calls.push({ init })
        return new Response(JSON.stringify({ id: "em_3" }), { status: 200 })
      },
    })
    await provider.send({
      to: "x@y.test",
      subject: "s",
      html: '<img src="cid:logo">',
      attachments: [
        { filename: "a.pdf", contentType: "application/pdf", content: new Uint8Array([1]) },
        {
          filename: "logo.png",
          contentType: "image/png",
          content: new Uint8Array([2]),
          contentId: "logo",
        },
      ],
    })
    const body = JSON.parse(calls[0].init.body)
    expect(body.attachments[0].content_id).toBeUndefined()
    expect(body.attachments[1].content_id).toBe("logo")
  })

  it("omits Idempotency-Key header when not provided", async () => {
    const calls: { init: any }[] = []
    const provider = new ResendEmailProvider({
      apiKey: "re_x",
      from: "a@b.test",
      fetch: async (_url, init) => {
        calls.push({ init })
        return new Response(JSON.stringify({ id: "em_2" }), { status: 200 })
      },
    })
    await provider.send({ to: "x@y", subject: "s", html: "<p>h</p>" })
    expect(calls[0].init.headers["Idempotency-Key"]).toBeUndefined()
  })

  it("throws EmailRateLimitError with retryAfterMs from Retry-After header on 429", async () => {
    const provider = new ResendEmailProvider({
      apiKey: "re_x",
      from: "a@b.test",
      fetch: async () =>
        new Response("rate limited", { status: 429, headers: { "Retry-After": "30" } }),
    })
    let caught: unknown
    try {
      await provider.send({ to: "x@y", subject: "s", html: "<p>h</p>" })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EmailRateLimitError)
    expect((caught as EmailRateLimitError).retryAfterMs).toBe(30_000)
  })

  it("verify() returns true on 200 from /domains", async () => {
    const provider = new ResendEmailProvider({
      apiKey: "re_x",
      from: "a@b.test",
      fetch: async () => new Response("{}", { status: 200 }),
    })
    expect(await provider.verify()).toBe(true)
  })

  it("verify() returns false on 401 from /domains", async () => {
    const provider = new ResendEmailProvider({
      apiKey: "re_x",
      from: "a@b.test",
      fetch: async () => new Response("unauth", { status: 401 }),
    })
    expect(await provider.verify()).toBe(false)
  })
})
