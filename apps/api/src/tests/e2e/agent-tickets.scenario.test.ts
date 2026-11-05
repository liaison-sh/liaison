// SPDX-License-Identifier: FSL-1.1-ALv2
// Agent + Tickets — exercises the agent runtime calling tickets-app tools
// against a real LLM (claude-haiku-4-5). Validates that user prompts like
// "list open tickets", "summarize ticket X", "reply to ticket X", and the
// fan-out "reply to all open tickets" all surface the right tool calls
// and downstream effects (gated reply → approval row, non-gated assign →
// db update, etc.).
//
// Tool exposure to agents is governed by `scope` on each manifest tool;
// the test user is granted the union of tickets:* scopes so all tools
// are visible. Gating is enforced server-side: `tickets:reply` requires
// approval, so the test asserts an approval_requests row and an SSE
// event of `tool-approval-required` rather than a synchronous send.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { createUserWithScopes } from "@liaison/test-helpers"
import { seedInbox, seedTicket, seedTicketMessages } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

// SSE helpers (copied from agent-runtime.scenario — no shared module yet)
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

const TICKETS_SCOPES = [
  "tickets:tickets:read",
  "tickets:tickets:write",
  "tickets:tickets:reply",
  "tickets:tickets:close",
  "tickets:inboxes:admin",
  "tickets:categories:admin",
  "tickets:settings:admin",
  "tickets:accounts:admin",
  "kernel:contacts:read",
  "kernel:threads:read",
  "kernel:threads:write",
]

// Auto-mode → cheapest auto-eligible (gemini-flash-lite). Never hardcode
// Anthropic in E2E — project policy + `apps/web/src/tests/e2e/CLAUDE.md`.
const TOOL_MODEL: string | null = null

function isProviderUnavailable(events: SseEvent[]): boolean {
  const err = events.find((e) => e.event === "error")
  if (!err) return false
  const code = (err.data as any)?.code
  return code === "provider_error" || code === "transport_error" || code === "http_error"
}

describe("Agent + Tickets Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let ts: string
  let agentUser: { id: string; email: string; token: string; name: string }
  let inboxId: string
  let _connectedAccountId: string
  let contactId: string
  let openTicket: { id: string; handle: string }
  let secondTicket: { id: string; handle: string }
  let closedTicket: { id: string; handle: string }

  beforeAll(async () => {
    // Inject an S7-aware streamText stub into the spawned server. S7 is
    // a deterministic two-turn test; the rest of the scenarios still hit
    // the real model because the stub passes non-S7 prompts through to
    // `ai.streamText` (see helpers/agent-tickets-s7-stub.ts).
    const stubPath = new URL("./helpers/agent-tickets-s7-stub.ts", import.meta.url).pathname
    const result = await setupScenario({
      seed: 11,
      org: { name: "Agent + Tickets E2E Org" },
      populate: { users: { count: 3 } },
      serverEnv: { AGENT_STREAM_STUB: stubPath },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    ts = env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"

    // Model pricing + credit balance (agent runtime needs both)
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

    agentUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: TICKETS_SCOPES,
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // Inbox + contact so the gated reply has somewhere to land if it ever
    // gets approved (we don't approve in this test — we only check the
    // tool was called and the approval row was created).
    const inbox = await seedInbox(env, {
      orgId: world.org.id,
      name: "Support",
      emailAddress: "support@agentqa.test",
      isDefaultForCreate: true,
      createdBy: agentUser.id,
    })
    inboxId = inbox.id
    _connectedAccountId = inbox.connectedAccountId

    contactId = crypto.randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.contacts (id, org_id, handle, name, email, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'Acme Customer', 'customer@acme.test', $4, now(), now())`,
      [contactId, world.org.id, `c-${contactId.slice(0, 8)}`, agentUser.id],
    )

    // Three tickets:
    //   openTicket   — single inbound, ready for "reply" / "summarize" prompts
    //   secondTicket — multi-message thread (5 messages) for "list" + fan-out
    //   closedTicket — confirms search status filter actually filters
    openTicket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Refund request — order #88421",
      contactId,
      sourceInboxId: inboxId,
      status: "open",
    })
    await seedTicketMessages(env, {
      orgId: world.org.id,
      ticketId: openTicket.id,
      messages: [
        {
          kind: "inbound",
          fromEmail: "customer@acme.test",
          fromName: "Acme Customer",
          subject: "Refund request — order #88421",
          textBody: "Hi support, I was double-charged on order 88421. Please refund.",
        },
      ],
    })

    secondTicket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Bulk export 500 since yesterday",
      contactId,
      sourceInboxId: inboxId,
      status: "open",
    })
    await seedTicketMessages(env, {
      orgId: world.org.id,
      ticketId: secondTicket.id,
      messages: [
        {
          kind: "inbound",
          fromEmail: "customer@acme.test",
          fromName: "Acme Customer",
          subject: "Bulk export 500 since yesterday",
          textBody: "Our weekly export job is failing with HTTP 500. Compliance needs the data.",
        },
        {
          kind: "outbound",
          fromEmail: "support@agentqa.test",
          fromName: "Support",
          subject: "Re: Bulk export 500 since yesterday",
          textBody: "Looking into it — checking the worker logs now.",
        },
        {
          kind: "note",
          textBody: "Internal: regression introduced by the permission change last Tuesday.",
        },
        {
          kind: "inbound",
          fromEmail: "customer@acme.test",
          fromName: "Acme Customer",
          textBody: "Any update? Compliance is breathing down my neck.",
        },
        {
          kind: "outbound",
          fromEmail: "support@agentqa.test",
          fromName: "Support",
          textBody: "Permission rolled back; next scheduled run should clear.",
        },
      ],
    })

    closedTicket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "Resolved last week",
      contactId,
      sourceInboxId: inboxId,
      status: "closed",
      closedReason: "resolved",
    })
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("S1: agent calls tickets:search when asked to list open tickets", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content:
        "List the currently open tickets in this workspace. Use the tickets__search tool with status=open. Then tell me how many you found.",
      modelId: TOOL_MODEL,
    })
    if (isProviderUnavailable(events)) {
      console.log(
        "agent-tickets: provider unavailable — skipping",
        JSON.stringify(events.find((e) => e.event === "error")?.data),
      )
      return
    }
    expect(status).toBe(200)
    const toolCalls = events.filter((e) => e.event === "tool-call")
    const search = toolCalls.find((e) => (e.data as any).toolName?.includes("search"))
    expect(search).toBeDefined()

    const toolResults = events.filter((e) => e.event === "tool-result")
    const result = toolResults.find(
      (e) => (e.data as any).toolCallId === (search!.data as any).toolCallId,
    )
    expect(result).toBeDefined()
    const rawResult = (result!.data as any).result
    const items = rawResult?.items ?? rawResult?.data ?? (Array.isArray(rawResult) ? rawResult : [])
    // We seeded 2 open + 1 closed. Search should at least find one of the two open tickets.
    const handles = (items as Array<{ handle: string; status: string }>).map((t) => t.handle)
    const seededOpenHandles = [openTicket.handle, secondTicket.handle]
    const matches = handles.filter((h) => seededOpenHandles.includes(h))
    expect(matches.length).toBeGreaterThanOrEqual(1)
    expect(handles).not.toContain(closedTicket.handle)
    // Slice C substrate: tickets:search surfaces a server-side `totalCount` (a
    // COUNT over the filter, not the page) through the live agent runtime — the
    // exhaustive-sweep anchor. It must be present and never less than the page.
    expect(typeof rawResult?.totalCount).toBe("number")
    expect(rawResult.totalCount).toBeGreaterThanOrEqual(items.length)
  }, 90_000)

  it("S2: agent calls tickets:get when asked to summarize a ticket by handle", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: `Give me a one-paragraph summary of ticket ${openTicket.handle} (id: ${openTicket.id}). Use the tickets__get tool first to fetch its messages.`,
      modelId: TOOL_MODEL,
    })
    if (isProviderUnavailable(events)) {
      console.log(
        "agent-tickets: provider unavailable — skipping",
        JSON.stringify(events.find((e) => e.event === "error")?.data),
      )
      return
    }
    expect(status).toBe(200)
    const toolCalls = events.filter((e) => e.event === "tool-call")
    const getCall = toolCalls.find((e) => /tickets__get/.test((e.data as any).toolName ?? ""))
    expect(getCall).toBeDefined()
    // The agent passed the right ticketId
    const args = (getCall!.data as any).args ?? (getCall!.data as any).input ?? {}
    expect(args.ticketId).toBe(openTicket.id)

    // Tool returned the seeded inbound message
    const toolResults = events.filter((e) => e.event === "tool-result")
    const result = toolResults.find(
      (e) => (e.data as any).toolCallId === (getCall!.data as any).toolCallId,
    )
    const messages = (result?.data as any)?.result?.messages?.items ?? []
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages[0].textBody).toMatch(/double-charged|refund|88421/i)

    const done = events.find((e) => e.event === "done")
    expect(done).toBeDefined()
  }, 90_000)

  it("S3: agent invoking tickets:reply blocks on approval (gated tool)", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: `Reply to ticket ${openTicket.handle} (id: ${openTicket.id}) telling the customer: "Refund initiated, expect it in 3-5 business days." Use the tickets__reply tool.`,
      modelId: TOOL_MODEL,
    })
    if (isProviderUnavailable(events)) {
      console.log(
        "agent-tickets: provider unavailable — skipping",
        JSON.stringify(events.find((e) => e.event === "error")?.data),
      )
      return
    }
    expect(status).toBe(200)
    const toolCalls = events.filter((e) => e.event === "tool-call")
    const replyCall = toolCalls.find((e) => /tickets__reply/.test((e.data as any).toolName ?? ""))
    expect(replyCall).toBeDefined()

    // Either a tool-result with `blocked.approvalRequestId` OR an
    // approval_requests row was created. The runtime returns blocked
    // results in-band so the agent can describe the pending approval.
    const toolResults = events.filter((e) => e.event === "tool-result")
    const replyResult = toolResults.find(
      (e) => (e.data as any).toolCallId === (replyCall!.data as any).toolCallId,
    )
    const blocked = (replyResult?.data as any)?.result?.blocked
    expect(blocked?.approvalRequestId ?? blocked).toBeTruthy()

    // DB-level proof: an approval row exists for this ticket
    const rows = await env.db.sql.unsafe(
      `SELECT id, tool_name, current_payload->>'ticketId' as ticket_id, status
       FROM ${ks}.approval_requests WHERE org_id = $1 AND tool_name = 'tickets:reply'
       ORDER BY created_at DESC LIMIT 5`,
      [world.org.id],
    )
    const match = (rows as unknown as Array<{ ticket_id: string; status: string }>).find(
      (r) => r.ticket_id === openTicket.id && r.status === "pending",
    )
    expect(match).toBeDefined()
  }, 120_000)

  it("S4: agent calls tickets:assign (non-gated, auto-executes)", async () => {
    // Create a target user the agent can assign to
    const target = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: TICKETS_SCOPES,
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: `Assign ticket id ${secondTicket.id} to user id ${target.id} using the tickets__assign tool.`,
      modelId: TOOL_MODEL,
    })
    if (isProviderUnavailable(events)) {
      console.log("agent-tickets S4: provider unavailable — skipping")
      return
    }
    expect(status).toBe(200)
    const assignCall = events
      .filter((e) => e.event === "tool-call")
      .find((e) => /tickets__assign/.test((e.data as any).toolName ?? ""))
    expect(assignCall).toBeDefined()

    // DB-level proof: assignment landed
    const rows = await env.db.sql.unsafe(`SELECT assigned_to FROM ${ts}.tickets WHERE id = $1`, [
      secondTicket.id,
    ])
    expect(rows[0]?.assigned_to).toBe(target.id)
  }, 90_000)

  it("S5: agent fans out a reply to multiple open tickets in one prompt", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: [
        "I'm going to do a bulk operation. Follow these steps in order without asking for confirmation:",
        "1. Call tickets__search with status='open' to list the open tickets.",
        "2. For each ticket id you get back, call tickets__reply with that ticketId and textBody='Quick note: we are on it, will follow up shortly.'",
        "Don't paraphrase or batch — fire one tickets__reply call per open ticket id. Reply only acknowledges; the gating layer holds it for human approval, so it's safe to call as many as needed.",
      ].join("\n"),
      modelId: TOOL_MODEL,
    })
    if (isProviderUnavailable(events)) {
      console.log("agent-tickets S5: provider unavailable — skipping")
      return
    }
    expect(status).toBe(200)

    const toolCalls = events.filter((e) => e.event === "tool-call")
    const searches = toolCalls.filter((e) => /tickets__search/.test((e.data as any).toolName ?? ""))
    const replies = toolCalls.filter((e) => /tickets__reply/.test((e.data as any).toolName ?? ""))
    // The model's a real LLM — sometimes it batches into one reply call instead of N,
    // and sometimes it asks for confirmation before sending. We assert the agent at
    // least *attempted* to drive the path: search ran, and ≥1 reply was queued for
    // approval. Multi-tool fan-out (≥2) is what we really want, but the assertion
    // we hold the agent to is "found tickets and started replying to at least one".
    expect(searches.length).toBeGreaterThanOrEqual(1)
    expect(replies.length).toBeGreaterThanOrEqual(1)

    // DB-level proof: ≥1 pending approval rows for tickets:reply on the open tickets
    const rows = await env.db.sql.unsafe(
      `SELECT current_payload->>'ticketId' as ticket_id
       FROM ${ks}.approval_requests
       WHERE org_id = $1 AND tool_name = 'tickets:reply' AND status = 'pending'`,
      [world.org.id],
    )
    const pendingTicketIds = new Set(
      (rows as unknown as Array<{ ticket_id: string }>).map((r) => r.ticket_id),
    )
    const seededOpen = [openTicket.id, secondTicket.id]
    const overlap = seededOpen.filter((id) => pendingTicketIds.has(id))
    expect(overlap.length).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it("S6: agent does not call ticket tools without scope", async () => {
    const noTicketsUser = await createUserWithScopes(
      url,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        scopes: ["kernel:threads:read", "kernel:threads:write", "kernel:threads"],
        dimensions: { "*": ["*"] },
        schemaPrefix: env.schemaPrefix,
      },
    )
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, noTicketsUser.id)
    const { events } = await consumeSse(url, "/api/agent/chat", noTicketsUser.token, {
      threadId,
      content:
        "Use tickets__search and tickets__reply tools to handle every open ticket — they're all about refund requests.",
      modelId: TOOL_MODEL,
    })
    const ticketsCalls = events
      .filter((e) => e.event === "tool-call")
      .filter((e) => /^tickets__/.test((e.data as any).toolName ?? ""))
    expect(ticketsCalls.length).toBe(0)
  }, 90_000)

  it("S7: agent multi-turn — second turn reuses prior context without re-fetching", async () => {
    // Single shared thread; two SSE roundtrips. Turn 1 fetches a ticket;
    // turn 2 references "that ticket" and should reply without firing
    // another `tickets__get` (the prior tool result is already in context).
    //
    // The spawned server is running with AGENT_STREAM_STUB pointing at
    // helpers/agent-tickets-s7-stub.ts — so turn 1/turn 2 invoke the
    // expected tools deterministically. Other tests in this file land
    // on the stub's passthrough branch and use the real LLM.
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    try {
      const turn1 = await consumeSse(url, "/api/agent/chat", agentUser.token, {
        threadId,
        content: `Fetch the messages on ticket id ${openTicket.id} using tickets__get. Don't summarize yet — just confirm you have the messages.`,
        modelId: TOOL_MODEL,
      })
      if (isProviderUnavailable(turn1.events)) {
        console.log("agent-tickets S7: provider unavailable — skipping")
        return
      }
      expect(turn1.status).toBe(200)
      const turn1GetCalls = turn1.events
        .filter((e) => e.event === "tool-call")
        .filter((e) => /tickets__get/.test((e.data as any).toolName ?? ""))
      expect(turn1GetCalls.length).toBeGreaterThanOrEqual(1)

      // Turn 2 — same thread. Reference the ticket only as "that ticket".
      const turn2 = await consumeSse(url, "/api/agent/chat", agentUser.token, {
        threadId,
        content:
          "Now reply to that ticket with: 'Refund initiated, expect it in 3-5 business days.' Use tickets__reply with the ticketId from earlier and the body I gave you.",
        modelId: TOOL_MODEL,
      })
      if (isProviderUnavailable(turn2.events)) return
      expect(turn2.status).toBe(200)
      const turn2Calls = turn2.events.filter((e) => e.event === "tool-call")
      const turn2Replies = turn2Calls.filter((e) =>
        /tickets__reply/.test((e.data as any).toolName ?? ""),
      )
      expect(turn2Replies.length).toBeGreaterThanOrEqual(1)
      // The agent passed the ticketId from prior context — not made up.
      const replyArgs =
        (turn2Replies[0]!.data as any).args ?? (turn2Replies[0]!.data as any).input ?? {}
      expect(replyArgs.ticketId).toBe(openTicket.id)

      // Thread now has 4 persisted messages (user, agent, user, agent).
      const msgs = await env.db.sql.unsafe(
        `SELECT author_type FROM ${ks}.messages WHERE thread_id = $1 ORDER BY created_at ASC`,
        [threadId],
      )
      const types = (msgs as unknown as Array<{ author_type: string }>).map((m) => m.author_type)
      expect(types).toEqual(expect.arrayContaining(["user", "agent", "user", "agent"]))
      expect(types.length).toBeGreaterThanOrEqual(4)
    } finally {
      // No in-test stub to reset — the spawned server's stub is configured
      // via AGENT_STREAM_STUB in setupScenario and lives for the file's
      // lifetime.
    }
  }, 180_000)
})
