// SPDX-License-Identifier: FSL-1.1-ALv2
// Agent scope-request loop — the headline UX proven end-to-end with a REAL
// (auto-mode) model. A blocked agent discovers the gap via
// `list_locked_capabilities`, asks the user, files a `request_scope` request,
// an admin approves through the real `/api/scope-requests/:id/decide` endpoint,
// the grant lands + bumps permissionVersion (old token 401s → re-login), and on
// the agent's NEXT turn the formerly-locked tool is visible, invoked, and works.
//
// Target capability = `tickets__search` (scope `tickets:tickets:read`), gated by
// SCOPE ONLY (not a human-approval gate) so the "succeeds" leg is unambiguous.

import { afterAll, beforeAll, expect, it } from "bun:test"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { createUserWithScopes, login } from "@liaison/test-helpers"
import { describeLive } from "./helpers/live-llm"
import { seedInbox, seedTicket, seedTicketMessages } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

interface SseEvent {
  event: string
  data: unknown
}

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = []
  for (const block of body.split("\n\n").filter((b) => b.trim())) {
    let event = "message"
    let dataStr = ""
    for (const line of block.split("\n")) {
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

async function consumeSse(
  url: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: SseEvent[]; rawBody: string }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const rawBody = await res.text()
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return {
      status: res.status,
      events: [{ event: "error", data: { code: "http_error", body: rawBody } }],
      rawBody,
    }
  }
  return { status: res.status, events: parseSseEvents(rawBody), rawBody }
}

// Only genuine in-stream provider/transport errors count as "skip in CI without a
// provider key". NOT `http_error` (a non-SSE response) — that means the agent route
// itself failed (e.g. a 5xx from a regression) and MUST surface, not be masked as a
// skip. Call sites also assert `status === 200` first, so a hard HTTP failure fails loudly.
function isProviderUnavailable(r: { events: SseEvent[] }): boolean {
  const err = r.events.find((e) => e.event === "error")
  if (!err) return false
  const code = (err.data as any)?.code
  return code === "provider_error" || code === "transport_error"
}

async function seedAgentThread(
  sql: any,
  ks: string,
  orgId: string,
  userId: string,
): Promise<string> {
  const threadId = crypto.randomUUID()
  await sql.unsafe(
    `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
    [threadId, orgId, `agent-${threadId.slice(0, 8)}`, userId],
  )
  await sql.unsafe(
    `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
    [threadId, userId, orgId],
  )
  return threadId
}

// Drives a real model provider: live only (LIAISON_E2E_LIVE_LLM=1, helpers/live-llm.ts).
describeLive("Agent scope-request loop", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let agentUser: { id: string; email: string; token: string; name: string }
  const PW = "TestPass123!"

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 23,
      org: { name: "Agent Scope-Request E2E Org" },
      populate: { users: { count: 2 } },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    for (const model of MODEL_PRICING_SEED) {
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (provider, model_id) DO NOTHING`,
        [
          model.provider,
          model.modelId,
          model.displayName,
          model.inputCostPerM,
          model.outputCostPerM,
          model.contextWindow,
          model.autoEligible,
          model.tierMinimum,
          model.source,
        ],
      )
    }
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.credit_balances (org_id, included_balance, purchased_balance, currency)
       VALUES ($1, '50.00000000', '50.00000000', 'EUR')
       ON CONFLICT (org_id) DO UPDATE SET included_balance = '50.00000000', purchased_balance = '50.00000000'`,
      [world.org.id],
    )

    // Agent user WITHOUT any tickets scope — only kernel thread scopes.
    agentUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      password: PW,
      scopes: ["kernel:threads:read", "kernel:threads:write"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // Seed an open ticket so a successful search has something to find.
    const inbox = await seedInbox(env, {
      orgId: world.org.id,
      name: "Support",
      emailAddress: "support@scopeqa.test",
      isDefaultForCreate: true,
      createdBy: world.admin.id,
    })
    const ticket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Refund request — order #99001",
      sourceInboxId: inbox.id,
      status: "open",
    })
    await seedTicketMessages(env, {
      orgId: world.org.id,
      ticketId: ticket.id,
      messages: [
        {
          kind: "inbound",
          fromEmail: "customer@acme.test",
          fromName: "Acme Customer",
          subject: "Refund request — order #99001",
          textBody: "Hi, I'd like a refund on order 99001.",
        },
      ],
    })
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("blocked agent asks → admin approves → next turn succeeds (real LLM)", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    // ── Turn 1: blocked. The agent should discover the gap (list_locked_capabilities)
    // and NOT call any gated tickets tool (it isn't exposed pre-grant).
    const t1 = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content:
        "Search our support tickets for anything about refunds. If you can't, find out what access you'd need and offer to request it.",
      modelId: null,
    })
    expect(t1.status).toBe(200) // a 5xx (real regression) must fail, not skip
    if (isProviderUnavailable(t1)) {
      console.log("agent-scope-request: provider unavailable — skipping")
      return
    }
    const names1 = t1.events
      .filter((e) => e.event === "tool-call")
      .map((e) => (e.data as any).toolName as string)
    expect(names1).toContain("kernel__list_locked_capabilities")
    expect(names1.filter((n) => /^tickets__/.test(n))).toHaveLength(0)

    // ── Turn 2: user confirms → request_scope files a pending request.
    const t2 = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Yes, please request that access from my admin.",
      modelId: null,
    })
    expect(t2.status).toBe(200)
    if (isProviderUnavailable(t2)) return
    const reqRows = await env.db.sql.unsafe(
      `SELECT id, requested_scopes, requested_by_type, status FROM ${ks}.scope_requests
       WHERE org_id = $1 AND requested_by = $2 AND status = 'pending'`,
      [world.org.id, agentUser.id],
    )
    expect(reqRows.length).toBeGreaterThanOrEqual(1)
    const row = reqRows.find((r: any) =>
      (r.requested_scopes as string[]).includes("tickets:tickets:read"),
    ) as { id: string; requested_by_type: string } | undefined
    expect(row).toBeDefined()
    if (!row) throw new Error("no pending scope_request for tickets:tickets:read")
    expect(row.requested_by_type).toBe("agent")
    const reqId = row.id

    // ── Admin approves through the REAL decide endpoint; the grant lands.
    const dec = await fetch(`${url}/api/scope-requests/${reqId}/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${world.admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(dec.status).toBe(200)
    const grant = await env.db.sql.unsafe(
      `SELECT 1 FROM ${ks}.user_scope_grants WHERE org_id = $1 AND user_id = $2 AND scope = 'tickets:tickets:read'`,
      [world.org.id, agentUser.id],
    )
    expect(grant.length).toBe(1)

    // ── Token refresh: the grant bumped permissionVersion → old token 401s.
    const fresh = await login(url, agentUser.email, PW)

    // ── Turn 3: now authorised. The formerly-locked tool is exposed + invoked + succeeds.
    const t3 = await consumeSse(url, "/api/agent/chat", fresh.accessToken, {
      threadId,
      content: "Now search the tickets for refunds.",
      modelId: null,
    })
    expect(t3.status).toBe(200)
    if (isProviderUnavailable(t3)) return
    const search = t3.events.find(
      (e) => e.event === "tool-call" && /tickets__search/.test((e.data as any).toolName),
    )
    expect(search).toBeDefined()
    const searchResult = t3.events.find(
      (e) =>
        e.event === "tool-result" &&
        (e.data as any).toolCallId === (search!.data as any).toolCallId,
    )
    expect((searchResult?.data as any)?.result?.error).toBeFalsy()
  }, 180_000)
})
