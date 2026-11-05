// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Approving a gated mail send from a sealed mailbox posts the decrypted draft
// and the decrypted bytes of every attachment, base64, in the decide body
// (mailbox-fulfilment.ts). Prod: every such approve carrying a real attachment
// (a shipping label PDF) was refused 413 in 1 ms by the generic 1 MiB API body
// cap, before the route ever ran. The app below is assembled from app.ts's own
// exported middleware, so the cap in front of the stub is the production one.
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { type AppEnv, apiBodyLimitMiddleware } from "~/app"
import { errorHandler } from "~/middleware/error-handler"
import {
  APPROVAL_DECIDE_BODY_MAX_BYTES,
  MAILBOX_FULFILMENT_MAX_ATTACHMENT_BYTES,
} from "~/modules/approvals/mailbox-fulfilment"

const stack = new Hono<AppEnv>()
stack.use("/api/*", apiBodyLimitMiddleware)
stack.onError(errorHandler)
stack.post("/api/approvals/:id/decide", async (c) => {
  const body = await c.req.json()
  return c.json({ data: { received: JSON.stringify(body).length } })
})
stack.post("/api/approvals/:id/payload", async (c) => {
  await c.req.json()
  return c.json({ data: { ok: true } })
})

const ID = "00000000-0000-4000-8000-000000072001"

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    stack.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

/** A sealed send's approve body carrying `bytes` of decrypted attachment. */
function sealedApprove(bytes: number) {
  return {
    decision: "approve",
    payloadHash: "h",
    mailboxFulfilment: {
      draft: { subject: "Your shipping label", textBody: "Hello, label attached." },
      attachments: {
        "00000000-0000-4000-8000-000000072002": Buffer.alloc(bytes, 7).toString("base64"),
      },
    },
  }
}

describe("POST /api/approvals/:id/decide body limit", () => {
  it("lets a sealed send's approve through with a multi-megabyte attachment", async () => {
    const response = await post(`/api/approvals/${ID}/decide`, sealedApprove(3 * 1024 * 1024))
    expect(response.status).toBe(200)
  })

  it("lets the fulfilment's own attachment ceiling through, base64 encoded", async () => {
    const response = await post(
      `/api/approvals/${ID}/decide`,
      sealedApprove(MAILBOX_FULFILMENT_MAX_ATTACHMENT_BYTES),
    )
    expect(response.status).toBe(200)
  })

  it("still refuses a body past the decide cap, with the JSON 413 envelope", async () => {
    const response = await post(`/api/approvals/${ID}/decide`, {
      decision: "approve",
      padding: "x".repeat(APPROVAL_DECIDE_BODY_MAX_BYTES + 1),
    })
    expect(response.status).toBe(413)
  })

  it("keeps the generic 1 MiB cap on the other approval routes", async () => {
    const response = await post(`/api/approvals/${ID}/payload`, {
      fields: { body: "x".repeat(2 * 1024 * 1024) },
    })
    expect(response.status).toBe(413)
  })
})
