// SPDX-License-Identifier: FSL-1.1-ALv2
// Compound / sequenced gated operations — agent scenario (S4).
//
// A real LLM is given two gated tools and an explicit chaining instruction. It
// must call `test:gatedProduce`, read the blocked result's `outputs`/`hint`, and
// pass the `@ref` token forward into `test:gatedConsume`. This is the direct
// test of the "no way to confuse dumb models" design goal: the discovery
// mechanism is the blocked envelope itself — no special "declare a sequence"
// tool, no seeded skill.
import { afterAll, beforeAll, expect, it } from "bun:test"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld } from "@liaison/test-helpers"
import { createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import { describeLive } from "./helpers/live-llm"
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

function isProviderUnavailable(events: SseEvent[]): boolean {
  const err = events.find((e) => e.event === "error")
  if (!err) return false
  const code = (err.data as { code?: string })?.code
  return code === "provider_error" || code === "transport_error" || code === "http_error"
}

// Gemini Flash-Lite — the cheapest auto-eligible model; deliberately a weak
// model, since S4 proves a "dumb" model can still chain via outputs + hint.
const TOOL_MODEL = "gemini-flash-lite-latest"

const AGENT_SCOPES = [
  "test:gated:write",
  "kernel:threads:read",
  "kernel:threads:write",
  "kernel:approvals:read",
  "kernel:contacts:read",
]

// Drives a real model provider: live only (LIAISON_E2E_LIVE_LLM=1, helpers/live-llm.ts).
describeLive("Compound approval — agent forms the bundle (S4)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let agentUser: { id: string; email: string; token: string; name: string }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 21,
      org: { name: "Compound Approval Agent E2E Org" },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    // Model pricing + credit balance — the agent runtime needs both.
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
      scopes: AGENT_SCOPES,
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("a real agent chains test:gatedProduce → test:gatedConsume into one bundle", async () => {
    const threadId = crypto.randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by)
       VALUES ($1, $2, $3, 'agent_chat', $4)`,
      [threadId, world.org.id, `agent-${threadId.slice(0, 8)}`, agentUser.id],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
      [threadId, agentUser.id, world.org.id],
    )

    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content:
        'Call the tool test:gatedProduce with seed "beta". It returns a blocked ' +
        "result containing an `outputs` map. Then call the tool test:gatedConsume, " +
        "passing the value of `outputs.value` from the first call verbatim as the " +
        '`note` argument, and "reply-label" as the `label` argument.',
      modelId: TOOL_MODEL,
    })

    if (isProviderUnavailable(events)) {
      console.log(
        "compound-approval-agent: provider unavailable — skipping",
        JSON.stringify(events.find((e) => e.event === "error")?.data),
      )
      return
    }
    expect(status).toBe(200)

    // The LLM transcript is advisory — both tool calls should appear, tolerating
    // provider name-mangling (`test:gatedProduce` → `test__gatedProduce`).
    const toolCalls = events.filter((e) => e.event === "tool-call")
    const produceCall = toolCalls.find((e) =>
      ((e.data as { toolName?: string }).toolName ?? "").includes("gatedProduce"),
    )
    const consumeCall = toolCalls.find((e) =>
      ((e.data as { toolName?: string }).toolName ?? "").includes("gatedConsume"),
    )
    expect(produceCall).toBeDefined()
    expect(consumeCall).toBeDefined()

    // Binding assertion — the side effect is the contract. The org must hold a
    // bundle: a deferred step whose @ref-bearing payload depends on a pending
    // head at bundle_position 0. This proves a cheap model, given only the
    // blocked result's outputs + hint, chained the tools correctly.
    const rows = (await env.db.sql.unsafe(
      `SELECT id, bundle_id, bundle_position, depends_on_id, status, current_payload
       FROM ${ks}.approval_requests WHERE org_id = $1`,
      [world.org.id],
    )) as Array<{
      id: string
      bundle_id: string | null
      bundle_position: number | null
      depends_on_id: string | null
      status: string
      current_payload: { note?: string }
    }>

    const deferredStep = rows.find((r) => r.status === "deferred")
    expect(deferredStep).toBeDefined()
    expect(deferredStep!.bundle_id).toBeTruthy()
    expect(deferredStep!.bundle_position ?? 0).toBeGreaterThan(0)
    expect(typeof deferredStep!.current_payload.note).toBe("string")
    expect(deferredStep!.current_payload.note).toContain("@ref:")

    const head = rows.find((r) => r.id === deferredStep!.bundle_id)
    expect(head).toBeDefined()
    expect(head!.bundle_position).toBe(0)
    expect(head!.status).toBe("pending")
    expect(deferredStep!.depends_on_id).toBe(head!.id)
  }, 90_000)
})
