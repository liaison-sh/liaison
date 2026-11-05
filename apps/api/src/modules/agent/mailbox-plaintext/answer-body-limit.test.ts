// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A browser answers an agent's mailbox read by posting the decrypted bodies of
// the messages it opened. Prod: a ten-message read with full bodies was refused
// 413 by the generic 1 MiB API body cap before the route ran, and the agent told
// the user the mailbox was locked. The app below is assembled from app.ts's own
// exported middleware, so the cap in front of the stub is the production one.
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { type AppEnv, apiBodyLimitMiddleware } from "~/app"
import { errorHandler } from "~/middleware/error-handler"
import {
  MAILBOX_ANSWER_BODY_MAX_BYTES,
  MAILBOX_ATTACHMENT_MAX_BYTES,
} from "~/modules/agent/mailbox-plaintext/answer-limits"
import { INTERNAL_MAX_BODY_BYTES } from "~/modules/agent/mailbox-plaintext/mailbox-forward"

const stack = new Hono<AppEnv>()
stack.use("/api/*", apiBodyLimitMiddleware)
stack.onError(errorHandler)
stack.post("/api/agent/mailbox-plaintext/:id", async (c) => {
  const body = await c.req.json()
  return c.json({ data: { received: JSON.stringify(body).length } })
})
stack.post("/api/agent/mailbox-search/:id", async (c) => {
  await c.req.json()
  return c.json({ data: { ok: true } })
})
stack.post("/api/agent/other", async (c) => {
  await c.req.json()
  return c.json({ data: { ok: true } })
})

const ID = "00000000-0000-4000-8000-000000073001:00000000-0000-4000-8000-000000073002"

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    stack.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

/** A read answer of `count` messages, each with `bodyBytes` of HTML. */
function readAnswer(count: number, bodyBytes: number) {
  return {
    turnNonce: "n",
    items: Array.from({ length: count }, (_, i) => ({
      messageId: `m${i}`,
      subject: "Re: order",
      textBody: "t".repeat(Math.floor(bodyBytes / 4)),
      htmlBody: "h".repeat(bodyBytes),
    })),
    undecryptable: [],
  }
}

describe("mailbox answer body limit", () => {
  it("lets a ten-message read with full bodies through (over the generic 1 MiB cap)", async () => {
    const res = await post(`/api/agent/mailbox-plaintext/${ID}`, readAnswer(10, 300 * 1024))
    expect(res.status).toBe(200)
  })

  it("lets a conversion answer with multi-megabyte attachment bytes through", async () => {
    const answer = {
      turnNonce: "n",
      items: [
        { messageId: "m0", bytesBase64: Buffer.alloc(8 * 1024 * 1024, 7).toString("base64") },
      ],
      consented: true,
    }
    const res = await post(`/api/agent/mailbox-plaintext/${ID}`, answer)
    expect(res.status).toBe(200)
  })

  it("lets one attachment at the 25 MiB read cap through, base64 encoded", async () => {
    const answer = {
      turnNonce: "n",
      items: [
        {
          messageId: "00000000-0000-4000-8000-000000073003",
          bytesBase64: Buffer.alloc(MAILBOX_ATTACHMENT_MAX_BYTES, 7).toString("base64"),
        },
      ],
      undecryptable: [],
      turnOwner: true,
    }
    const res = await post(`/api/agent/mailbox-plaintext/${ID}`, answer)
    expect(res.status).toBe(200)
  })

  it("covers the search answer route too", async () => {
    const res = await post(`/api/agent/mailbox-search/${ID}`, {
      turnNonce: "n",
      messageIds: Array.from({ length: 500 }, (_, i) => `id-${i}-${"x".repeat(150)}`),
      padding: "p".repeat(1024 * 1024),
    })
    expect(res.status).toBe(200)
  })

  it("still refuses an answer over its own ceiling", async () => {
    const res = await post(`/api/agent/mailbox-plaintext/${ID}`, {
      turnNonce: "n",
      items: [{ messageId: "m0", htmlBody: "h".repeat(MAILBOX_ANSWER_BODY_MAX_BYTES + 1024) }],
    })
    expect(res.status).toBe(413)
  })

  it("keeps the generic 1 MiB cap on other agent routes", async () => {
    const res = await post("/api/agent/other", { padding: "p".repeat(2 * 1024 * 1024) })
    expect(res.status).toBe(413)
  })

  it("forwards any answer the public route accepted", () => {
    expect(INTERNAL_MAX_BODY_BYTES).toBeGreaterThan(MAILBOX_ANSWER_BODY_MAX_BYTES)
  })
})
