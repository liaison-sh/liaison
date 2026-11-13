// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { OUT_OF_CREDITS_CODE, PAYMENT_REQUIRED_CODE } from "@liaison/shared"
import { z } from "zod"
import { app } from "~/app"
import { sql } from "~/db"
import * as eventBus from "~/infra/events/event-bus"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { CREDIT_PRICING_MISSING_MESSAGE } from "~/modules/agent/credits/credit-cost"
import * as creditMeter from "~/modules/agent/credits/credit-meter"
import { toolRegistry } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { clearOrgBillingStatusCache } from "~/modules/cloud/billing-status"
import { PaymentRequiredError } from "~/modules/cloud/suspension"
import { reportAgentTurnFailure } from "~/modules/threads/agent-dispatch-guard"
import { clearTestCreditPricing, setTestCreditPricing } from "~/tests/helpers/credit-pricing"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const ORG_ID = "00000000-0000-4000-8000-000000af0001"
const USER_ID = "00000000-0000-4000-8000-000000af0002"
const THREAD_ID = "00000000-0000-4000-8000-000000af0003"

/** Parse a raw SSE text body into an array of { event, data } objects. */
function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = []
  const blocks = body.split("\n\n").filter((b) => b.trim())
  for (const block of blocks) {
    const lines = block.split("\n")
    let event = "message"
    let dataStr = ""
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7).trim()
      else if (line.startsWith("data: ")) dataStr = line.slice(6).trim()
    }
    try {
      events.push({ event, data: JSON.parse(dataStr) })
    } catch {
      events.push({ event, data: dataStr })
    }
  }
  return events
}

describe("agent integration", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    // Agent billing (deduction, 402) is managed-edition behaviour — exercise it.
    _setEdition("managed")
    // A managed cell meters nothing without a pushed rate.
    await setTestCreditPricing()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'IntegrationOrg', 'integration-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'integration@test.com', 'Int User')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'int-agent-chat', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '5.00000000', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter') ON CONFLICT DO NOTHING`

    // Register a test tool for the integration org
    toolRegistry.set([ORG_ID, "test", "listItems"], {
      appName: "test",
      name: "listItems",
      description: "List test items",
      requiredScopes: ["test:items:read"],
      handler: async () => [{ id: "1", title: "Item 1" }],
      params: z.object({ status: z.string().optional() }),
    })

    token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Int User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await clearTestCreditPricing()
    _setEdition(null)
    toolRegistry.deleteByPrefix([ORG_ID])
    await releaseTestLock()
  })

  it("returns SSE stream with message-start event containing userMessageId", async () => {
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ threadId: THREAD_ID, content: "Hello integration test" }),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")

      const text = await res.text()

      expect(text).toContain("event: message-start")
      expect(text).toContain("userMessageId")

      // Verify user message persisted
      const msgs =
        await sql`SELECT * FROM kernel.messages WHERE thread_id = ${THREAD_ID} AND author_type = 'user' ORDER BY created_at DESC LIMIT 1`
      expect(msgs.length).toBeGreaterThanOrEqual(1)
      expect(msgs[0].content).toBe("Hello integration test")
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
    // Generous timeout: this consumes the full SSE stream, and the fake key makes
    // the provider call fail — usually fast (401/404) but occasionally via a
    // transient upstream 502 that the AI SDK retries with backoff (~7s). The test
    // only needs the stream to close, not a fast response. (Follow-up: inject a
    // mock provider so these don't depend on a real Anthropic round-trip.)
  }, 30_000)

  it("SSE error event from failed provider call does not emit a subsequent done event", async () => {
    // With a fake API key the provider call fails, producing an error event.
    // The corrected route must not also emit done after an error.
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-invalid-key-for-error-test"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ threadId: THREAD_ID, content: "Trigger provider error" }),
      })

      expect(res.status).toBe(200)
      const body = await res.text()
      const events = parseSseEvents(body)
      const eventNames = events.map((e) => e.event)

      // message-start must always be first
      expect(eventNames[0]).toBe("message-start")

      // If there is an error event, done must not appear after it
      const errorIdx = eventNames.lastIndexOf("error")
      const doneIdx = eventNames.indexOf("done")
      if (errorIdx !== -1) {
        // done must not exist, or must appear before the error (impossible in practice — just assert no done after error)
        expect(doneIdx === -1 || doneIdx < errorIdx).toBe(true)
      }
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
    // Generous timeout — see the note on the prior test (full SSE stream +
    // fake-key provider failure that may retry a transient upstream 502).
  }, 30_000)

  it("SSE stream with null modelId (Auto mode) is accepted", async () => {
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        // null modelId should be accepted by the schema (Auto mode)
        body: JSON.stringify({ threadId: THREAD_ID, content: "Auto mode test", modelId: null }),
      })

      // Should not be 400 (schema validation failure)
      expect(res.status).not.toBe(400)
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("persists system message and returns 402 when credits exhausted", async () => {
    const zeroOrgId = "00000000-0000-4000-8000-000000af0004"
    const zeroUserId = "00000000-0000-4000-8000-000000af0005"
    const zeroThreadId = "00000000-0000-4000-8000-000000af0006"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${zeroOrgId}, 'ZeroIntOrg', 'zero-int-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${zeroUserId}, ${zeroOrgId}, 'zero-int@test.com', 'Zero Int User')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${zeroThreadId}, ${zeroOrgId}, 'zero-int-chat', 'agent_chat', ${zeroUserId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${zeroThreadId}, ${zeroUserId}, ${zeroOrgId})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${zeroOrgId}, '0.00000000', '0.00000000', 'EUR')`

    const zeroToken = await signAccessToken(
      {
        userId: zeroUserId,
        orgId: zeroOrgId,
        name: "Zero",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${zeroToken}`,
        },
        body: JSON.stringify({ threadId: zeroThreadId, content: "Hello" }),
      })

      expect(res.status).toBe(402)

      // System message should be persisted in thread (402 = billing failure, user should know)
      const msgs =
        await sql`SELECT * FROM kernel.messages WHERE thread_id = ${zeroThreadId} AND author_type = 'system'`
      expect(msgs.length).toBeGreaterThanOrEqual(1)
      expect(msgs[0].content).toContain("usage")
      // Coded, so the client links the refusal to Billing (MessageRow).
      expect(msgs[0].metadata?.billingRefusal).toBe(OUT_OF_CREDITS_CODE)
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  describe("a managed refusal keeps its own reason", () => {
    let n = 0
    // A fresh org with credits left, one refused turn through the real route.
    const refusedTurn = async (
      setUp: (orgId: string) => Promise<void> | void = () => {},
      balance = "5.00000000",
    ) => {
      n += 1
      const suffix = String(n).padStart(4, "0")
      const orgId = `00000000-0000-4000-8000-0000af31${suffix}`
      const userId = `00000000-0000-4000-8000-0000af32${suffix}`
      const threadId = `00000000-0000-4000-8000-0000af33${suffix}`
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, ${`Refusal ${n}`}, ${`refusal-${n}`})`
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${userId}, ${orgId}, ${`refusal-${n}@test.com`}, 'Refusal User')`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${threadId}, ${orgId}, ${`refusal-chat-${n}`}, 'agent_chat', ${userId})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${userId}, ${orgId})`
      await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${orgId}, ${balance}, '0.00000000', 'EUR')`
      await setUp(orgId)
      const bearer = await signAccessToken(
        {
          userId,
          orgId,
          name: "Refusal",
          authVersion: 1,
          permissionVersion: 1,
          scopes: ["*"],
          dimensionGrants: {},
        },
        env.JWT_SECRET,
      )
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        const res = await app.request("/api/agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
          body: JSON.stringify({ threadId, content: "Hello" }),
        })
        const rows = await sql<{ content: string; metadata: Record<string, unknown> | null }[]>`
          SELECT content, metadata FROM kernel.messages
          WHERE thread_id = ${threadId} AND author_type = 'system'`
        expect(rows).toHaveLength(1)
        return { status: res.status, row: rows[0]! }
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    }
    const notOutOfCredits = (row: {
      content: string
      metadata: Record<string, unknown> | null
    }) => {
      expect(row.metadata?.turnRefusal).toBe(true)
      // Names the message it refused, so later turns leave it out of the replay.
      expect(typeof row.metadata?.refusedMessageId).toBe("string")
      expect(row.metadata?.billingRefusal).toBeUndefined()
    }

    it("zero balance: says out of credits, and links to Billing", async () => {
      const { status, row } = await refusedTurn(undefined, "0.00000000")
      expect(status).toBe(402)
      expect(row.metadata?.billingRefusal).toBe(OUT_OF_CREDITS_CODE)
    })

    it("deduction breaker open: the billing issue, not a request to pay", async () => {
      const { status, row } = await refusedTurn(async (orgId) => {
        await redis.set(`agent:credit-deduct-fail:${orgId}`, "3", "EX", 60)
      })
      expect(status).toBe(402)
      expect(row.content).toContain("billing system issue")
      notOutOfCredits(row)
    })

    it("no pushed credit rate: the outage, not a request to pay", async () => {
      await clearTestCreditPricing()
      try {
        const { row } = await refusedTurn()
        expect(row.content).toBe(CREDIT_PRICING_MISSING_MESSAGE)
        notOutOfCredits(row)
      } finally {
        await setTestCreditPricing()
      }
    })

    it.each([
      ["no model Auto can run", "Every model is switched off for this organization."],
      ["an unpriced model on the platform key", "This model has no fixed price."],
    ])("%s: the row says so", async (_name, reason) => {
      const spy = spyOn(creditMeter, "preCheck").mockResolvedValue({
        allowed: false,
        status: 400,
        persistSystemMessage: true,
        reason,
      })
      try {
        const { status, row } = await refusedTurn()
        expect(status).toBe(400)
        expect(row.content).toBe(reason)
        notOutOfCredits(row)
      } finally {
        spy.mockRestore()
      }
    })
  })

  // A turn whose model is not available to the org runs on the org's Auto
  // model instead of failing (AI models spec S4 and A6; resolveModelForPreCheck
  // with `turn: true` in credit-meter.ts).
  it("an unknown model runs the turn on Auto: no 400, no system message persisted", async () => {
    const modelOrgId = "00000000-0000-4000-8000-000000af0008"
    const modelUserId = "00000000-0000-4000-8000-000000af0009"
    const modelThreadId = "00000000-0000-4000-8000-000000af0010"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${modelOrgId}, 'ModelOrg', 'model-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${modelUserId}, ${modelOrgId}, 'model@test.com', 'Model User')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${modelThreadId}, ${modelOrgId}, 'model-chat', 'agent_chat', ${modelUserId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${modelThreadId}, ${modelUserId}, ${modelOrgId})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${modelOrgId}, '5.00000000', '0.00000000', 'EUR')`

    const modelToken = await signAccessToken(
      {
        userId: modelUserId,
        orgId: modelOrgId,
        name: "Model",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${modelToken}`,
        },
        body: JSON.stringify({
          threadId: modelThreadId,
          content: "Hello",
          modelId: "nonexistent-model-xyz",
        }),
      })

      // The turn is admitted (on Auto), not refused as an unknown model.
      expect(res.status).toBe(200)
      await res.text()

      // No model error was written to the thread as a system message.
      const sysMsgs =
        await sql`SELECT * FROM kernel.messages WHERE thread_id = ${modelThreadId} AND author_type = 'system'`
      expect(sysMsgs.length).toBe(0)
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("user not participant returns 403", async () => {
    const otherUserId = "00000000-0000-4000-8000-000000af0007"
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${otherUserId}, ${ORG_ID}, 'other-int@test.com', 'Other Int User')`

    const otherToken = await signAccessToken(
      {
        userId: otherUserId,
        orgId: ORG_ID,
        name: "Other",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${otherToken}`,
        },
        body: JSON.stringify({ threadId: THREAD_ID, content: "Should fail" }),
      })

      expect(res.status).toBe(403)
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("user without kernel:threads:write scope is rejected with 403", async () => {
    const readOnlyToken = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Int User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read"], // lacks write scope
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${readOnlyToken}`,
        },
        body: JSON.stringify({ threadId: THREAD_ID, content: "Should be blocked" }),
      })

      expect(res.status).toBe(403)
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("credit_transactions table is queryable after agent runs", async () => {
    const txns =
      await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${ORG_ID} LIMIT 10`
    expect(Array.isArray(txns)).toBe(true)
  })

  // an unpaid renewal refuses the turn with 402 payment_required (never a
  // 500), says so in the thread with the code on the system row, and the
  // thread path's Failed frame carries the code, so the client offers Billing.
  it("an unpaid renewal: 402 payment_required, coded system row and stream frame", async () => {
    const orgId = "00000000-0000-4000-8000-000000af0007"
    const userId = "00000000-0000-4000-8000-000000af0008"
    const threadId = "00000000-0000-4000-8000-000000af0009"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'PastDueOrg', 'past-due-int-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${userId}, ${orgId}, 'past-due@test.com', 'Past Due')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${threadId}, ${orgId}, 'past-due-chat', 'agent_chat', ${userId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${userId}, ${orgId})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${orgId}, '10.00000000', '0.00000000', 'EUR')`
    await sql`INSERT INTO kernel.org_billing_state
      (org_id, version, plan, status, period_end, included_credits, caps, auto_top_up)
      VALUES (${orgId}, 1, 'base', 'past_due', now() + interval '20 days', 100, '{}'::jsonb,
        ${JSON.stringify({ enabled: false, thresholdCredits: 10, amountCredits: 50 })}::jsonb)`
    clearOrgBillingStatusCache()
    const pastDueToken = await signAccessToken(
      {
        userId,
        orgId,
        name: "Past Due",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${pastDueToken}` },
        body: JSON.stringify({ threadId, content: "Hello" }),
      })
      expect(res.status).toBe(402)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe(PAYMENT_REQUIRED_CODE)
      const rows = await sql<{ metadata: Record<string, unknown> | null }[]>`
        SELECT metadata FROM kernel.messages WHERE thread_id = ${threadId} AND author_type = 'system'`
      expect(rows.length).toBeGreaterThanOrEqual(1)
      for (const r of rows) expect(r.metadata?.billingRefusal).toBe(PAYMENT_REQUIRED_CODE)

      const frames: Array<Record<string, unknown>> = []
      const spy = spyOn(eventBus, "broadcastEphemeral").mockImplementation((async (e: {
        data: Record<string, unknown>
      }) => {
        frames.push(e.data)
      }) as never)
      try {
        await reportAgentTurnFailure({
          orgId,
          threadId,
          actorUserId: userId,
          agentId: null,
          error: new PaymentRequiredError(),
        })
      } finally {
        spy.mockRestore()
      }
      expect(frames).toHaveLength(1)
      expect(frames[0]?.code).toBe(PAYMENT_REQUIRED_CODE)
    } finally {
      await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${orgId}`
      clearOrgBillingStatusCache()
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })
})
