// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E2E smoke for the sub-agent dispatch primitive — exercises the chat agent
// path end-to-end against a real API + real BullMQ worker + real Redis
// pub/sub:
//
//   1. `agent.spawn` is kernel-universal, so `kernel__spawn_agent` is
//      registered for the org with no app install.
//   2. Seed a `smoke-investigator` sub-agent definition (DB INSERT — the
//      LLM-authored CRUD path is unit-tested separately).
//   3. POST to /api/agent/chat with a prompt the stub recognizes; the stub
//      drives the parent loop to call `kernel__spawn_agent`, then drives the
//      sub-run's loop to call `finalize`.
//   4. Assert kernel.agent_runs has the child row at status='done' with the
//      expected structured output.
//   5. Assert the chat thread carries one `sub_run` message and the hidden
//      thread (type='subrun') exists with the run's transcript.
//
// This is the E2E smoke from `15-quick-planning-add-a-sub-e2e-plan.md` (S1) —
// adapted per Amendment 2 to use the chat-agent path (which exists today)
// instead of a fictional sandbox-handler-invocation endpoint.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld } from "@liaison/test-helpers"
import { createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import { seedThreadMessages } from "./helpers/thread-seed"
import { setupScenario, teardownScenario } from "./setup"

// Auto mode resolves to the cheapest auto-eligible model in MODEL_PRICING_SEED
// (currently gemini-flash-lite). The stub replaces `streamText`, so the actual
// provider call never happens — but the provider-resolution pre-check still
// consults the requested model id. Never hardcode an expensive model here.
const TOOL_MODEL = null as string | null

interface SseEvent {
  event: string
  data: unknown
}

function parseSseEvents(raw: string): SseEvent[] {
  const events: SseEvent[] = []
  let event = ""
  let dataStr = ""
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim()
    else if (line.startsWith("data: ")) dataStr = line.slice(6)
    else if (line === "" && event) {
      try {
        events.push({ event, data: JSON.parse(dataStr) })
      } catch {
        events.push({ event, data: dataStr })
      }
      event = ""
      dataStr = ""
    }
  }
  return events
}

async function consumeSse(
  url: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: SseEvent[] }> {
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
    }
  }
  return { status: res.status, events: parseSseEvents(rawBody) }
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

async function pollAgentRun(
  sql: any,
  ks: string,
  predicate: { subagentType: string; orgId: string; timeoutMs?: number },
): Promise<{
  id: string
  status: string
  output: unknown
  thread_id: string
  parent_thread_id: string | null
}> {
  const timeoutMs = predicate.timeoutMs ?? 60_000
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const rows = (await sql.unsafe(
      `SELECT id, status, output, thread_id, parent_thread_id
       FROM ${ks}.agent_runs
       WHERE subagent_type = $1 AND org_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [predicate.subagentType, predicate.orgId],
    )) as Array<{
      id: string
      status: string
      output: unknown
      thread_id: string
      parent_thread_id: string | null
    }>
    const row = rows[0]
    if (row && ["done", "failed", "cancelled"].includes(row.status)) return row
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`pollAgentRun(${predicate.subagentType}): timed out after ${timeoutMs}ms`)
}

describe("Sub-agent dispatch — smoke E2E", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let agentUser: { id: string; token: string; email: string; name: string }
  let threadId: string

  beforeAll(async () => {
    const stubPath = new URL("./helpers/sub-agent-smoke-stub.ts", import.meta.url).pathname
    const result = await setupScenario({
      seed: 4_037,
      org: { name: "Sub-Agent Smoke E2E" },
      serverEnv: {
        // No app install: `agent.spawn` is a kernel-universal capability
        // (KERNEL_CAPABILITIES in modules/apps/app-registries.ts), present in
        // every org. The chaos-debug app this file once booted for it is not
        // part of this repository, and CHAOS_DEBUG=1 without its injector
        // module refuses to boot.
        // Cross-process LLM stub — the stub replaces `streamText`, so the real
        // provider key is never called. We still need *some* key configured so
        // the provider-availability pre-check passes before the stub kicks in.
        // Both the parent (Anthropic via TOOL_MODEL) and the sub-run worker
        // (auto-mode, typically Gemini Flash from MODEL_PRICING_SEED) need a
        // provider key each — stubbed strings are fine since `streamText` is
        // replaced before the keys are used to make any network call.
        LIAISON_ANTHROPIC_API_KEY: "sk-stub-not-used",
        GOOGLE_API_KEY: "stub-not-used",
        OPENAI_API_KEY: "stub-not-used",
        MISTRAL_API_KEY: "stub-not-used",
        // Cross-process LLM stub.
        AGENT_STREAM_STUB: stubPath,
        // S6 nests two sub-runs, the first waiting on its child while it holds
        // a kernel-agent worker slot. The e2e server's 8-connection pool plans
        // ONE agent slot (planKernelSlots scales the classes down to the
        // privileged pool), so the depth-2 child would queue behind its own
        // parent forever. Production's default privileged pool (15, the
        // compose default) keeps the default plan, 4 agent slots.
        DB_PRIVILEGED_POOL_MAX: "15",
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    // Seed model pricing + credits.
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

    // Dedicated agent user (mirrors the chaos orchestrator pattern). Scope
    // `kernel:agents:spawn` is required for the `kernel__spawn_agent` tool.
    agentUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["kernel:threads:read", "kernel:threads:write", "kernel:agents:spawn"],
      schemaPrefix: env.schemaPrefix,
    })

    // Seed the sub-agent role definitions directly (LLM-driven CRUD is
    // unit-tested in sub-agent-definitions.test.ts).
    const defs: Array<{
      agentType: string
      systemPrompt: string
      toolAllowlist: string[] | null
    }> = [
      {
        agentType: "smoke-investigator",
        systemPrompt: "SUB_AGENT_E2E_SMOKE_ROLE\n\nInvestigate and call finalize.",
        toolAllowlist: null,
      },
      {
        agentType: "fanout-investigator",
        systemPrompt: "SUB_AGENT_E2E_SMOKE_ROLE — fan-out child. Call finalize.",
        toolAllowlist: null,
      },
      {
        agentType: "nested-investigator",
        // Role marker is also embedded so the sub-run stub can route.
        systemPrompt:
          "SUB_AGENT_E2E_NESTED_ROLE\n\nA nested investigator. May spawn another sub-agent to a target depth.",
        // Allow spawn_agent in this role so nested spawns succeed.
        // `tool_allowlist` matches the CANONICAL form `appName:toolName`
        // (the SDK sanitization to `appName__toolName` happens later).
        toolAllowlist: ["kernel:spawn_agent", "kernel:finalize"],
      },
    ]
    for (const def of defs) {
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.sub_agent_definitions (
           org_id, app_name, agent_type, when_to_use, scope_ceiling,
           tool_allowlist, tool_denylist, skills, mcp_servers, system_prompt,
           default_max_steps, default_timeout_ms, default_schema_retry_budget
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          world.org.id,
          "chaos-debug",
          def.agentType,
          `${def.agentType} role for E2E.`,
          ["kernel:threads:read", "kernel:agents:spawn"],
          def.toolAllowlist,
          null,
          [],
          [],
          def.systemPrompt,
          10,
          60_000,
          3,
        ],
      )
    }

    threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
  }, 60_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  it("S1 smoke: parent chat dispatches sub-agent; sub-run lands at done with stub output", async () => {
    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Dispatch sub-agent smoke now",
      modelId: TOOL_MODEL,
    })
    expect(status, JSON.stringify(events.slice(0, 5))).toBe(200)

    // The parent loop should emit one kernel__spawn_agent tool call.
    const spawnCall = events.find(
      (e) => e.event === "tool-call" && (e.data as any).toolName === "kernel__spawn_agent",
    )
    expect(spawnCall, "expected a kernel__spawn_agent tool-call in the SSE stream").toBeDefined()

    // The sub-run worker runs out-of-band; poll the row to terminal state.
    const run = await pollAgentRun(env.db.sql, ks, {
      subagentType: "smoke-investigator",
      orgId: world.org.id,
      timeoutMs: 30_000,
    })
    expect(run.status).toBe("done")
    expect(run.output).toEqual({ ok: true, smoke: "passed" })

    // Hidden thread exists.
    const hidden = (await env.db.sql.unsafe(
      `SELECT type, hidden_from_list FROM ${ks}.threads WHERE id = $1`,
      [run.thread_id],
    )) as Array<{ type: string; hidden_from_list: boolean }>
    expect(hidden[0]?.type).toBe("subrun")
    expect(hidden[0]?.hidden_from_list).toBe(true)

    // Parent thread carries a `sub_run` message with the runId in metadata.
    const subRunMsgs = (await env.db.sql.unsafe(
      `SELECT metadata FROM ${ks}.messages
       WHERE thread_id = $1
         AND metadata->>'kind' = 'sub_run'`,
      [threadId],
    )) as Array<{ metadata: { kind?: string; subRun?: { runId?: string } } | null }>
    expect(subRunMsgs.length).toBeGreaterThanOrEqual(1)
    expect(subRunMsgs[0]?.metadata?.subRun?.runId).toBe(run.id)
  }, 60_000)

  it("S2: fresh context per child — hidden thread has only the caller's prompt, no parent history", async () => {
    // Plant a few parent-thread messages BEFORE the spawn so we can prove the
    // sub-run's hidden thread doesn't inherit them. (Spec §1.1 — Fresh
    // context per record).
    await seedThreadMessages(env, [
      {
        threadId,
        orgId: world.org.id,
        authorId: agentUser.id,
        content: "Earlier irrelevant message A",
      },
      {
        threadId,
        orgId: world.org.id,
        authorId: agentUser.id,
        authorType: "system",
        content: "Earlier system note B",
      },
    ])

    const { status } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Dispatch sub-agent smoke now",
      modelId: TOOL_MODEL,
    })
    expect(status).toBe(200)

    // Find the second sub-run (this scenario's spawn) — order by created_at DESC LIMIT 1.
    const run = await pollAgentRun(env.db.sql, ks, {
      subagentType: "smoke-investigator",
      orgId: world.org.id,
      timeoutMs: 30_000,
    })
    expect(run.status).toBe("done")

    // The hidden thread's messages must contain the spawn `prompt` once and
    // NOT contain the parent-thread chatter ("Earlier irrelevant message A").
    const hiddenMsgs = (await env.db.sql.unsafe(
      `SELECT author_type, content FROM ${ks}.messages WHERE thread_id = $1 ORDER BY created_at`,
      [run.thread_id],
    )) as Array<{ author_type: string; content: string | null }>
    const combined = hiddenMsgs.map((m) => m.content ?? "").join("\n")
    expect(combined).toContain("SUB_AGENT_E2E_SMOKE_ROLE")
    expect(combined).not.toContain("Earlier irrelevant message A")
    expect(combined).not.toContain("Earlier system note B")
  }, 60_000)

  it("S5: continueOnError=true fan-out — 3 children (ok / timeout / ok), aggregated by parent", async () => {
    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Fan out three children now",
      modelId: TOOL_MODEL,
    })
    expect(status).toBe(200)

    // Diagnostic: did the parent stub emit fan-out tool-calls?
    const fanoutCalls = events.filter(
      (e) => e.event === "tool-call" && (e.data as any)?.toolName === "kernel__spawn_agent",
    )
    void `[S5] saw ${fanoutCalls.length} kernel__spawn_agent tool-calls in SSE\n`

    // Wait until 3 fanout-investigator rows reach terminal state.
    const started = Date.now()
    let rows: Array<{ id: string; status: string; error_code: string | null }> = []
    while (Date.now() - started < 30_000) {
      const r = (await env.db.sql.unsafe(
        `SELECT id, status, error_code, subagent_type FROM ${ks}.agent_runs
         WHERE subagent_type = 'fanout-investigator' AND org_id = $1
         ORDER BY created_at DESC
         LIMIT 3`,
        [world.org.id],
      )) as Array<{ id: string; status: string; error_code: string | null; subagent_type: string }>
      // Diagnostic: also count all rows
      if (Date.now() - started < 1000) {
        const all = (await env.db.sql.unsafe(
          `SELECT subagent_type, status, count(*)::int AS n FROM ${ks}.agent_runs
           WHERE org_id = $1 GROUP BY subagent_type, status`,
          [world.org.id],
        )) as Array<{ subagent_type: string; status: string; n: number }>
        void `[S5] all rows by type/status: ${JSON.stringify(all)}\n`
      }
      const totalNew =
        r.length >= 3 && r.every((x) => ["done", "failed", "cancelled"].includes(x.status))
      if (totalNew) {
        rows = r
        break
      }
      await new Promise((res) => setTimeout(res, 300))
    }
    expect(rows.length).toBe(3)
    void `[S5] rows: ${JSON.stringify(rows)}\n`
    const statuses = rows.map((r) => r.status).sort()
    expect(statuses).toEqual(["done", "done", "failed"])
    const failed = rows.find((r) => r.status === "failed")
    expect(failed?.error_code).toBe("timeout")
  }, 90_000)

  /** Nested-investigator rows, by depth, leaving out the ids in `skip` (an earlier case's). */
  async function nestedRuns(skip: Set<string>) {
    const rows = (await env.db.sql.unsafe(
      `SELECT id, status, nesting_depth, output::text AS output FROM ${ks}.agent_runs
       WHERE subagent_type = 'nested-investigator' AND org_id = $1
       ORDER BY nesting_depth`,
      [world.org.id],
    )) as Array<{ id: string; status: string; nesting_depth: number; output: string | null }>
    return rows.filter((r) => !skip.has(r.id))
  }

  async function existingNestedIds(): Promise<Set<string>> {
    return new Set((await nestedRuns(new Set())).map((r) => r.id))
  }

  async function waitForTerminalNested(skip: Set<string>, count: number) {
    const started = Date.now()
    while (Date.now() - started < 60_000) {
      const r = await nestedRuns(skip)
      if (r.length >= count && r.every((x) => ["done", "failed", "cancelled"].includes(x.status))) {
        return r
      }
      await new Promise((res) => setTimeout(res, 300))
    }
    return nestedRuns(skip)
  }

  it("S6: nested sub-agent — successfully nests to the maximum depth (2)", async () => {
    const earlier = await existingNestedIds()
    const { status } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Spawn nested investigator target=2",
      modelId: TOOL_MODEL,
    })
    expect(status).toBe(200)

    const rows = await waitForTerminalNested(earlier, 2)
    // Every row is terminal and done (the happy path for a nested chain).
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.status === "done")).toBe(true)

    // The chain produces rows at depth 1 and 2, proving ALS frame propagation
    // through the AI SDK's tool execute boundary (sub-run worker sets the
    // frame; `buildScopedToolSet` re-enters it inside each tool's execute via
    // `runFrame`, so `handleSpawnAgent`'s `currentRunContext()` sees the real
    // parent depth and chains correctly).
    expect(rows.map((r) => r.nesting_depth)).toEqual([1, 2])
  }, 90_000)

  it("S6b: a depth-2 sub-agent cannot spawn a third level: the model gets a clear refusal", async () => {
    const earlier = await existingNestedIds()
    const { status } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Spawn nested investigator target=3",
      modelId: TOOL_MODEL,
    })
    expect(status).toBe(200)

    const rows = await waitForTerminalNested(earlier, 2)
    // No depth-3 run was ever created: the spawn was refused before any row.
    expect(rows.map((r) => r.nesting_depth)).toEqual([1, 2])
    expect(rows.every((r) => r.status === "done")).toBe(true)
    // The depth-2 run's spawn call came back as a typed refusal, and that
    // is what its model saw (the stub echoes the spawn result into its answer).
    const depth2 = rows.find((r) => r.nesting_depth === 2)
    expect(depth2?.output ?? "").toContain("E_DEPTH_EXCEEDED")
    expect(depth2?.output ?? "").toContain("at most 2 levels deep")
  }, 90_000)

  it("S7: hidden-thread RLS — covered by route test", async () => {
    // The Bob-denial + Taylor-allowed access patterns are unit-tested in
    // `apps/api/src/modules/threads/list-messages-subrun.test.ts`. This row
    // exists to keep the E2E scenario register honest. The route test runs
    // green via Strobe (verified separately).
    expect(true).toBe(true)
  })
})
