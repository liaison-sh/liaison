// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Module B E2E — event-triggers + per-org auto-approve engine, driven over the
// running `index.e2e.ts` server (spawned by `setupScenario`).
//
// Two net-new surfaces are exercised end-to-end through the real HTTP + job +
// event plumbing (no in-process shortcuts):
//
//   1. Event-trigger routines: `create_routine(kind:'event')` subscribes the
//      routine to a kernel `app:entity:action` event AT RUNTIME (the create
//      handler calls registerEventRoutineSubscription). Emitting the matching
//      domain event on the SAME server process enqueues a `routine-tick` BullMQ
//      job whose worker writes a `routine_runs` row — the observable proof the
//      tick fired in response to the event.
//
//   2. The per-org auto-approve engine: a gated tool call an AGENT makes for a
//      NON-approver consults `evaluateAutoApprove` at the single
//      `execute-tool.ts` gate site.
//      A matching enabled policy with headroom auto-executes the tool AND writes
//      a synthetic `approval_request` row (status 'approved', metadata tagged
//      `autoApprovedByPolicy:<id>`) so the autonomous approval is audited exactly
//      like a human one. Over the window cap → gates. A `@ref`-sequenced step →
//      gates (the @ref check runs BEFORE the policy, by construction). A
//      taint-escalated call → gates (taint returns above the auto-approve site).
//      `policy_set` itself is gated (the agent cannot silently widen its autonomy).
//
// Approvals and auto-approve policies are for agents, not persons: a person's
// own call (REST, origin human-ui) runs on their own scope or is refused (S5).
// So the gated calls below are made by the agent, in a chat turn the scripted
// model provider drives (POST /api/_test/agent-script): the agent loop, tool
// bridge and gate are real, only the tokens are scripted. The chatting user is
// a NON-approver (lacks `test:approve` / `kernel:approve`), so a policy is the
// only thing that can unblock a gated call: the sharp condition under which
// auto-approve is observable.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import { buildRefToken, MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

interface RunToolResult {
  status: number
  body: {
    data?: {
      blocked?: { reason: string; approvalRequestId?: string; sequenced?: boolean }
    } & Record<string, unknown>
    error?: { code?: string; message?: string }
  }
}

// JSON-serializable value — the input contract for `enqueueAppEvent`'s event
// payload, so it can be bound through postgres.js `sql.json()` (whose param type
// is `JSONValue`) without any cast.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

describe("Event-trigger + auto-approve Scenario (Module B)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string

  // A NON-approver user: holds the gated tool's *write* scope (so it passes RBAC)
  // and routine/policy authoring read/write, but NOT `test:approve` / `kernel:approve`.
  // Without an approve scope the direct-human bypass cannot fire, so a gated call
  // can only be unblocked by an auto-approve policy — the condition that makes the
  // engine's behavior observable.
  let actorUser: { id: string; email: string; token: string; name: string }

  function ks(): string {
    return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
  }

  // ── run-tool driver (the same surface the approvals e2e uses) ──
  async function runTool(
    token: string,
    toolName: string,
    params: Record<string, unknown>,
    threadId?: string,
  ): Promise<RunToolResult> {
    return (await api(url, "/api/apps/run-tool", {
      method: "POST",
      token,
      body: { toolName, params, ...(threadId ? { threadId } : {}) },
    })) as RunToolResult
  }

  // ── an agent chat thread the actor owns: the agent's gated calls park in it ──
  async function freshAgentThread(): Promise<string> {
    const threadId = crypto.randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks()}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
      [threadId, world.org.id, `agent-${threadId.slice(0, 8)}`, actorUser.id],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${ks()}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
      [threadId, actorUser.id, world.org.id],
    )
    return threadId
  }

  // ── the agent calls ONE tool in `threadId` (scripted turn), and its result ──
  // The scripted provider plays the model: it loads the deferred tool with a
  // `tool_search select:` (what a real model's blind call is rewritten into),
  // calls it, then closes with a text. Returns the tool-result the agent got back (the
  // gate's envelope as the agent sees it: the handler's data, or `{ blocked }`).
  async function agentCall(
    threadId: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<
    { blocked?: { reason: string; approvalRequestId?: string; sequenced?: boolean } } & Record<
      string,
      unknown
    >
  > {
    const sdkName = toolName.replace(":", "__")
    const scripted = await api(url, "/api/_test/agent-script", {
      method: "POST",
      body: {
        threadId,
        steps: [
          { toolCalls: [{ name: "kernel__tool_search", args: { query: `select:${sdkName}` } }] },
          { toolCalls: [{ name: sdkName, args: params }] },
          { text: "Done." },
        ],
      },
    })
    expect(scripted.status).toBe(200)
    // Without the flag the script is ignored and the turn would reach a provider.
    expect(scripted.body.data.providerActive).toBe(true)
    const res = await fetch(`${url}/api/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${actorUser.token}` },
      body: JSON.stringify({ threadId, content: `Run ${toolName}.`, modelId: null }),
    })
    const raw = await res.text()
    expect(res.status, raw.slice(0, 500)).toBe(200)
    const events: Array<{ event: string; data: any }> = []
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
    const call = events.find((e) => e.event === "tool-call" && e.data?.toolName === sdkName)
    expect(call, `no ${sdkName} tool-call in ${raw.slice(0, 800)}`).toBeDefined()
    const result = events.find(
      (e) => e.event === "tool-result" && e.data?.toolCallId === call!.data.toolCallId,
    )
    expect(result, `no tool-result for ${sdkName} in ${raw.slice(0, 800)}`).toBeDefined()
    // A parked call reaches the model as `{ blocked: true, status: "pending_approval",
    // reason, approvalRequestId, sequenced? }` (tool-bridge.ts); fold it back into
    // the gate's `{ blocked: { ... } }` envelope the assertions read.
    const r = result!.data.result
    if (r?.blocked === true) {
      return {
        blocked: {
          reason: r.reason,
          approvalRequestId: r.approvalRequestId,
          ...(r.sequenced ? { sequenced: true } : {}),
        },
      }
    }
    return r
  }

  // ── a fresh thread the actor owns ──
  async function freshThread(title: string): Promise<string> {
    const res = await api(url, "/api/threads", {
      method: "POST",
      token: actorUser.token,
      body: {
        forceCreate: true,
        participantIds: [actorUser.id],
        title,
      },
    })
    if (res.status !== 200) {
      throw new Error(`freshThread failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return res.body.data.id as string
  }

  // ── DB helpers ──
  async function fetchSyntheticApprovals(
    toolName: string,
    threadId: string,
  ): Promise<
    Array<{ id: string; status: string; metadata: Record<string, unknown>; reason: string | null }>
  > {
    return (await env.db.sql.unsafe(
      `SELECT id, status, metadata, reason
         FROM ${ks()}.approval_requests
        WHERE tool_name = $1 AND thread_id = $2 AND status = 'approved'
          AND metadata ? 'autoApprovedByPolicy'
        ORDER BY created_at ASC`,
      [toolName, threadId],
    )) as Array<{
      id: string
      status: string
      metadata: Record<string, unknown>
      reason: string | null
    }>
  }

  async function fetchApprovalById(
    requestId: string,
  ): Promise<{ id: string; status: string; tool_name: string; sequenced?: boolean } | undefined> {
    const [row] = (await env.db.sql.unsafe(
      `SELECT id, status, tool_name FROM ${ks()}.approval_requests WHERE id = $1`,
      [requestId],
    )) as Array<{ id: string; status: string; tool_name: string }>
    return row
  }

  async function countRoutineRuns(routineId: string): Promise<number> {
    const rows = (await env.db.sql.unsafe(
      `SELECT COUNT(*)::int AS c FROM ${ks()}.routine_runs WHERE routine_id = $1`,
      [routineId],
    )) as Array<{ c: number }>
    return rows[0]?.c ?? 0
  }

  async function fetchRoutineRuns(
    routineId: string,
  ): Promise<Array<{ id: string; status: string }>> {
    return (await env.db.sql.unsafe(
      `SELECT id, status FROM ${ks()}.routine_runs WHERE routine_id = $1 ORDER BY ran_at ASC`,
      [routineId],
    )) as Array<{ id: string; status: string }>
  }

  // Enqueue a durable bundled-app event onto the outbox — the EXACT row
  // `tx.queueEvent()` writes (`payload` = the full AppEvent). The e2e server's
  // outbox worker (polling `pending_events` every 100ms under NODE_ENV=test)
  // claims it, runs the durable consumers, then calls `_publishEventInternal`,
  // which fans the event out to the in-process channel handler the
  // event-routine subscriber installed. This is the REACTIVE path the net-new
  // `inventory:low` / `firmware:release` emits rely on: the live stock-poll /
  // platform-poll (which needs an offline token, out of scope) is NOT exercised
  // — given an emitted event, the subscribed routine tick must fire. We supply a
  // synthetic `entityId` (the SKU / device id) and `actorType:'system'` so the
  // audit consumer persists cleanly and the row reaches the publish step rather
  // than dead-lettering before the channel fan-out.
  //
  // The `payload` MUST be bound as a jsonb OBJECT via postgres.js `sql.json()`.
  // Binding `JSON.stringify(payload)` with a `::jsonb` cast stores a JSON *string
  // scalar* (`jsonb_typeof` = 'string'), so the outbox worker reads
  // `payload.app` as undefined and publishes a malformed
  // `undefined:undefined:undefined` event that matches no channel handler — the
  // routine never ticks. `sql.json` stores a true object, so
  // `_publishEventInternal` sees the real app/entity/action and the subscribed
  // routine fires.
  async function enqueueAppEvent(evt: {
    app: string
    entity: string
    action: string
    entityId: string
    data: { [key: string]: JsonValue }
  }): Promise<void> {
    const payload: { [key: string]: JsonValue } = {
      app: evt.app,
      entity: evt.entity,
      action: evt.action,
      entityId: evt.entityId,
      data: evt.data,
      actorId: null,
      actorType: "system",
      orgId: world.org.id,
      timestamp: new Date().toISOString(),
    }
    await env.db.sql`
      INSERT INTO ${env.db.sql.unsafe(ks())}.pending_events (org_id, payload)
      VALUES (${world.org.id}, ${env.db.sql.json(payload)})
    `
  }

  // Set a per-org auto-approve policy directly (the same row policy_set would
  // upsert). Delete-then-insert (rather than upsert) guarantees a FRESH policy id
  // every call → a fresh Redis window-counter key — so a window cap exhausted in
  // one scenario can never bleed into the next via the shared (orgId, toolName)
  // counter, even if a prior scenario failed before its own cleanup ran.
  async function setPolicy(opts: {
    toolName: string
    conditions: Array<{ path: string; op: string; value: unknown }>
    limits: Record<string, number>
    requiresScope?: string | null
    enabled?: boolean
  }): Promise<string> {
    await deletePolicy(opts.toolName)
    const [row] = (await env.db.sql.unsafe(
      `INSERT INTO ${ks()}.auto_approve_policies
         (org_id, tool_name, enabled, conditions, limits, requires_scope, created_by)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, $6, $7)
       RETURNING id`,
      [
        world.org.id,
        opts.toolName,
        opts.enabled ?? true,
        JSON.stringify(opts.conditions),
        JSON.stringify(opts.limits),
        opts.requiresScope ?? null,
        actorUser.id,
      ],
    )) as Array<{ id: string }>
    return row.id
  }

  async function deletePolicy(toolName: string): Promise<void> {
    // Deleting the row (rather than re-upserting) forces a NEW policy id on the
    // next setPolicy, which yields a fresh Redis window-counter key
    // (`aa:<org>:<policyId>:<bucket>`) — so a window cap exhausted in one scenario
    // never bleeds into the next via the shared (orgId, toolName) counter.
    await env.db.sql.unsafe(
      `DELETE FROM ${ks()}.auto_approve_policies WHERE org_id = $1 AND tool_name = $2`,
      [world.org.id, toolName],
    )
  }

  async function pollUntil<T>(
    fn: () => Promise<T | null | undefined>,
    timeoutMs = 15_000,
    intervalMs = 100,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let last: T | null | undefined
    while (Date.now() < deadline) {
      last = await fn()
      if (last) return last
      await Bun.sleep(intervalMs)
    }
    throw new Error(`pollUntil timed out after ${timeoutMs}ms (last=${JSON.stringify(last)})`)
  }

  beforeAll(async () => {
    const result = await setupScenario({
      // Shrink the event-routine coalesce window so the leading-edge tick enqueues
      // immediately (default 30s would only delay the SECOND event in a window;
      // the first always enqueues at once, but a small window keeps the test snappy
      // and avoids cross-scenario suppression bleed).
      serverEnv: { EVENT_ROUTINE_COALESCE_MS: "200" },
      seed: 83,
      org: { name: "Auto-Approve E2E Org" },
      populate: { users: { count: 2 } },
    })
    env = result.env
    world = result.world
    url = env.serverUrl

    // S7/S8 subscribe routines to BUNDLED-app emits (shopify:inventory:low,
    // social:firmware:release). A bundled app is not auto-registered like the
    // in-tree apps — it must be installed for the org so its declared emits
    // land under `${orgId}:<app>` and validateRoutineEvent accepts them (in
    // prod a routine on an un-installed app's event is correctly rejected). The
    // sandbox install route needs the built tarball, so build then install.
    for (const app of ["shopify", "social"]) {
      const build = spawnSync("bash", ["scripts/build-bundled-app.sh", app, "--skip-sign"], {
        cwd: `${import.meta.dir}/../../../../..`,
        stdio: "pipe",
        encoding: "utf8",
      })
      if (build.status !== 0) {
        throw new Error(
          `build ${app} bundle failed (${build.status}): ${build.stderr ?? build.stdout}`,
        )
      }
    }
    const shopifyInstall = await api(url, "/api/_test/shopify/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: {
        orgId: world.org.id,
        realOfflineToken: "mock-offline-token",
        realWebhookSecret: "mock-webhook-secret-event-autoapprove",
        shopDomain: "event-autoapprove.myshopify.com",
      },
    })
    if (shopifyInstall.status !== 200) {
      throw new Error(
        `shopify install-for-test failed: ${shopifyInstall.status} ${JSON.stringify(shopifyInstall.body)}`,
      )
    }
    const socialInstall = await api(url, "/api/_test/social/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId: world.org.id },
    })
    if (socialInstall.status !== 200) {
      throw new Error(
        `social install-for-test failed: ${socialInstall.status} ${JSON.stringify(socialInstall.body)}`,
      )
    }

    actorUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:threads",
        // gated test tools live under the `test` app — the write scope passes RBAC,
        // the absence of `test:approve` keeps the user a non-approver.
        "test:gated:write",
        // routine + policy authoring (read + write + policy admin: policy_set
        // is admin-only since 2026-09-28), but NOT approve.
        "kernel:routines:read",
        "kernel:routines:write",
        "kernel:policies:read",
        "kernel:policies:write",
        "kernel:policies:admin",
        "kernel:approvals:read",
        "kernel:approvals:write",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // The agent turns (scripted model) still resolve a model and meter credits.
    for (const model of MODEL_PRICING_SEED) {
      await env.db.sql.unsafe(
        `INSERT INTO ${ks()}.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
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
      `INSERT INTO ${ks()}.credit_balances (org_id, included_balance, purchased_balance, currency)
       VALUES ($1, '50.00000000', '50.00000000', 'EUR')
       ON CONFLICT (org_id) DO UPDATE SET included_balance = '50.00000000', purchased_balance = '50.00000000'`,
      [world.org.id],
    )
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  // ─── S0 — event-trigger routine: create(kind:'event') → emit event → tick runs ───
  it("S0: an enabled kind='event' routine runs a tick on its kernel event (routine_runs row)", async () => {
    // Author the event routine as the ORG ADMIN (holds `*` → the gated
    // create_routine tool auto-executes past the gate via the human bypass — the
    // click IS the approval). The routine watches `kernel:contact:create` — an
    // event the routine tick itself never re-emits (the tick posts MESSAGES, not
    // contacts), so there is no self-triggering feedback loop.
    const created = await runTool(world.admin.token, "kernel:create_routine", {
      name: `evt-routine-${Date.now()}`,
      description: "Fire a tick when a contact is created.",
      kind: "event",
      event: "kernel:contact:create",
      prompt: "A contact was created — acknowledge it briefly.",
      scopes: ["kernel:threads:read"],
      visibility: "personal",
    })
    expect(created.status).toBe(200)
    const routine = (created.body.data as { routine?: { id: string; kind: string; event: string } })
      .routine
    expect(routine).toBeDefined()
    expect(routine?.kind).toBe("event")
    // B1 persistence: the `event` column round-trips (not silently dropped).
    expect(routine?.event).toBe("kernel:contact:create")
    const routineId = routine!.id

    // No tick before the event.
    expect(await countRoutineRuns(routineId)).toBe(0)

    // Emit the domain event by performing a REAL action: resolve (create) a new
    // contact. A new contact flows tx.queueEvent → outbox → in-process dispatch →
    // the routine's event subscriber → a `routine-tick` BullMQ job. Driven by the
    // admin so the contacts-table RLS write definitely passes; the routine
    // subscribes by ORG, not user, so an admin-created contact still fires it.
    const posted = await api(url, "/api/contacts/resolve", {
      method: "POST",
      token: world.admin.token,
      body: { email: `evt-${Date.now()}@example.com`, name: "Event Trigger Contact" },
    })
    expect(posted.status).toBe(200)
    expect(typeof posted.body.data.id).toBe("string")

    // The tick worker writes a routine_runs row regardless of agent outcome
    // (succeeded / failed / skipped_*) — its existence proves the event → enqueue
    // → worker → tick round-trip fired.
    const runs = await pollUntil(async () => {
      const r = await fetchRoutineRuns(routineId)
      return r.length > 0 ? r : null
    }, 70_000)
    expect(runs.length).toBeGreaterThanOrEqual(1)
    const validStatuses = new Set([
      "succeeded",
      "failed",
      "skipped_no_credits",
      "skipped_overlap",
      "skipped_scope_mismatch",
      "output_thread_recreated",
    ])
    expect(validStatuses.has(runs[0].status)).toBe(true)
  }, 120_000)

  // ─── S1 — auto-approve UNDER threshold: the agent's gated call auto-executes + synthetic row ───
  it("S1: a matching policy auto-executes an agent's gated call under threshold and writes a synthetic approval", async () => {
    const threadId = await freshAgentThread()

    // Policy: auto-approve test:gatedEcho when the message contains the marker
    // "autopilot", at most 5 calls per (large) window. requires_scope =
    // test:gated:write — a scope the actor holds. This is the bounded-autonomy
    // envelope. ("autopilot" is chosen so the negative case below is not an
    // accidental substring of the positive marker.)
    await setPolicy({
      toolName: "test:gatedEcho",
      conditions: [{ path: "params.message", op: "contains", value: "autopilot" }],
      limits: { perCallMax: 5, windowSeconds: 86400, windowMax: 5 },
      requiresScope: "test:gated:write",
    })

    const result = await agentCall(threadId, "test:gatedEcho", { message: "autopilot echo please" })
    // Auto-executed → the handler's result is returned, NOT a blocked envelope.
    expect(result.blocked).toBeUndefined()
    expect((result as { echoed?: string }).echoed).toBe("autopilot echo please")

    // A synthetic, pre-approved approval_request is written, tagged with the policy id.
    const synthetic = await pollUntil(async () => {
      const rows = await fetchSyntheticApprovals("test:gatedEcho", threadId)
      return rows.length > 0 ? rows : null
    })
    expect(synthetic.length).toBe(1)
    expect(synthetic[0].status).toBe("approved")
    expect(synthetic[0].reason).toBe("auto_approved_by_policy")
    expect(typeof synthetic[0].metadata.autoApprovedByPolicy).toBe("string")
    expect(synthetic[0].metadata.appName).toBe("test")

    // Hermetic: drop the policy so the next gatedEcho scenario starts with a fresh
    // policy id (and thus a fresh Redis window counter).
    await deletePolicy("test:gatedEcho")
  }, 60_000)

  // ─── S2 — conditions fail (fail-closed): a non-matching gated call gates ───
  it("S2: an agent call whose params fail the policy conditions gates (fail-closed) and writes NO synthetic row", async () => {
    const threadId = await freshAgentThread()
    // A gatedEcho policy that only auto-approves when `message contains
    // "autopilot"`; a non-matching message must NOT auto-approve (conditions_failed
    // → gate). This pins the fail-closed contract: a present-but-non-matching
    // policy never opens the gate.
    await setPolicy({
      toolName: "test:gatedEcho",
      conditions: [{ path: "params.message", op: "contains", value: "autopilot" }],
      limits: { windowSeconds: 86400, windowMax: 5 },
      requiresScope: "test:gated:write",
    })
    const result = await agentCall(threadId, "test:gatedEcho", { message: "manual review needed" })
    const blocked = result.blocked
    expect(blocked).toBeDefined()
    expect(blocked?.reason).toBe("gated")
    expect(typeof blocked?.approvalRequestId).toBe("string")

    // The created approval is a real PENDING human approval, not a synthetic one.
    const row = await fetchApprovalById(blocked!.approvalRequestId!)
    expect(row?.status).toBe("pending")
    const synthetic = await fetchSyntheticApprovals("test:gatedEcho", threadId)
    expect(synthetic.length).toBe(0)

    await deletePolicy("test:gatedEcho")
  }, 60_000)

  // ─── S3 — OVER the window cap: auto-approve runs out of headroom → gates ───
  it("S3: once the policy window cap is exhausted, the agent's further matching calls gate", async () => {
    const threadId = await freshAgentThread()

    // A tight window: exactly ONE matching call auto-approves per window; the
    // second exhausts the cap and must gate. windowMax counts call-count for a
    // non-money tool (amount defaults to 1). A fresh policy id (S1/S2 deleted theirs)
    // guarantees a fresh Redis counter, so "first call" truly is the window's first.
    await setPolicy({
      toolName: "test:gatedEcho",
      conditions: [{ path: "params.message", op: "contains", value: "autopilot" }],
      limits: { windowSeconds: 86400, windowMax: 1 },
      requiresScope: "test:gated:write",
    })

    // First call — under cap → auto-executes.
    const first = await agentCall(threadId, "test:gatedEcho", { message: "autopilot one" })
    expect(first.blocked).toBeUndefined()
    expect((first as { echoed?: string }).echoed).toBe("autopilot one")

    // Second call — same window, cap exhausted → gates (window_cap → no skip).
    const second = await agentCall(threadId, "test:gatedEcho", { message: "autopilot two" })
    expect(second.blocked?.reason).toBe("gated")

    // Exactly one synthetic approval for this thread (the first, auto-approved call).
    const synthetic = await pollUntil(async () => {
      const rows = await fetchSyntheticApprovals("test:gatedEcho", threadId)
      return rows.length > 0 ? rows : null
    })
    expect(synthetic.length).toBe(1)

    await deletePolicy("test:gatedEcho")
  }, 60_000)

  // ─── S4 — a @ref-sequenced step NEVER auto-approves (the sequenced-bundle invariant) ───
  it("S4: an agent's @ref-bearing call gates even when a matching policy would auto-approve", async () => {
    const threadId = await freshAgentThread()

    // Step 1 — produce a referenceable output via a gated tool with NO policy →
    // a real PENDING approval the agent staged in this thread, with output key "value".
    const produce = await agentCall(threadId, "test:gatedProduce", { seed: "alpha" })
    const producerId = produce.blocked?.approvalRequestId
    expect(typeof producerId).toBe("string")
    const refToken = buildRefToken(producerId!, "value")

    // Policy that WOULD auto-approve test:gatedConsume (no conditions, ample cap,
    // requires a scope the actor holds) — so ONLY the @ref-before-policy ordering
    // can keep the call gated. The sharp test.
    await setPolicy({
      toolName: "test:gatedConsume",
      conditions: [],
      limits: { windowSeconds: 86400, windowMax: 100 },
      requiresScope: "test:gated:write",
    })

    // Step 2 — consume the produced value by embedding the @ref token in a param.
    // findRefTokens runs BEFORE evaluateAutoApprove in computeSkipGate, so this
    // gates as a sequenced step and NEVER auto-approves.
    const consume = await agentCall(threadId, "test:gatedConsume", {
      note: `use ${refToken}`,
      label: "seq",
    })
    const blocked = consume.blocked
    expect(blocked).toBeDefined()
    expect(blocked?.reason).toBe("gated")
    expect(blocked?.sequenced).toBe(true)

    // No synthetic auto-approval for the consume step — the policy did NOT fire.
    const synthetic = await fetchSyntheticApprovals("test:gatedConsume", threadId)
    expect(synthetic.length).toBe(0)
  }, 60_000)

  // ─── S5 — a person's own call is never answered by a policy, and never parks ───
  // Approvals are for agents, not persons. A person's own call from the app
  // (REST, origin human-ui) is decided by the tool's OWN permission: this
  // person holds kernel:policies:admin (policy_set's scope) but not
  // kernel:approve, and the call RUNS on their authority, even on a tainted
  // thread of a hardened org with a policy that would auto-approve the tool for
  // an agent. No policy answers it and nothing parks: no synthetic row, no
  // pending approval. (The agent-turn taint path is covered in execute-tool's
  // own tests.)
  it("S5: an auto-approve policy never answers a person's click: it runs on their scope, nothing parks", async () => {
    const threadId = await freshThread(`taint-${Date.now()}`)
    await env.db.sql.unsafe(
      `UPDATE ${ks()}.threads SET tainted = true WHERE id = $1 AND org_id = $2`,
      [threadId, world.org.id],
    )
    await env.db.sql.unsafe(
      `UPDATE ${ks()}.organizations
          SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{webContentProtection}', '"hardened"'::jsonb)
        WHERE id = $1`,
      [world.org.id],
    )
    try {
      // A policy that WOULD auto-approve policy_set for an agent turn.
      await setPolicy({
        toolName: "kernel:policy_set",
        conditions: [],
        limits: { windowSeconds: 86400, windowMax: 100 },
        requiresScope: null,
      })

      const res = await runTool(
        actorUser.token,
        "kernel:policy_set",
        { toolName: "test:gatedProduce", enabled: true, conditions: [], limits: { windowMax: 9 } },
        threadId,
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.data?.blocked).toBeUndefined()
      const written = (await env.db.sql.unsafe(
        `SELECT id FROM ${ks()}.auto_approve_policies WHERE org_id = $1 AND tool_name = $2`,
        [world.org.id, "test:gatedProduce"],
      )) as Array<{ id: string }>
      expect(written.length).toBe(1)

      // Nothing parked: neither a synthetic auto-approval nor a pending approval.
      const synthetic = await fetchSyntheticApprovals("kernel:policy_set", threadId)
      expect(synthetic.length).toBe(0)
      const anyRow = (await env.db.sql.unsafe(
        `SELECT id FROM ${ks()}.approval_requests WHERE tool_name = $1 AND thread_id = $2`,
        ["kernel:policy_set", threadId],
      )) as Array<{ id: string }>
      expect(anyRow.length).toBe(0)
    } finally {
      // Restore standard protection and drop the org-wide policy, whatever happened above:
      // S6 expects policy_set to gate.
      await env.db.sql.unsafe(
        `UPDATE ${ks()}.organizations
            SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{webContentProtection}', '"standard"'::jsonb)
          WHERE id = $1`,
        [world.org.id],
      )
      await env.db.sql.unsafe(
        `DELETE FROM ${ks()}.auto_approve_policies WHERE org_id = $1 AND tool_name = ANY($2)`,
        [world.org.id, ["kernel:policy_set", "test:gatedProduce"]],
      )
    }
  }, 60_000)

  // ─── S6 — policy_set itself is gated for an agent (no self-widening of autonomy) ───
  it("S6: policy_set is itself gated — an agent cannot silently widen its autonomy", async () => {
    const threadId = await freshAgentThread()
    // The target tool name is unique to this scenario so the assertion is
    // self-contained: no auto-approve policy covers `kernel:policy_set` (S5 deleted
    // its one), the org is not hardened here, and the actor lacks kernel:approve →
    // the gated authoring tool parks for a human approval rather than executing.
    const targetTool = `test:policyset_gate_probe_${Date.now()}`

    // Pre-state: no policy row for the target tool.
    const before = (await env.db.sql.unsafe(
      `SELECT id FROM ${ks()}.auto_approve_policies WHERE org_id = $1 AND tool_name = $2`,
      [world.org.id, targetTool],
    )) as Array<{ id: string }>
    expect(before.length).toBe(0)

    const result = await agentCall(threadId, "kernel:policy_set", {
      toolName: targetTool,
      enabled: true,
      conditions: [],
      limits: { windowMax: 50 },
    })
    const blocked = result.blocked
    expect(blocked).toBeDefined()
    expect(blocked?.reason).toBe("gated")
    expect(typeof blocked?.approvalRequestId).toBe("string")

    // It created a real pending approval for policy_set itself…
    const row = await fetchApprovalById(blocked!.approvalRequestId!)
    expect(row?.status).toBe("pending")
    expect(row?.tool_name).toBe("kernel:policy_set")

    // …and the policy row was NOT written: the upsert only runs on DECIDED
    // execution, never at the gate. The autonomy rule stays un-widened.
    const after = (await env.db.sql.unsafe(
      `SELECT id FROM ${ks()}.auto_approve_policies WHERE org_id = $1 AND tool_name = $2`,
      [world.org.id, targetTool],
    )) as Array<{ id: string }>
    expect(after.length).toBe(0)
  }, 60_000)

  // ─── S7 — Module B Task B3 emit `shopify:inventory:low` drives the REACTIVE routine tick ───
  it("S7: an event routine on shopify:inventory:low fires a tick when that net-new emit is published", async () => {
    // Author the event routine as the ORG ADMIN (holds `*` → the gated
    // create_routine auto-executes past the gate via the human bypass). It
    // watches `shopify:inventory:low`. This asserts the REACTIVE path only:
    // given an emitted inventory:low event, the
    // subscribed routine tick runs.
    const created = await runTool(world.admin.token, "kernel:create_routine", {
      name: `inv-low-routine-${Date.now()}`,
      description: "React to a low-stock SKU by reordering or alerting.",
      kind: "event",
      event: "shopify:inventory:low",
      prompt: "A SKU fell below its re-order threshold — flag it.",
      scopes: ["kernel:threads:read"],
      visibility: "personal",
    })
    expect(created.status).toBe(200)
    const routine = (created.body.data as { routine?: { id: string; kind: string; event: string } })
      .routine
    expect(routine).toBeDefined()
    expect(routine?.kind).toBe("event")
    // B3 persistence: the `event` column round-trips the bundled-app emit string.
    expect(routine?.event).toBe("shopify:inventory:low")
    const routineId = routine!.id

    // No tick before the event.
    expect(await countRoutineRuns(routineId)).toBe(0)

    // Publish the net-new `inventory:low` emit through the SAME outbox path a
    // real handler uses (`tx.queueEvent` → pending_events → outbox worker →
    // _publishEventInternal → channel handler → the routine subscriber). Payload
    // mirrors shopify's documented InventoryLowPayload (sku/available/threshold/
    // locationId) so the emit is faithful, not a bare ping.
    await enqueueAppEvent({
      app: "shopify",
      entity: "inventory",
      action: "low",
      entityId: "sku-A100",
      data: { sku: "sku-A100", available: 2, threshold: 10, locationId: "loc-1" },
    })

    // The tick worker writes a routine_runs row regardless of agent outcome —
    // its existence proves the emit → enqueue → worker → tick round-trip fired
    // off the reactive subscription (not a live poll).
    const runs = await pollUntil(async () => {
      const r = await fetchRoutineRuns(routineId)
      return r.length > 0 ? r : null
    }, 70_000)
    expect(runs.length).toBeGreaterThanOrEqual(1)
    const validStatuses = new Set([
      "succeeded",
      "failed",
      "skipped_no_credits",
      "skipped_overlap",
      "skipped_scope_mismatch",
      "output_thread_recreated",
    ])
    expect(validStatuses.has(runs[0].status)).toBe(true)
  }, 120_000)

  // ─── S8 — Module B Task B3 emit `social:firmware:release` drives the REACTIVE routine tick ───
  it("S8: an event routine on social:firmware:release fires a tick when that net-new emit is published", async () => {
    // The second net-new Module B emit (social manifest declares
    // `firmware:release` in events.emits). Same reactive contract as S7: an
    // emitted firmware:release event drives the subscribed routine's tick. Driven
    // through the real outbox so the assertion proves the end-to-end event →
    // subscriber → routine-tick → routine_runs round-trip.
    const created = await runTool(world.admin.token, "kernel:create_routine", {
      name: `fw-release-routine-${Date.now()}`,
      description: "React to a firmware release surfaced on a watched social source.",
      kind: "event",
      event: "social:firmware:release",
      prompt: "A firmware release was detected — summarize it for the team.",
      scopes: ["kernel:threads:read"],
      visibility: "personal",
    })
    expect(created.status).toBe(200)
    const routine = (created.body.data as { routine?: { id: string; kind: string; event: string } })
      .routine
    expect(routine).toBeDefined()
    expect(routine?.kind).toBe("event")
    expect(routine?.event).toBe("social:firmware:release")
    const routineId = routine!.id

    // No tick before the event.
    expect(await countRoutineRuns(routineId)).toBe(0)

    // Publish the `firmware:release` emit via the outbox; the subscribed routine
    // must tick in response.
    await enqueueAppEvent({
      app: "social",
      entity: "firmware",
      action: "release",
      entityId: "fw-v2.1.0",
      data: { product: "controller", version: "2.1.0", channel: "stable" },
    })

    const runs = await pollUntil(async () => {
      const r = await fetchRoutineRuns(routineId)
      return r.length > 0 ? r : null
    }, 70_000)
    expect(runs.length).toBeGreaterThanOrEqual(1)
    const validStatuses = new Set([
      "succeeded",
      "failed",
      "skipped_no_credits",
      "skipped_overlap",
      "skipped_scope_mismatch",
      "output_thread_recreated",
    ])
    expect(validStatuses.has(runs[0].status)).toBe(true)
  }, 120_000)

  // ─── S9 — policy_get: the ungated read reflects exactly what policy_set wrote ───
  it("S9: policy_get returns the org's auto_approve_policies and is NOT gated", async () => {
    // policy_get is a read-only kernel tool (scope kernel:policies:read, NOT
    // gated/trustBoundary). The actor holds the read scope but is a non-approver,
    // so a clean projected read here — never a `blocked` envelope — pins that
    // introspection does not require an approval round-trip.
    const probeTool = `test:policyget_probe_${Date.now()}`

    // Seed one policy directly via the same row `policy_set` upserts, then assert
    // the read reflects it. Unique tool name so the assertion is self-contained
    // amid the other scenarios' policies on this shared org.
    const policyId = await setPolicy({
      toolName: probeTool,
      conditions: [{ path: "params.message", op: "contains", value: "autopilot" }],
      limits: { perCallMax: 3, windowSeconds: 3600, windowMax: 7 },
      requiresScope: "test:gated:write",
    })

    const res = await runTool(actorUser.token, "kernel:policy_get", {})
    expect(res.status).toBe(200)
    // Ungated: a plain projected read, never a gate.
    expect(res.body.data?.blocked).toBeUndefined()

    const policies = (
      res.body.data as {
        policies?: Array<{
          id: string
          toolName: string
          enabled: boolean
          conditions: Array<{ path: string; op: string; value: unknown }>
          limits: Record<string, number>
          requiresScope: string | null
        }>
      }
    ).policies
    expect(Array.isArray(policies)).toBe(true)

    // The exact row policy_set wrote is reflected back — id + the conditions/
    // limits/requiresScope that were persisted (the projected shape from
    // handlePolicyGet), not a stub.
    const mine = policies?.find((p) => p.id === policyId)
    expect(mine).toBeDefined()
    expect(mine?.toolName).toBe(probeTool)
    expect(mine?.enabled).toBe(true)
    expect(mine?.requiresScope).toBe("test:gated:write")
    expect(mine?.limits.perCallMax).toBe(3)
    expect(mine?.limits.windowMax).toBe(7)
    expect(mine?.limits.windowSeconds).toBe(3600)
    expect(mine?.conditions).toEqual([
      { path: "params.message", op: "contains", value: "autopilot" },
    ])

    // Hermetic: drop the probe policy so it does not bleed into other reads.
    await deletePolicy(probeTool)
  }, 60_000)
})
