// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Meta's client-class rejections (throttle, missing permission, bad parameter)
// are expected upstream answers. Through the handler barrel they must leave the
// sandbox as a ToolError (safe message, stable code, retryable flag, 4xx status)
// so the kernel logs them at warn and the caller sees Meta's reason. A bare
// Error is logged at error level and pages the watchdog.

import { describe, expect, it } from "bun:test"
import * as handlers from "./handlers"
import { MetaApiError } from "./lib/meta-client"
import { settingsFor } from "./test-connections.testutil"

type Handler = (params: Record<string, unknown>, ctx: unknown) => Promise<unknown>

function ctxAnswering(status: number, body: unknown) {
  return {
    connections: {
      meta: {
        getSettings: async () => settingsFor("meta", { accessToken: "t", adAccountId: "act_1" }),
      },
    },
    fetch: async () => ({ status, headers: {}, body: JSON.stringify(body) }),
  }
}

async function thrown(tool: string, params: Record<string, unknown>, ctx: unknown) {
  const fn = (handlers as unknown as Record<string, Handler>)[tool]!
  return fn(params, ctx).then(
    () => {
      throw new Error("expected a throw")
    },
    (e: unknown) => e as Record<string, unknown>,
  )
}

describe("Meta 4xx answers cross the sandbox as ToolError, not a bare Error", () => {
  it("insights throttle (#80000) -> meta_rate_limited, retryable, status 429", async () => {
    const ctx = ctxAnswering(400, {
      error: { code: 80000, error_subcode: 2446079, message: "Too many calls", fbtrace_id: "FB" },
    })
    const err = await thrown("insights_query", { level: "account", date_preset: "last_7d" }, ctx)
    expect(err.name).toBe("ToolError")
    expect(err.safe).toBe(true)
    expect(err.code).toBe("meta_rate_limited")
    expect(err.retryable).toBe(true)
    expect(err.status).toBe(429)
    // One sentence for the person, then the agent's next step and Meta's reason.
    expect(err.message).toBe(
      "Meta is limiting requests right now. Try again in a few minutes. Next step: wait a few minutes, " +
        "then retry the same call. Meta said: Too many calls. Meta trace id: FB.",
    )
  })

  it("#10 permission -> meta_permission_denied, not retryable, with Meta's reason", async () => {
    const ctx = ctxAnswering(403, {
      error: { code: 10, message: "(#10) Application does not have permission for this action" },
    })
    const err = await thrown("graph_get", { path: "/act_1/transactions" }, ctx)
    expect(err.name).toBe("ToolError")
    expect(err.code).toBe("meta_permission_denied")
    expect(err.retryable).toBe(false)
    expect(err.status).toBe(403)
    expect(err.message).toBe(
      "Meta did not allow this request: (#10) Application does not have permission for this action. " +
        "The Meta app may be missing a permission. Next step: do not retry; use a named ads tool instead, " +
        "or ask an admin to grant the permission to the Meta app.",
    )
  })

  it("#100 nonexisting field -> meta_invalid_request", async () => {
    const ctx = ctxAnswering(400, {
      error: { code: 100, message: "(#100) Tried accessing nonexisting field (transactions)" },
    })
    const err = await thrown("graph_get", { path: "/act_1", fields: "transactions" }, ctx)
    expect(err.name).toBe("ToolError")
    expect(err.code).toBe("meta_invalid_request")
    expect(err.status).toBe(400)
    expect(err.message).toBe(
      "Meta rejected this request: (#100) Tried accessing nonexisting field (transactions). " +
        "Next step: do not retry as is; change the path, fields or parameters.",
    )
  })

  it("a Meta 5xx is not reclassified: it still propagates as a MetaApiError", async () => {
    const ctx = ctxAnswering(500, {
      error: { code: 2, message: "Service temporarily unavailable" },
    })
    const err = await thrown("graph_get", { path: "/act_1" }, ctx)
    expect(err).toBeInstanceOf(MetaApiError)
    expect(err.name).not.toBe("ToolError")
  })
})

describe("no dash punctuation in the Meta outcome copy", () => {
  it("none of the four messages carries an em dash, en dash or double hyphen", async () => {
    const cases: Array<[number, unknown]> = [
      [400, { error: { code: 17, message: "throttled" } }],
      [403, { error: { code: 10, message: "denied" } }],
      [400, { error: { code: 100, message: "bad field" } }],
      [400, { error: { code: 190, message: "expired" } }],
    ]
    for (const [status, body] of cases) {
      const err = await thrown("graph_get", { path: "/act_1" }, ctxAnswering(status, body))
      expect(String(err.message)).not.toMatch(/\u2014|\u2013|--/)
    }
  })
})
