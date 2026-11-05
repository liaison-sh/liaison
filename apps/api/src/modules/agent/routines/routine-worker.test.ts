// SPDX-License-Identifier: FSL-1.1-ALv2
// T5.2 — routineWorker.runTick lifecycle tests.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  agents as agentsTbl,
  messages as kernelMessages,
  routineRuns,
  routines as routinesTbl,
  threadParticipants,
  threads,
  users,
} from "~/db/schema/kernel"
import { redis } from "~/lib/redis"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { currentRunContext, type RunContext } from "~/modules/agent/runtime/run-context"
import { createTestOrg } from "~/tests/helpers/org"
import { clearRedisPatterns } from "~/tests/route-test-setup"

async function setup(): Promise<{ orgId: string; userId: string }> {
  const org = await createTestOrg()
  const userId = await withSystemDb("rw-test-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: `rw-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Routine Tester",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  return { orgId: org.id, userId }
}

async function makeRoutine(opts: {
  orgId: string
  userId: string
  enabled?: boolean
  status?: "active" | "paused_user" | "paused_scope_mismatch" | "paused_no_credits" | "completed"
  scopes?: string[]
  kind?: "recurring" | "scheduled"
  cron?: string | null
  timezone?: string | null
  runAt?: Date | null
  visibility?: "personal" | "shared"
  ownerAgentId?: string
  tokenBudget?: number | null
  hardTokenLimit?: number | null
}): Promise<typeof routinesTbl.$inferSelect> {
  const kind = opts.kind ?? "recurring"
  const [row] = await withPrivilegedDb(opts.orgId, "rw-routine-seed", (tx) =>
    tx
      .insert(routinesTbl)
      .values({
        orgId: opts.orgId,
        ownerUserId: opts.userId,
        name: `rw-${crypto.randomUUID().slice(0, 8)}`,
        description: "Test routine",
        kind,
        cron: opts.cron !== undefined ? opts.cron : kind === "recurring" ? "0 9 * * *" : null,
        timezone: opts.timezone !== undefined ? opts.timezone : kind === "recurring" ? "UTC" : null,
        runAt: opts.runAt !== undefined ? opts.runAt : null,
        prompt: "say hi",
        scopes: opts.scopes ?? [],
        enabled: opts.enabled ?? true,
        status: opts.status ?? "active",
        visibility: opts.visibility ?? "personal",
        createdByUserId: opts.userId,
        createdByActorType: "user",
        ...(opts.ownerAgentId ? { ownerAgentId: opts.ownerAgentId } : {}),
        ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
        ...(opts.hardTokenLimit !== undefined ? { hardTokenLimit: opts.hardTokenLimit } : {}),
      })
      .returning(),
  )
  return row
}

/** An agent of this org with exactly the given ceiling. */
async function makeAgent(orgId: string, scopeCeiling: string[]): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "rw-agent-seed", (tx) =>
    tx
      .insert(agentsTbl)
      .values({
        orgId,
        kind: "role",
        handle: `@rw-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Ceiling Test",
        scopeCeiling,
        systemPrompt: "",
      })
      .returning({ id: agentsTbl.id }),
  )
  return row.id
}

describe("routine-worker — runRoutineTick lifecycle", () => {
  let orgId: string
  let userId: string

  beforeAll(async () => {
    const s = await setup()
    orgId = s.orgId
    userId = s.userId
  })

  afterAll(async () => {
    // The orgs created via createTestOrg accumulate per file run; relying on
    // its built-in cleanup hook in the global afterAll.
  })

  beforeEach(async () => {
    // Clear any stale lock from a prior test.
    await clearRedisPatterns(["routine-lock:*"])
  })

  afterEach(async () => {
    await withPrivilegedDb(orgId, "rw-cleanup", async (tx) => {
      await tx.delete(routineRuns).where(eq(routineRuns.orgId, orgId))
      await tx.delete(routinesTbl).where(eq(routinesTbl.orgId, orgId))
    })
  })

  it("orphan: missing routine row → returns no_run (scheduler removal attempted)", async () => {
    const result = await runRoutineTick({
      orgId,
      routineId: "00000000-0000-0000-0000-000000000999",
      scheduledAt: new Date().toISOString(),
    })
    expect(result.status).toBe("no_run")
  })

  it("disabled routine → returns no_run; no run row written", async () => {
    const r = await makeRoutine({ orgId, userId, enabled: false })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
    })
    expect(result.status).toBe("no_run")
    const rows = await withPrivilegedDb(orgId, "rw-check", (tx) =>
      tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
    )
    expect(rows.length).toBe(0)
  })

  it("paused_user status → returns no_run; no run row written", async () => {
    const r = await makeRoutine({ orgId, userId, status: "paused_user" })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
    })
    expect(result.status).toBe("no_run")
  })

  it("scope drift: routine.scopes ⊄ owner.scopes → skipped_scope_mismatch + paused_scope_mismatch", async () => {
    const r = await makeRoutine({
      orgId,
      userId,
      scopes: ["kernel:users:admin"], // owner doesn't have this
    })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["kernel:threads:read"],
    })
    expect(result.status).toBe("skipped_scope_mismatch")

    const after = await withPrivilegedDb(orgId, "rw-check-paused", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(after[0].status).toBe("paused_scope_mismatch")
    const runs = await withPrivilegedDb(orgId, "rw-check-runs", (tx) =>
      tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
    )
    expect(runs[0].status).toBe("skipped_scope_mismatch")
    // D20: the reason names the scope AND says how to fix it (the routine editor's Scopes
    // picker, or the agent), so the person reading it knows what to do next.
    expect(runs[0].error).toContain("kernel:users:admin")
    expect(runs[0].error).toContain("Scopes")
    expect(runs[0].error).toContain("agent")
  })

  it("owner agent with an empty ceiling: skipped_scope_mismatch + paused_scope_mismatch", async () => {
    // A tick runs at its owner agent's ceiling, unfloored, and a tool the actor
    // holds no scope for is not in the catalog at all. An empty ceiling is an
    // empty tool set, so the tick would report success having been refused
    // every call it made (T26 F8: @base owns every orphaned routine).
    const ownerAgentId = await makeAgent(orgId, [])
    const r = await makeRoutine({ orgId, userId, ownerAgentId })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["kernel:threads:read"],
      checkCredits: async () => null,
      agentInvoker: async () => {
        throw new Error("the tick must not reach the agent at an empty ceiling")
      },
    })
    expect(result.status).toBe("skipped_scope_mismatch")
    const after = await withPrivilegedDb(orgId, "rw-check-empty-ceiling", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(after[0].status).toBe("paused_scope_mismatch")
    const runs = await withPrivilegedDb(orgId, "rw-check-empty-ceiling-runs", (tx) =>
      tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
    )
    expect(runs[0].status).toBe("skipped_scope_mismatch")
    expect(runs[0].error).toContain("no scopes")
  })

  it("owner agent whose ceiling covers none of the routine's scopes: skipped and paused", async () => {
    // SK-2: the emptiness check passed this shape. The ceiling is non-empty and
    // real, and it covers nothing the routine asks for, so the tick ran with a
    // catalog holding none of the routine's tools and reported success having
    // done nothing. Without the coverage check this case reaches the invoker
    // and the assertion below fires.
    const ownerAgentId = await makeAgent(orgId, ["kernel:threads:read"])
    const r = await makeRoutine({
      orgId,
      userId,
      ownerAgentId,
      scopes: ["invoicing:documents:write"],
    })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["invoicing:documents:write"],
      checkCredits: async () => null,
      agentInvoker: async () => {
        throw new Error("the tick must not reach the agent at a ceiling that covers nothing")
      },
    })
    expect(result.status).toBe("skipped_scope_mismatch")
    const after = await withPrivilegedDb(orgId, "rw-check-uncovered-ceiling", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(after[0].status).toBe("paused_scope_mismatch")
    // The reason a person reads, naming the scope, not an enum.
    expect(after[0].lastRunError).toContain("invoicing:documents:write")
    const runs = await withPrivilegedDb(orgId, "rw-check-uncovered-ceiling-runs", (tx) =>
      tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
    )
    expect(runs[0].status).toBe("skipped_scope_mismatch")
    expect(runs[0].error).toContain("invoicing:documents:write")
    expect(runs[0].error).toContain("Paused:")
    expect(runs[0].error).toContain("Scopes")
  })

  it("owner agent whose ceiling covers the routine through a glob still ticks", async () => {
    // The other direction, so the new check cannot be tightened into a pause
    // for every glob ceiling: `mcp:jira:*` covers `mcp:jira:read`.
    const ownerAgentId = await makeAgent(orgId, ["mcp:jira:*"])
    const r = await makeRoutine({ orgId, userId, ownerAgentId, scopes: ["mcp:jira:read"] })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["mcp:jira:*"],
      checkCredits: async () => null,
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })
    expect(result.status).toBe("succeeded")
  })

  it("owner agent with a real ceiling still ticks", async () => {
    const ownerAgentId = await makeAgent(orgId, ["kernel:threads:read"])
    const r = await makeRoutine({ orgId, userId, ownerAgentId })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["kernel:threads:read"],
      checkCredits: async () => null,
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })
    expect(result.status).toBe("succeeded")
  })

  it("B13: a `:*` glob grant covers the routine's scope — NOT paused for scope mismatch", async () => {
    // An MCP-backed routine requires `mcp:jira:read`; the owner holds the `mcp:jira:*` glob.
    // The canonical isScopeCovered predicate covers it, so the tick must proceed (not pause).
    const r = await makeRoutine({ orgId, userId, scopes: ["mcp:jira:read"] })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["mcp:jira:*"],
      checkCredits: async () => null,
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })
    expect(result.status).toBe("succeeded")
    const after = await withPrivilegedDb(orgId, "rw-check-not-paused", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(after[0].status).toBe("active")
    const skipped = await withPrivilegedDb(orgId, "rw-check-no-skip", (tx) =>
      tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
    )
    expect(skipped.some((row) => row.status === "skipped_scope_mismatch")).toBe(false)
  })

  it("no credits: checkCredits returns a reason → skipped_no_credits + paused_no_credits", async () => {
    const r = await makeRoutine({ orgId, userId })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => "insufficient balance",
    })
    expect(result.status).toBe("skipped_no_credits")
    const after = await withPrivilegedDb(orgId, "rw-check-paused", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(after[0].status).toBe("paused_no_credits")
  })

  // A demo visitor's gate ("confirm your email", their own budget) is not the org
  // running out of credits: it skips the tick, recorded, and never pauses the
  // routine. Paused, the live ticket after the visitor confirmed their email
  // was dropped by the status check and its scenario waited forever.
  it("a refusal that does not pause (a demo visitor gate): skipped_no_credits, routine stays active", async () => {
    const r = await makeRoutine({ orgId, userId })
    const reason = "Confirm your email to run the agents on this demo."
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => ({ reason, pause: false }),
    })
    expect(result.status).toBe("skipped_no_credits")
    const [after] = await withPrivilegedDb(orgId, "rw-check-demo-refusal", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(after?.status).toBe("active")
    expect(after?.lastRunStatus).toBe("skipped_no_credits")
    expect(after?.lastRunError).toBe(reason)
    const runs = await withPrivilegedDb(orgId, "rw-check-demo-refusal-runs", (tx) =>
      tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
    )
    expect(runs.map((x) => [x.status, x.error])).toEqual([["skipped_no_credits", reason]])
  })

  it("a routine paused for credits resumes and runs once its credit check passes", async () => {
    const r = await makeRoutine({ orgId, userId, status: "paused_no_credits" })
    let invoked = 0
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => {
        invoked++
        return { turnsAdded: 1 }
      },
    })
    expect(result.status).toBe("succeeded")
    expect(invoked).toBe(1)
    const [after] = await withPrivilegedDb(orgId, "rw-check-resumed", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(after?.status).toBe("active")
  })

  it("a routine paused for credits that is still out records the skip, stays paused, alerts no one again", async () => {
    const r = await makeRoutine({ orgId, userId, status: "paused_no_credits" })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => "insufficient balance",
    })
    expect(result.status).toBe("skipped_no_credits")
    const [after] = await withPrivilegedDb(orgId, "rw-check-still-paused", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(after?.status).toBe("paused_no_credits")
    const runs = await withPrivilegedDb(orgId, "rw-check-still-paused-runs", (tx) =>
      tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
    )
    expect(runs.map((x) => x.status)).toEqual(["skipped_no_credits"])
    expect(await routineAlertsFor(r.id)).toEqual([])
  })

  it("a routine a demo refusal once paused goes back to active on its next refused tick", async () => {
    const r = await makeRoutine({ orgId, userId, status: "paused_no_credits" })
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => ({ reason: "Confirm your email.", pause: false }),
    })
    const [after] = await withPrivilegedDb(orgId, "rw-check-demo-unpaused", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(after?.status).toBe("active")
  })

  it("a tick on a routine paused for scopes records the skip with the pause's reason", async () => {
    const r = await makeRoutine({ orgId, userId, status: "paused_scope_mismatch" })
    await withPrivilegedDb(orgId, "rw-scope-paused-reason", (tx) =>
      tx
        .update(routinesTbl)
        .set({ lastRunError: "Paused: the owner no longer holds tickets:tickets:read." })
        .where(eq(routinesTbl.id, r.id)),
    )
    let invoked = 0
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      agentInvoker: async () => {
        invoked++
        return { turnsAdded: 1 }
      },
    })
    expect(result.status).toBe("skipped_scope_mismatch")
    expect(invoked).toBe(0)
    const runs = await withPrivilegedDb(orgId, "rw-check-scope-paused-runs", (tx) =>
      tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
    )
    expect(runs.map((x) => [x.status, x.error])).toEqual([
      ["skipped_scope_mismatch", "Paused: the owner no longer holds tickets:tickets:read."],
    ])
  })

  it("happy path queues a DURABLE routine:run_completed event on the outbox (B4, F2)", async () => {
    // F2 — run_completed is a durable transition: it now rides the transactional
    // outbox (tx.queueEvent) instead of broadcastEphemeral, so it survives a crash
    // and replays on reconnect. Assert a pending_events row exists with the exact
    // frame shape the frontend routine handler consumes.
    const r = await makeRoutine({ orgId, userId })
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })

    const { sql } = await import("~/db/connection")
    const { schemaRef } = await import("~/db/schema-ref")
    const table = `${schemaRef("kernel")}.pending_events`
    const rows = await sql.unsafe(
      `SELECT payload FROM ${table}
       WHERE org_id = $1
         AND (payload->>'entity') = 'routine'
         AND (payload->>'action') = 'run_completed'
         AND (payload->>'entityId') = $2`,
      [orgId, r.id],
    )
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const payload = rows[0].payload as {
      entity: string
      action: string
      entityId: string
      actorId: string
      orgId: string
      data: { status?: string }
    }
    expect(payload.entity).toBe("routine")
    expect(payload.action).toBe("run_completed")
    expect(payload.entityId).toBe(r.id)
    expect(payload.actorId).toBe(userId)
    expect(payload.orgId).toBe(orgId)
    expect(payload.data.status).toBe("succeeded")
  })

  // A guided tour waiting on a routine says what that routine is doing (owner,
  // 2026-10-25): the run's start is said live, and every run row's outcome
  // names the event's entity, so a client can tell the run on ITS ticket.
  it("an event tick says live that it started, and its outcome names the event's entity", async () => {
    const r = await makeRoutine({ orgId, userId })
    const { spyOn } = await import("bun:test")
    const eventBus = await import("~/infra/events/event-bus")
    const broadcast = spyOn(eventBus, "broadcastEphemeral").mockResolvedValue(undefined)
    const ticketId = `t-${crypto.randomUUID()}`
    let startedSeen = false
    try {
      await runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        triggerEvent: {
          app: "tickets",
          entity: "ticket",
          action: "create",
          entityId: ticketId,
          data: null,
          origin: "internal",
        },
        loadOwnerScopes: async () => ["*"],
        checkCredits: async () => null,
        agentInvoker: async () => {
          // Said before the agent runs, never after.
          startedSeen = broadcast.mock.calls.some(
            (c) => c[0].entity === "routine" && c[0].action === "run_started",
          )
          return { turnsAdded: 1 }
        },
      })
      expect(startedSeen).toBe(true)
      const started = broadcast.mock.calls
        .map((c) => c[0])
        .find((e) => e.entity === "routine" && e.action === "run_started")
      expect(started?.entityId).toBe(r.id)
      expect(started?.data).toMatchObject({
        routineId: r.id,
        routineName: r.name,
        eventEntityId: ticketId,
        trigger: "event",
      })
      expect(typeof (started?.data as { startedAt?: unknown } | undefined)?.startedAt).toBe(
        "string",
      )
    } finally {
      broadcast.mockRestore()
    }
    const { sql } = await import("~/db/connection")
    const { schemaRef } = await import("~/db/schema-ref")
    const rows = await sql.unsafe(
      `SELECT payload FROM ${schemaRef("kernel")}.pending_events
       WHERE org_id = $1 AND (payload->>'entity') = 'routine'
         AND (payload->>'action') = 'run_completed' AND (payload->>'entityId') = $2`,
      [orgId, r.id],
    )
    expect(rows.length).toBe(1)
    expect((rows[0].payload as { data: unknown }).data).toMatchObject({
      status: "succeeded",
      eventEntityId: ticketId,
      routineName: r.name,
    })
  })

  it("a skipped event tick's outcome is said too, with why, naming the event's entity", async () => {
    const r = await makeRoutine({ orgId, userId })
    const ticketId = `t-${crypto.randomUUID()}`
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      triggerEvent: {
        app: "tickets",
        entity: "ticket",
        action: "create",
        entityId: ticketId,
        data: null,
        origin: "internal",
      },
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => "No model is set up",
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })
    expect(result.status).toBe("skipped_no_credits")
    const { sql } = await import("~/db/connection")
    const { schemaRef } = await import("~/db/schema-ref")
    const rows = await sql.unsafe(
      `SELECT payload FROM ${schemaRef("kernel")}.pending_events
       WHERE org_id = $1 AND (payload->>'entity') = 'routine'
         AND (payload->>'action') = 'run_completed' AND (payload->>'entityId') = $2`,
      [orgId, r.id],
    )
    expect(rows.length).toBe(1)
    expect((rows[0].payload as { data: unknown }).data).toMatchObject({
      status: "skipped_no_credits",
      error: "No model is set up",
      eventEntityId: ticketId,
      run: { id: result.runId, status: "skipped_no_credits" },
    })
  })

  // UX gap fix: a run_routine_now's agent output lands only in the routine's output
  // thread, so a requester who isn't watching that thread would otherwise see no
  // sign their approved run-now ever happened. When the tick carries
  // `requestedByUserId` (set only for a manual run-now), the worker must post a
  // `kernel:agent_notification:create` event targeting that requester, linking to
  // the output thread — the SAME event shape/tool `notify_user` emits.
  it("run-now tick notifies the requester with a link to the output thread", async () => {
    const r = await makeRoutine({ orgId, userId })
    const requesterId = await withSystemDb("rw-run-now-requester", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `rw-requester-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Run-now Requester",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      requestedByUserId: requesterId,
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })
    expect(result.status).toBe("succeeded")

    const { sql } = await import("~/db/connection")
    const { schemaRef } = await import("~/db/schema-ref")
    const table = `${schemaRef("kernel")}.pending_events`
    const rows = await sql.unsafe(
      `SELECT payload FROM ${table}
       WHERE org_id = $1
         AND (payload->>'entity') = 'agent_notification'
         AND (payload->>'action') = 'create'`,
      [orgId],
    )
    const notif = rows
      .map(
        (row) =>
          row.payload as {
            entity: string
            action: string
            actorId: string
            orgId: string
            data: {
              summary?: string
              targetUserIds?: string[]
              link?: { tabType: string; entityId: string }
            }
          },
      )
      .find((p) => p.data.targetUserIds?.includes(requesterId))
    expect(notif).toBeDefined()
    expect(notif?.data.link?.tabType).toBe("thread")
    // Output thread id resolved from the fresh routine row.
    const after = await withPrivilegedDb(orgId, "rw-check-output-thread", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(notif?.data.link?.entityId).toBe(after[0].outputThreadId ?? undefined)
    expect(notif?.data.summary).toContain(r.name)
  })

  it("cron/scheduled ticks (no requestedByUserId) do NOT emit a requester notification", async () => {
    const r = await makeRoutine({ orgId, userId })
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })
    const { sql } = await import("~/db/connection")
    const { schemaRef } = await import("~/db/schema-ref")
    const table = `${schemaRef("kernel")}.pending_events`
    // Scoped to THIS routine's name (pending_events is not cleaned between tests within
    // this org, so an unscoped query would pick up a prior test's notification row).
    const rows = await sql.unsafe(
      `SELECT payload FROM ${table}
       WHERE org_id = $1
         AND (payload->>'entity') = 'agent_notification'
         AND (payload->>'action') = 'create'
         AND (payload->'data'->>'summary') LIKE $2`,
      [orgId, `%${r.name}%`],
    )
    expect(rows.length).toBe(0)
  })

  // D21: a SCHEDULED run that fails or pauses used to reach nobody: only a
  // run-now requester got a Home item, a scheduled tick sent a status frame
  // to the Routines screen and nothing else. The owner now gets one Home item
  // per routine (keyed on the routine, so repeated failures do not pile up),
  // marked `routineAlert` so Home files it under "Routines failed or paused".
  async function routineAlertsFor(routineId: string) {
    const { sql } = await import("~/db/connection")
    const { schemaRef } = await import("~/db/schema-ref")
    const table = `${schemaRef("kernel")}.pending_events`
    const rows = await sql.unsafe(
      `SELECT payload FROM ${table}
       WHERE org_id = $1
         AND (payload->>'entity') = 'agent_notification'
         AND (payload->>'action') = 'create'
         AND (payload->'data'->'routineAlert'->>'routineId') = $2`,
      [orgId, routineId],
    )
    return rows.map(
      (row) =>
        row.payload as {
          entityId: string
          data: {
            summary: string
            urgency: number
            targetUserIds: string[]
            routineAlert: { routineId: string; status: string }
            link?: { tabType: string; entityId: string }
          }
        },
    )
  }

  it("D21: a scheduled run that fails notifies the routine's owner", async () => {
    const r = await makeRoutine({ orgId, userId })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => {
        throw new Error("boom")
      },
    })
    expect(result.status).toBe("failed")
    const alerts = await routineAlertsFor(r.id)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.data.targetUserIds).toEqual([userId])
    expect(alerts[0]?.data.routineAlert.status).toBe("failed")
    expect(alerts[0]?.entityId).toBe(r.id)
    expect(alerts[0]?.data.summary).toContain(r.name)
    // An FYI tier, not a "needs you now" one: it is filed under Agents.
    expect(alerts[0]?.data.urgency).toBeLessThan(70)
    const after = await withPrivilegedDb(orgId, "rw-alert-thread", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    expect(alerts[0]?.data.link).toEqual({
      tabType: "thread",
      entityId: after[0]?.outputThreadId ?? "",
    })
  })

  it("D21: a scheduled run paused for scopes or credits notifies the owner", async () => {
    const drift = await makeRoutine({ orgId, userId, scopes: ["tickets:tickets:read"] })
    await runRoutineTick({
      orgId,
      routineId: drift.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => [],
    })
    const driftAlerts = await routineAlertsFor(drift.id)
    expect(driftAlerts.map((a) => a.data.routineAlert.status)).toEqual(["paused_scope_mismatch"])
    expect(driftAlerts[0]?.data.targetUserIds).toEqual([userId])

    const broke = await makeRoutine({ orgId, userId })
    await runRoutineTick({
      orgId,
      routineId: broke.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => "insufficient balance",
    })
    const creditAlerts = await routineAlertsFor(broke.id)
    expect(creditAlerts.map((a) => a.data.routineAlert.status)).toEqual(["paused_no_credits"])
  })

  it("D21: a failed run-now by the owner notifies them once, as a routine alert", async () => {
    const r = await makeRoutine({ orgId, userId })
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      requestedByUserId: userId,
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => {
        throw new Error("boom")
      },
    })
    const { sql } = await import("~/db/connection")
    const { schemaRef } = await import("~/db/schema-ref")
    const table = `${schemaRef("kernel")}.pending_events`
    const all = await sql.unsafe(
      `SELECT payload FROM ${table}
       WHERE org_id = $1
         AND (payload->>'entity') = 'agent_notification'
         AND (payload->'data'->>'summary') LIKE $2`,
      [orgId, `%${r.name}%`],
    )
    expect(all).toHaveLength(1)
    expect((await routineAlertsFor(r.id)).map((a) => a.data.routineAlert.status)).toEqual([
      "failed",
    ])
  })

  it("scope drift emits routine:status with paused_scope_mismatch (B4)", async () => {
    const r = await makeRoutine({ orgId, userId, scopes: ["kernel:admin"] })
    const { spyOn } = await import("bun:test")
    const eventBus = await import("~/infra/events/event-bus")
    const broadcast = spyOn(eventBus, "broadcastEphemeral").mockResolvedValue(undefined)
    try {
      await runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => [], // user lost admin
        checkCredits: async () => null,
      })
      const events = broadcast.mock.calls.map((c) => c[0])
      const status = events.find((e) => e.entity === "routine" && e.action === "status")
      expect(status).toBeDefined()
      expect((status?.data as { status?: string } | undefined)?.status).toBe(
        "paused_scope_mismatch",
      )
    } finally {
      broadcast.mockRestore()
    }
  })

  it("happy path: invokes agent and writes succeeded run row with durationMs + turnsAdded", async () => {
    const r = await makeRoutine({ orgId, userId })
    let invoked = false
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => {
        invoked = true
        return { turnsAdded: 2 }
      },
    })
    expect(invoked).toBe(true)
    expect(result.status).toBe("succeeded")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    const runs = await withPrivilegedDb(orgId, "rw-check-runs", (tx) =>
      tx
        .select()
        .from(routineRuns)
        .where(and(eq(routineRuns.routineId, r.id), eq(routineRuns.status, "succeeded"))),
    )
    expect(runs.length).toBe(1)
    expect(runs[0].turnsAdded).toBe(2)
  })

  it("a run row names its trigger and when it started, for the agent page's run history", async () => {
    const r = await makeRoutine({ orgId, userId })
    const tick = (extra: Record<string, unknown>) =>
      runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["*"],
        checkCredits: async () => null,
        agentInvoker: async () => ({ turnsAdded: 1 }),
        ...extra,
      })
    const before = Date.now()
    await tick({})
    await tick({ requestUuid: crypto.randomUUID() })
    await tick({
      triggerEvent: {
        app: "tickets",
        entity: "ticket",
        action: "create",
        entityId: null,
        data: {},
        origin: "internal",
      },
    })
    const runs = await withPrivilegedDb(orgId, "rw-check-run-triggers", (tx) =>
      tx
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.routineId, r.id))
        .orderBy(routineRuns.ranAt),
    )
    expect(runs.map((x) => [x.trigger, x.triggerLabel])).toEqual([
      ["schedule", null],
      ["manual", null],
      ["event", "tickets.ticket.create"],
    ])
    for (const run of runs) {
      expect(run.startedAt).not.toBeNull()
      expect((run.startedAt as Date).getTime()).toBeGreaterThanOrEqual(before - 1000)
      expect((run.startedAt as Date).getTime()).toBeLessThanOrEqual(run.ranAt.getTime())
    }
  })

  // ── S17: token budget + hard limit ─────────────────────────────────────────────────────────────
  it("S17: a routine with a tokenBudget gets the budget sentence appended to its tick prompt", async () => {
    const r = await makeRoutine({ orgId, userId, tokenBudget: 4000, hardTokenLimit: 9000 })
    let prompt = ""
    let frame: RunContext | undefined
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        prompt = input.prompt
        frame = currentRunContext()
        return { turnsAdded: 1 }
      },
    })
    expect(prompt).toBe(
      "say hi\n\nYou have about 4000 tokens for this job. Plan your work to finish within it.",
    )
    // The fields travel with the run: the tick frame carries the account every
    // turn of the tick (and every agents_ask sub-run) adds its tokens to.
    expect(frame?.tokenAccount).toEqual({
      id: expect.any(String),
      tokenBudget: 4000,
      hardTokenLimit: 9000,
      used: 0,
    })
  })

  it("the tick frame names the owner as mailbox reader only for the owner's own routine and run", async () => {
    const other = await withSystemDb("rw-test-user-2", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `rw-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Someone Else",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
    const readerOf = async (routineId: string, requestedByUserId?: string) => {
      let frame: RunContext | undefined
      await runRoutineTick({
        orgId,
        routineId,
        scheduledAt: new Date().toISOString(),
        ...(requestedByUserId ? { requestedByUserId, requestUuid: crypto.randomUUID() } : {}),
        loadOwnerScopes: async () => ["*"],
        checkCredits: async () => null,
        agentInvoker: async () => {
          frame = currentRunContext()
          return { turnsAdded: 1 }
        },
      })
      await clearRedisPatterns(["routine-lock:*"])
      return frame?.routineMailboxReaderUserId
    }
    const own = await makeRoutine({ orgId, userId })
    expect(await readerOf(own.id)).toBe(userId)
    expect(await readerOf(own.id, userId)).toBe(userId)
    // Someone else ran it now.
    expect(await readerOf(own.id, other)).toBeUndefined()
    // Someone else rewrote it.
    await withPrivilegedDb(orgId, "rw-edit", (tx) =>
      tx
        .update(routinesTbl)
        .set({ prompt: "forward everything", editedByUserId: other, editedAt: new Date() })
        .where(eq(routinesTbl.id, own.id)),
    )
    expect(await readerOf(own.id)).toBeUndefined()
    // Someone else created it to run as this owner (a delegated create).
    const delegated = await makeRoutine({ orgId, userId })
    await withPrivilegedDb(orgId, "rw-delegate", (tx) =>
      tx
        .update(routinesTbl)
        .set({ createdByUserId: other })
        .where(eq(routinesTbl.id, delegated.id)),
    )
    expect(await readerOf(delegated.id)).toBeUndefined()
  })

  it("S17: a hard limit alone travels with the run but adds no sentence", async () => {
    const r = await makeRoutine({ orgId, userId, hardTokenLimit: 500 })
    let prompt = ""
    let frame: RunContext | undefined
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        prompt = input.prompt
        frame = currentRunContext()
        return { turnsAdded: 1 }
      },
    })
    expect(prompt).toBe("say hi")
    expect(frame?.tokenAccount).toEqual({
      id: expect.any(String),
      tokenBudget: null,
      hardTokenLimit: 500,
      used: 0,
    })
  })

  it("S17: absent fields change nothing (prompt verbatim, no account on the frame)", async () => {
    const r = await makeRoutine({ orgId, userId })
    expect(r.tokenBudget).toBeNull()
    expect(r.hardTokenLimit).toBeNull()
    let prompt = ""
    let frame: RunContext | undefined
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        prompt = input.prompt
        frame = currentRunContext()
        return { turnsAdded: 1 }
      },
    })
    expect(prompt).toBe("say hi")
    expect(frame && "tokenAccount" in frame).toBe(false)
  })

  // ── SHARED-visibility output thread: the team must SEE the digest (regression) ──────────────────
  // Thread visibility is purely participant-based (threads_select RLS). A shared routine's auto-created
  // output thread must enroll EVERY active org member, else the digest (e.g. a team ops digest) lands in
  // an owner-private thread the team never sees — the exact weak-model failure the weekly-ops-digest
  // chaos gate caught. FAILS WITHOUT the ensureOutputThread shared-enrollment fix (only the owner would
  // be a participant), PASSES WITH it (all active members enrolled).
  it("SHARED routine: ensureOutputThread enrolls ALL active org members (team-visible digest)", async () => {
    // A second active org member who must end up enrolled in the shared output thread.
    const teammateId = await withSystemDb("rw-test-teammate", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `rw-mate-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Routine Teammate",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
    try {
      const r = await makeRoutine({ orgId, userId, visibility: "shared" })
      const result = await runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["*"],
        checkCredits: async () => null,
        agentInvoker: async () => ({ turnsAdded: 1 }),
      })
      expect(result.status).toBe("succeeded")
      // The routine now points at an output thread.
      const [routineRow] = await withPrivilegedDb(orgId, "rw-shared-routine", (tx) =>
        tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
      )
      expect(routineRow.outputThreadId).toBeTruthy()
      // Both the owner AND the teammate are participants of that thread → both can see the digest.
      const parts = await withPrivilegedDb(orgId, "rw-shared-parts", (tx) =>
        tx
          .select({ userId: threadParticipants.userId })
          .from(threadParticipants)
          .where(eq(threadParticipants.threadId, routineRow.outputThreadId!)),
      )
      const partIds = new Set(parts.map((p) => p.userId))
      expect(partIds.has(userId)).toBe(true)
      expect(partIds.has(teammateId)).toBe(true)
    } finally {
      // Delete the output thread FIRST (cascades thread_participants) so the teammate user is no longer
      // referenced, then the user — the FK thread_participants_user_id_users_id_fk is RESTRICT, not cascade.
      await withPrivilegedDb(orgId, "rw-shared-cleanup", async (tx) => {
        await tx.delete(threads).where(eq(threads.createdBy, userId))
        await tx.delete(users).where(eq(users.id, teammateId))
      })
    }
  })

  // The contrast case: a PERSONAL routine's output thread is owner-private — only the owner is enrolled,
  // never the teammate (so a personal routine never broadcasts to the team).
  it("PERSONAL routine: ensureOutputThread enrolls ONLY the owner (owner-private digest)", async () => {
    const teammateId = await withSystemDb("rw-test-teammate2", async (db) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          email: `rw-mate2-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Routine Teammate 2",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
    try {
      const r = await makeRoutine({ orgId, userId, visibility: "personal" })
      const result = await runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["*"],
        checkCredits: async () => null,
        agentInvoker: async () => ({ turnsAdded: 1 }),
      })
      expect(result.status).toBe("succeeded")
      const [routineRow] = await withPrivilegedDb(orgId, "rw-personal-routine", (tx) =>
        tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
      )
      const parts = await withPrivilegedDb(orgId, "rw-personal-parts", (tx) =>
        tx
          .select({ userId: threadParticipants.userId })
          .from(threadParticipants)
          .where(eq(threadParticipants.threadId, routineRow.outputThreadId!)),
      )
      const partIds = new Set(parts.map((p) => p.userId))
      expect(partIds.has(userId)).toBe(true)
      expect(partIds.has(teammateId)).toBe(false)
    } finally {
      await withPrivilegedDb(orgId, "rw-personal-cleanup", async (tx) => {
        await tx.delete(threads).where(eq(threads.createdBy, userId))
        await tx.delete(users).where(eq(users.id, teammateId))
      })
    }
  })

  it("agent throws: routine_runs.status='failed'; routine.lastRunError set; NOT auto-paused", async () => {
    const r = await makeRoutine({ orgId, userId })
    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      agentInvoker: async () => {
        throw new Error("boom")
      },
    })
    expect(result.status).toBe("failed")
    const after = await withPrivilegedDb(orgId, "rw-check-failed", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, r.id)),
    )
    // Status stays 'active' — retry/backoff at BullMQ layer handles transient.
    expect(after[0].status).toBe("active")
    expect(after[0].lastRunStatus).toBe("failed")
    expect(after[0].lastRunError).toBe("boom")
  })

  it("redis lock held: second concurrent invocation writes skipped_overlap and exits", async () => {
    const r = await makeRoutine({ orgId, userId })
    // Pre-acquire the lock to simulate an in-flight tick.
    await redis.set(`routine-lock:${r.id}`, "other-token", "EX", 60)
    try {
      const result = await runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["*"],
        agentInvoker: async () => ({ turnsAdded: 0 }),
      })
      expect(result.status).toBe("skipped_overlap")
      const runs = await withPrivilegedDb(orgId, "rw-overlap-check", (tx) =>
        tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
      )
      expect(runs.length).toBe(1)
      expect(runs[0].status).toBe("skipped_overlap")
    } finally {
      await redis.del(`routine-lock:${r.id}`)
    }
  })

  it("redis lock held + deferOnOverlap: returns lock_busy WITHOUT writing a run row", async () => {
    const r = await makeRoutine({ orgId, userId })
    await redis.set(`routine-lock:${r.id}`, "other-token", "EX", 60)
    try {
      const result = await runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        deferOnOverlap: true,
        triggerEvent: {
          app: "tickets",
          entity: "ticket",
          action: "create",
          entityId: "t-1",
          data: null,
        },
        loadOwnerScopes: async () => ["*"],
        agentInvoker: async () => ({ turnsAdded: 0 }),
      })
      expect(result.status).toBe("lock_busy")
      expect(result.runId).toBeUndefined()
      const runs = await withPrivilegedDb(orgId, "rw-defer-check", (tx) =>
        tx.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
      )
      expect(runs.length).toBe(0)
    } finally {
      await redis.del(`routine-lock:${r.id}`)
    }
  })

  it("concurrent run × 3: exactly one succeeds, two write skipped_overlap", async () => {
    const r = await makeRoutine({ orgId, userId })

    // The first invoker holds the lock long enough for the others to race.
    const slowInvoker = async () => {
      await new Promise((res) => setTimeout(res, 100))
      return { turnsAdded: 1 }
    }
    const fastInvoker = async () => ({ turnsAdded: 0 })

    const [a, b, c] = await Promise.all([
      runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["*"],
        agentInvoker: slowInvoker,
      }),
      runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["*"],
        agentInvoker: fastInvoker,
      }),
      runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["*"],
        agentInvoker: fastInvoker,
      }),
    ])
    const statuses = [a.status, b.status, c.status].sort()
    expect(statuses.filter((s) => s === "succeeded").length).toBe(1)
    expect(statuses.filter((s) => s === "skipped_overlap").length).toBe(2)
  })

  it("marks a scheduled (one-shot) routine completed after a successful run", async () => {
    const routine = await makeRoutine({
      orgId,
      userId,
      kind: "scheduled",
      runAt: new Date(Date.now() + 1000),
      cron: null,
      timezone: null,
    })
    const result = await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })
    expect(result.status).toBe("succeeded")
    const [row] = await withSystemDb("rw-oneshot-done", (db) =>
      db
        .select({ status: routinesTbl.status })
        .from(routinesTbl)
        .where(eq(routinesTbl.id, routine.id)),
    )
    expect(row.status).toBe("completed")
  })

  it("leaves a recurring routine active after a successful run", async () => {
    const routine = await makeRoutine({
      orgId,
      userId,
      kind: "recurring",
      cron: "0 8 * * *",
      timezone: "UTC",
      runAt: null,
    })
    await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })
    const [row] = await withSystemDb("rw-recurring-active", (db) =>
      db
        .select({ status: routinesTbl.status })
        .from(routinesTbl)
        .where(eq(routinesTbl.id, routine.id)),
    )
    expect(row.status).toBe("active")
  })

  it("does not complete a scheduled routine when the run fails", async () => {
    const routine = await makeRoutine({
      orgId,
      userId,
      kind: "scheduled",
      runAt: new Date(),
      cron: null,
      timezone: null,
    })
    await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => {
        throw new Error("boom")
      },
    })
    const [row] = await withSystemDb("rw-oneshot-fail", (db) =>
      db
        .select({ status: routinesTbl.status })
        .from(routinesTbl)
        .where(eq(routinesTbl.id, routine.id)),
    )
    expect(row.status).toBe("active")
  })
})

describe("routine-worker — the tick posts only where the routine is configured to post", () => {
  // P4b-T19 (S12's companion positive case, D7's only proactive posting path):
  // a tick posts to its outputThreadId and to no other room its agent sits in.
  let orgId: string
  let userId: string
  let agentId: string
  let outputThreadId: string
  let otherThreadId: string

  beforeAll(async () => {
    const s = await setup()
    orgId = s.orgId
    userId = s.userId
    const [agent] = await withPrivilegedDb(orgId, "rw-dest-agent", (tx) =>
      tx
        .insert(agentsTbl)
        .values({
          orgId,
          kind: "role",
          handle: `@dest-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Destination",
          // A ceiling that grants something: an agent with an empty one can
          // call no tool at all, and the tick now skips rather than run it.
          scopeCeiling: ["kernel:threads:read"],
        })
        .returning({ id: agentsTbl.id }),
    )
    agentId = agent.id

    const seed = async (handle: string) => {
      const [t] = await withPrivilegedDb(orgId, "rw-dest-thread", (tx) =>
        tx
          .insert(threads)
          .values({ orgId, handle, title: handle, createdBy: userId, discoverable: true })
          .returning({ id: threads.id }),
      )
      await withPrivilegedDb(orgId, "rw-dest-seats", async (tx) => {
        await tx.insert(threadParticipants).values({ threadId: t.id, orgId, userId })
        await tx
          .insert(threadParticipants)
          .values({ threadId: t.id, orgId, agentId, participantType: "agent" })
      })
      return t.id
    }
    outputThreadId = await seed(`rw-out-${crypto.randomUUID().slice(0, 8)}`)
    otherThreadId = await seed(`rw-other-${crypto.randomUUID().slice(0, 8)}`)
  })

  beforeEach(async () => {
    await clearRedisPatterns(["routine-lock:*"])
  })

  it("a configured routine tick posts only to its outputThreadId, not to any other thread", async () => {
    const [routine] = await withPrivilegedDb(orgId, "rw-dest-routine", (tx) =>
      tx
        .insert(routinesTbl)
        .values({
          orgId,
          ownerUserId: userId,
          ownerAgentId: agentId,
          name: `rw-dest-${crypto.randomUUID().slice(0, 8)}`,
          description: "Destination routine",
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "post the digest",
          scopes: [],
          enabled: true,
          status: "active",
          visibility: "personal",
          outputThreadId,
          createdByUserId: userId,
          createdByActorType: "user",
        })
        .returning(),
    )

    // The invoker stands in for the whole agent turn: it posts wherever the
    // worker tells it to post, so the assertion is about the destination the
    // worker chose, not about the model.
    const postedTo: string[] = []
    const result = await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (opts: { threadId: string }) => {
        postedTo.push(opts.threadId)
        await withPrivilegedDb(orgId, "rw-dest-post", (tx) =>
          tx.insert(kernelMessages).values({
            threadId: opts.threadId,
            orgId,
            authorId: userId,
            authorType: "agent",
            authorAgentId: agentId,
            content: "the digest",
            requiredScopes: [],
          }),
        )
        return { turnsAdded: 1 }
      },
    })
    expect(result.status).toBe("succeeded")
    expect(postedTo).toEqual([outputThreadId])

    const counts = await withPrivilegedDb(orgId, "rw-dest-count", (tx) =>
      tx
        .select({ threadId: kernelMessages.threadId, id: kernelMessages.id })
        .from(kernelMessages)
        .where(eq(kernelMessages.orgId, orgId)),
    )
    expect(counts.filter((m) => m.threadId === outputThreadId).length).toBe(1)
    expect(counts.filter((m) => m.threadId === otherThreadId).length).toBe(0)
  })
})
