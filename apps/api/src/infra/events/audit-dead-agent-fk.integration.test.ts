// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX26 item 1 -- an audit row must SURVIVE an agent that was deleted after the
// event naming it was queued.
//
// FX24 B saved the human's approval CARD from an unknown proposer, and FX25
// closed the cross-org half. The deleted-agent half was still open one step
// later in the pipeline, and there the failure was worse than a lost name:
//
//   stage a gated call inside agent A's turn, then delete agent A, then drain.
//   The approval row survives (0070/0071 SET NULL the agent), but the events
//   already queued still NAME the dead agent. `audit_log_agent_org_fk` refuses
//   the insert (23503); `auditDurableHandler` passes `{required: true}` so it
//   throws; the outbox retries and DEAD-LETTERS at MAX_ATTEMPTS=10. Measured
//   before the fix: audit rows 0, attempts 10, failed_at set, two events lost.
//
// Losing the audit row entirely is exactly what spec-security.md A11 exists to
// prevent. A dead agent must cost the agent's NAME, never the record.
//
// Two properties make the fix sound, and both are pinned here rather than
// assumed:
//   - the retry begins a NEW transaction. A failed statement ABORTS a postgres
//     transaction: every later statement returns 25P02 until rollback, so a
//     retry that reused the aborted tx could never commit. Pinned positively
//     (the row lands, which an aborted tx cannot do) and negatively (the
//     same-tx retry really does return 25P02).
//   - the catch matches the SPECIFIC constraint name, never the bare 23503
//     class. `audit_log_org_fk` raises 23503 on this same table, so a broad
//     catch would swallow a bad ORG as if it were a bad agent. Pinned with a
//     real postgres error captured from a ghost-org insert.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type ActorContext, type UserContext, withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { runDurableConsumers } from "~/infra/events/durable-consumers"
import { type AppEvent, initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { auditLogger, eventsLogger } from "~/lib/logger"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import * as auditModule from "~/modules/audit/service"
import { isUnknownAgentFkError, writeAuditLog } from "~/modules/audit/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000f26001"
const USER = "00000000-0000-4000-8000-000000f26002"
const THREAD = "00000000-0000-4000-8000-000000f26003"
const AGENT = "00000000-0000-4000-8000-000000f26004"
/** A well-formed org uuid naming no organization: the OTHER 23503 on this table. */
const GHOST_ORG = "00000000-0000-4000-8000-000000f260ff"
/**
 * FX27 -- a REAL other org. Re-homing the agent into it (delete, then re-insert
 * with the SAME id) makes the agent EXIST, just not here, which raises the very
 * same constraint name as a deletion and is a completely different problem.
 */
const ORG_B = "00000000-0000-4000-8000-000000f27001"

const APP = "fx26_test"
const WRITE = `${APP}:write`

const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [WRITE],
  dimensionGrants: {},
}

const auditCtx = (orgId: string): ActorContext =>
  ({ actorType: "system", orgId, purpose: "audit" }) as unknown as ActorContext

function turnFrame(agentId: string): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  const runId = "00000000-0000-4000-8000-000000f260aa"
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: [WRITE],
    turnScopeAccumulator,
    agentId,
  }
}

/** Stage the gated call inside the turn frame. */
async function stageGatedCall(): Promise<string | null> {
  const r = await runContextStore.run(turnFrame(AGENT), () =>
    executeTool({
      toolName: `${APP}:ship`,
      orgId: ORG,
      actor,
      params: { note: "gate me" },
      threadId: THREAD,
      origin: "in-app-agent",
    }),
  )
  return r.blocked?.approvalRequestId ?? null
}

/** Drain the transactional outbox well past MAX_ATTEMPTS (10) so a failing
 *  event reaches its dead letter rather than merely being mid-retry. */
async function drainOutbox(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface Measured {
  auditRows: number
  auditActions: string[]
  auditAgentIds: (string | null)[]
  events: number
  processed: number
  failed: number
  maxAttempts: number
}

/** Everything pass 12 measured, in one place, so the red and the green are
 *  read off the same numbers. */
async function measure(): Promise<Measured> {
  const audit = await sql<{ action: string; agent_id: string | null }[]>`
    SELECT action, agent_id FROM kernel.audit_log WHERE org_id = ${ORG} ORDER BY action`
  const events = await sql<
    { processed_at: Date | null; failed_at: Date | null; attempts: number }[]
  >`
    SELECT processed_at, failed_at, attempts FROM kernel.pending_events WHERE org_id = ${ORG}`
  return {
    auditRows: audit.length,
    auditActions: audit.map((r) => r.action),
    auditAgentIds: audit.map((r) => r.agent_id),
    events: events.length,
    processed: events.filter((e) => e.processed_at !== null).length,
    failed: events.filter((e) => e.failed_at !== null).length,
    maxAttempts: events.reduce((m, e) => Math.max(m, Number(e.attempts ?? 0)), 0),
  }
}

/** The postgres SQLSTATE, wherever the driver or Drizzle put it. */
function pgCode(err: unknown): string | undefined {
  const direct = (err as { code?: unknown })?.code
  if (typeof direct === "string") return direct
  const cause = (err as { cause?: { code?: unknown } })?.cause?.code
  return typeof cause === "string" ? cause : undefined
}

function messageOf(err: unknown): string {
  return `${String((err as { message?: unknown })?.message ?? "")}|${String(
    (err as { cause?: { message?: unknown } })?.cause?.message ?? "",
  )}`
}

/** Run `fn` and return whatever it threw, or undefined if it did not throw. */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return undefined
  } catch (err) {
    return err
  }
}

interface LogLine {
  obj: Record<string, unknown>
  msg: string
}

/**
 * FX27 -- what the loggers actually emit, kept BY LEVEL and BY LOGGER.
 *
 * The distinction under test is a level distinction (a deleted agent is a
 * warning, a cross-org one is an error), so asserting on text alone would not
 * pin it. `eventsLogger` and `auditLogger` are separate pino children, so a spy
 * on one never sees the other: that is what separates "the recovery reported
 * the cause" from "the write paged while being recovered".
 */
function captureLogs() {
  const events = { warns: [] as LogLine[], errors: [] as LogLine[] }
  const audit = { warns: [] as LogLine[], errors: [] as LogLine[] }
  const sink = (into: LogLine[]) => (obj: unknown, msg?: unknown) => {
    into.push({
      obj: (typeof obj === "object" && obj !== null ? obj : {}) as Record<string, unknown>,
      msg: typeof obj === "string" ? obj : String(msg ?? ""),
    })
  }
  const spies = [
    spyOn(eventsLogger, "warn").mockImplementation(sink(events.warns) as never),
    spyOn(eventsLogger, "error").mockImplementation(sink(events.errors) as never),
    spyOn(auditLogger, "warn").mockImplementation(sink(audit.warns) as never),
    spyOn(auditLogger, "error").mockImplementation(sink(audit.errors) as never),
  ]
  return {
    events,
    audit,
    restore: () => {
      for (const s of spies) s.mockRestore()
    },
  }
}

const withMsg = (lines: LogLine[], re: RegExp): LogLine[] => lines.filter((l) => re.test(l.msg))

describe("FX26: an agent deleted after its event was queued costs the name, not the audit row", () => {
  beforeAll(async () => {
    await acquireTestLock()

    resetEventBus()
    initEventBus()
    // The real audit and timeline durable consumers; WS fan-out stubbed (there
    // is no socket manager here).
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as never)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'FX26 Dead Agent Org', 'fx26-dead-agent-org') ON CONFLICT DO NOTHING`
    // FX27 -- the org the agent gets re-homed into.
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_B}, 'FX27 Other Org', 'fx27-other-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'fx26@test.com', 'Requester', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'fx26-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`

    toolRegistry.set([ORG, APP, "ship"], {
      appName: APP,
      name: "ship",
      description: "A gated shipment",
      requiredScopes: [WRITE],
      gated: true,
      approvalImpact: "internal",
      writesToTable: SINK_KERNEL_MESSAGES,
      handler: async () => ({ ok: true }),
    } as never)
  })

  /** Re-seed the agent before every test: several of them delete it. */
  beforeEach(async () => {
    await withPrivilegedDb(ORG, "fx26-seed-agent", (tx) =>
      tx
        .insert(agents)
        .values({
          id: AGENT,
          orgId: ORG,
          kind: "personal",
          handle: "@fx26",
          displayName: "Logistics",
          ownerUserId: USER,
          scopeCeiling: [WRITE],
        })
        .onConflictDoNothing(),
    )
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    // FX27 -- by id, not by org: the re-homing test leaves this id in ORG_B,
    // and `beforeEach` re-seeds it with `onConflictDoNothing`, which would
    // silently do NOTHING against the surviving primary key and leave the next
    // test running against an agent that lives in the wrong org.
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_B}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_B}`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_B}`
    resetEventBus()
    await releaseTestLock()
  })

  it("the whole pipeline: staged, agent deleted, drained -> both audit rows land with a null agent", async () => {
    // 1. The agent is alive and stages a gated call, exactly as a turn does.
    const approvalId = await stageGatedCall()
    expect(approvalId).not.toBeNull()

    const [staged] = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.approval_requests WHERE id = ${approvalId!}`
    expect(staged?.agent_id).toBe(AGENT)

    // The events are queued NAMING the live agent. This is the value that
    // outlives the agent row.
    const queued = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.pending_events
      WHERE org_id = ${ORG} AND payload ->> 'agentId' = ${AGENT}`
    expect(queued[0]!.n).toBeGreaterThanOrEqual(2)

    // 2. The agent is deleted mid flight, as user erasure does.
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`

    // The approval row itself survives: the composite FK SET NULLs the agent
    // and keeps the row. That half was already fixed; the audit half was not.
    const [afterDelete] = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.approval_requests WHERE id = ${approvalId!}`
    expect(afterDelete?.agent_id).toBeNull()

    // 3. Drain past MAX_ATTEMPTS so a failing event would be dead-lettered.
    await drainOutbox()

    const m = await measure()
    console.log(`FX26 measured: ${JSON.stringify(m)}`)

    // The record is what must survive. Before the fix: 0 rows, 10 attempts,
    // failed_at set on both events.
    expect(m.auditRows).toBeGreaterThanOrEqual(2)
    expect(m.auditActions).toContain("approval_request.create")
    expect(m.auditActions).toContain("message.create")
    // The dead agent costs only its NAME.
    expect(m.auditAgentIds.every((a) => a === null)).toBe(true)
    // Nothing was lost: every event delivered, none dead-lettered, no retries.
    expect(m.failed).toBe(0)
    expect(m.processed).toBe(m.events)
    expect(m.maxAttempts).toBe(0)
  })

  it("the retry runs in a NEW transaction: a same-tx retry returns 25P02 and can never commit", async () => {
    // Why the loop must sit outside `withRlsContext` rather than inside
    // `writeAuditLog`, which is handed an already-open tx. Postgres aborts a
    // transaction on its first failed statement; every later statement in it
    // returns 25P02 (current transaction is aborted) until rollback. So a retry
    // that reused the caller's tx could not commit the row even with a correct
    // null agent. This is the negative half of the proof.
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`

    let sameTxRetryError: unknown
    let firstError: unknown
    await captureError(() =>
      withRlsContext(auditCtx(ORG), async (tx) => {
        firstError = await captureError(() =>
          writeAuditLog(
            tx,
            {
              orgId: ORG,
              actorType: "agent",
              action: "fx26.same-tx-probe",
              entityType: "probe",
              entityId: "same-tx",
              agentId: AGENT,
            },
            { required: true },
          ),
        )
        // The very same row with a CORRECT null agent, on the SAME tx.
        sameTxRetryError = await captureError(() =>
          writeAuditLog(
            tx,
            {
              orgId: ORG,
              actorType: "agent",
              action: "fx26.same-tx-probe",
              entityType: "probe",
              entityId: "same-tx",
              agentId: null,
            },
            { required: true },
          ),
        )
      }),
    )

    // The first insert failed on the agent foreign key.
    expect(pgCode(firstError)).toBe("23503")
    expect(messageOf(firstError)).toContain("audit_log_agent_org_fk")
    // The in-transaction retry could not run at all.
    expect(pgCode(sameTxRetryError)).toBe("25P02")

    // And nothing committed, which is the point: an aborted tx cannot land a row.
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.audit_log
      WHERE org_id = ${ORG} AND action = 'fx26.same-tx-probe'`
    expect(rows[0]!.n).toBe(0)
  })

  it("the catch is constraint-specific: a ghost ORG is also 23503 and is NOT treated as a bad agent", async () => {
    // The other-column probe. `audit_log_org_fk` raises 23503 on this very
    // table, so a catch written as `code === "23503"` would silently null the
    // agent and retry for a violation that has nothing to do with the agent.
    // Both errors below are REAL postgres errors, not hand-built strings.
    const agentFkError = await captureError(async () => {
      await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`
      await withRlsContext(auditCtx(ORG), (tx) =>
        writeAuditLog(
          tx,
          {
            orgId: ORG,
            actorType: "agent",
            action: "fx26.agent-fk-probe",
            agentId: AGENT,
          },
          { required: true },
        ),
      )
    })
    // The agent MUST be null to isolate the org foreign key. The agent FK is
    // COMPOSITE over (agent_id, org_id), so a ghost org carrying any non-null
    // agent violates `audit_log_agent_org_fk` first and never reaches
    // `audit_log_org_fk`. With a null agent the composite key is not checked at
    // all (MATCH SIMPLE), so the org FK is the only one left to fail.
    const orgFkError = await captureError(() =>
      withRlsContext(auditCtx(GHOST_ORG), (tx) =>
        writeAuditLog(
          tx,
          {
            orgId: GHOST_ORG,
            actorType: "agent",
            action: "fx26.org-fk-probe",
            agentId: null,
          },
          { required: true },
        ),
      ),
    )

    // Both are the same SQLSTATE class.
    expect(pgCode(agentFkError)).toBe("23503")
    expect(pgCode(orgFkError)).toBe("23503")
    // They are told apart by constraint NAME, and only the agent one is matched.
    expect(messageOf(orgFkError)).toContain("audit_log_org_fk")
    expect(isUnknownAgentFkError(agentFkError)).toBe(true)
    expect(isUnknownAgentFkError(orgFkError)).toBe(false)
  })

  it("a ghost ORG still fails loudly through the durable consumer and writes nothing", async () => {
    // The end-to-end half of the same property, mirroring FX24 B's ghost
    // `requested_by`: a violation on another column must still throw rather
    // than be absorbed by the agent fallback.
    const err = await captureError(() =>
      withRlsContext(auditCtx(GHOST_ORG), (tx) =>
        writeAuditLog(
          tx,
          {
            orgId: GHOST_ORG,
            actorType: "agent",
            action: "fx26.ghost-org",
            agentId: null,
          },
          { required: true },
        ),
      ),
    )
    expect(err).toBeDefined()
    expect(pgCode(err)).toBe("23503")

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.audit_log WHERE org_id = ${GHOST_ORG}`
    expect(rows[0]!.n).toBe(0)
  })

  // FX27 -- 0070's key is COMPOSITE over (agent_id, org_id), so one constraint
  // name covers two causes that mean opposite things. FX26 recovered both by
  // nulling the agent, which is right for the row and wrong for the alarm: a
  // cross-org agent id reaching an audit event means something upstream is
  // already broken, and silence there buys nothing.

  it("an agent RE-HOMED to another org keeps its row AND is reported at error level naming both orgs", async () => {
    // Pass 13 measured this exact scenario against FX26 and got
    // auditRows=2, agentIds=[null,null], failed=0, maxAttempts=0 with nothing
    // in the log to say the id belonged to another org. The row surviving is
    // correct and must not regress; the silence is the defect.
    const approvalId = await stageGatedCall()
    expect(approvalId).not.toBeNull()

    // Re-home: same id, other org. The agent EXISTS, it is just not ours. This
    // raises the SAME constraint name a deletion raises.
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${AGENT}, ${ORG_B}, 'role', '@fx27-rehomed', 'Re-homed')`
    const [lives] = await sql<{ org_id: string }[]>`
      SELECT org_id FROM kernel.agents WHERE id = ${AGENT}`
    expect(lives?.org_id).toBe(ORG_B)

    const logs = captureLogs()
    try {
      await drainOutbox()
    } finally {
      logs.restore()
    }

    // 1. The row is still never lost. FX26's guarantee, unchanged.
    const m = await measure()
    console.log(`FX27 cross-org measured: ${JSON.stringify(m)}`)
    expect(m.auditRows).toBeGreaterThanOrEqual(2)
    expect(m.auditActions).toContain("approval_request.create")
    expect(m.auditActions).toContain("message.create")
    expect(m.auditAgentIds.every((a) => a === null)).toBe(true)
    expect(m.failed).toBe(0)
    expect(m.processed).toBe(m.events)
    expect(m.maxAttempts).toBe(0)

    // 2. The recovered row loses the agent NAME and nothing else.
    const [row] = await sql<Record<string, unknown>[]>`
      SELECT org_id, actor_id, actor_type, app, entity_type, entity_id, action,
             changes, event_id, agent_id
      FROM kernel.audit_log WHERE org_id = ${ORG} AND action = 'approval_request.create'`
    console.log(`FX27 recovered row: ${JSON.stringify(row)}`)
    expect(row).toBeDefined()
    expect(row!.agent_id).toBeNull()
    expect(row!.org_id).toBe(ORG)
    expect(row!.action).toBe("approval_request.create")
    for (const col of [
      "actor_id",
      "actor_type",
      "app",
      "entity_type",
      "entity_id",
      "changes",
      "event_id",
    ]) {
      expect(row![col]).not.toBeNull()
    }

    // 3. And it is LOUD, at error level, naming BOTH orgs: the row's own org
    // and the one the agent actually lives in.
    const crossOrg = withMsg(logs.events.errors, /different org/i)
    expect(crossOrg.length).toBeGreaterThan(0)
    expect(crossOrg[0]!.obj.agentId).toBe(AGENT)
    expect(crossOrg[0]!.obj.rowOrgId).toBe(ORG)
    expect(crossOrg[0]!.obj.agentOrgId).toBe(ORG_B)

    // 4. It must NOT be reported as a deleted agent. That message is false
    // here and sends whoever reads it at 3am the wrong way.
    expect(withMsg(logs.events.warns, /no longer exists/i)).toHaveLength(0)
  })

  it("a DELETED agent is a warning, not an error, and the recovered row does not page", async () => {
    const approvalId = await stageGatedCall()
    expect(approvalId).not.toBeNull()
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`

    const logs = captureLogs()
    try {
      await drainOutbox()
    } finally {
      logs.restore()
    }

    const m = await measure()
    console.log(`FX27 deleted measured: ${JSON.stringify(m)}`)
    expect(m.auditRows).toBeGreaterThanOrEqual(2)
    expect(m.auditAgentIds.every((a) => a === null)).toBe(true)
    expect(m.failed).toBe(0)
    expect(m.maxAttempts).toBe(0)

    // The deleted cause is a WARNING, and the message is true.
    const deleted = withMsg(logs.events.warns, /no longer exists/i)
    expect(deleted.length).toBeGreaterThan(0)
    expect(deleted[0]!.obj.agentId).toBe(AGENT)
    expect(deleted[0]!.obj.orgId).toBe(ORG)

    // It is NOT the cross-org anomaly: the two causes are distinguishable.
    expect(withMsg(logs.events.errors, /different org/i)).toHaveLength(0)

    // And a RECOVERED row must not page. Before FX27 every recovered row
    // logged "Required audit log entry failed" at error, so the fix that saved
    // the row also woke somebody up for a row that was never in danger.
    expect(withMsg(logs.audit.errors, /Required audit log entry failed/i)).toHaveLength(0)
    // Nothing on this path rolls a caller transaction back, so nothing says so.
    expect(withMsg(logs.audit.errors, /rolling/i)).toHaveLength(0)
  })

  it("the retry is bounded at exactly one, and a second, DIFFERENT error propagates", async () => {
    // The bound is what stops a permanently failing row from spinning; the
    // propagation is what stops a real fault from being absorbed by the agent
    // fallback. Both rested on the SHAPE of the loop and were pinned by
    // nothing, so a later edit could have removed either silently.
    //
    // The first error is a REAL captured `audit_log_agent_org_fk` violation
    // rather than a hand-built string, so the matcher under test sees exactly
    // what postgres produces. The second is something else entirely.
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`
    const realAgentFkError = await captureError(() =>
      withRlsContext(auditCtx(ORG), (tx) =>
        writeAuditLog(
          tx,
          { orgId: ORG, actorType: "agent", action: "fx27.bound-probe", agentId: AGENT },
          { required: true },
        ),
      ),
    )
    expect(isUnknownAgentFkError(realAgentFkError)).toBe(true)

    const secondError = new Error("a different failure entirely")
    const seen: (string | null | undefined)[] = []
    const spy = spyOn(auditModule, "writeAuditLog").mockImplementation((async (
      _db: unknown,
      entry: { agentId?: string | null },
    ) => {
      seen.push(entry.agentId)
      throw seen.length === 1 ? realAgentFkError : secondError
    }) as never)

    let propagated: unknown
    try {
      // No entityId, so the timeline consumer returns early and the audit
      // consumer is the only one that can throw.
      const event: AppEvent = {
        app: "kernel",
        entity: "message",
        action: "create",
        orgId: ORG,
        actorId: USER,
        actorType: "agent",
        agentId: AGENT,
      }
      propagated = await captureError(() =>
        runDurableConsumers({ eventId: crypto.randomUUID(), event }),
      )
    } finally {
      spy.mockRestore()
    }

    // Exactly one retry: two calls, never a third.
    expect(seen).toHaveLength(2)
    // The first carried the agent; the retry dropped it.
    expect(seen[0]).toBe(AGENT)
    expect(seen[1]).toBeNull()
    // And the second, different error was NOT swallowed by the agent fallback.
    expect(propagated).toBe(secondError)
  })

  // FX30 -- pass 15 mutation-tested the cases above and found two of them
  // pinned nothing. The retry "bound" was really `agentId !== null` (the id was
  // dropped on the first recovery, so the loop could not go round again
  // whatever the attempt counter said), and the constraint-specific catch was
  // never once exercised THROUGH the durable consumer: deleting
  // `isUnknownAgentFkError` from the guard left the whole file green.
  //
  // The four cases below are each red under a NAMED mutation, recorded next to
  // the assertion that catches it.

  const GHOST_AGENT = "00000000-0000-4000-8000-000000f30001"

  /**
   * A REAL `audit_log_agent_org_fk` violation, straight from postgres, raised by
   * an id that names no agent while AGENT itself stays alive. The matcher under
   * test then sees exactly what the driver produces, and the cause probe finds
   * the live agent, which is the `present` branch these cases need.
   */
  async function captureRealAgentFkError(): Promise<unknown> {
    const err = await captureError(() =>
      withRlsContext(auditCtx(ORG), (tx) =>
        writeAuditLog(
          tx,
          { orgId: ORG, actorType: "agent", action: "fx30.capture", agentId: GHOST_AGENT },
          { required: true },
        ),
      ),
    )
    expect(isUnknownAgentFkError(err)).toBe(true)
    return err
  }

  type WriteArgs = [db: unknown, entry: { agentId?: string | null }, opts?: unknown]

  /**
   * Record the agent id every attempt carried, and decide per attempt whether it
   * fails or runs for REAL. Pass-through is what makes the recovered row a row
   * in the database rather than a call count.
   */
  function spyOnAuditWrite(
    seen: (string | null | undefined)[],
    failOn: (attempt: number) => unknown,
  ) {
    const real = auditModule.writeAuditLog as unknown as (...args: WriteArgs) => Promise<void>
    return spyOn(auditModule, "writeAuditLog").mockImplementation((async (...args: WriteArgs) => {
      seen.push(args[1].agentId)
      const err = failOn(seen.length)
      if (err) throw err
      return real(...args)
    }) as never)
  }

  /** One agent-attributed event for the REAL durable consumers. No entityId, so
   *  the timeline consumer returns early and audit is the only one that throws. */
  function agentEvent(orgId: string, action: string): AppEvent {
    return {
      app: "kernel",
      entity: "message",
      action,
      orgId,
      actorId: USER,
      actorType: "agent",
      agentId: AGENT,
      data: { note: "fx30" },
    }
  }

  /** Every message `reportAgentFkCause` can emit, at either level. */
  const causeReports = (logs: ReturnType<typeof captureLogs>): LogLine[] => [
    ...withMsg(logs.events.warns, /^Audit row .*agent/i),
    ...withMsg(logs.events.errors, /^Audit row .*agent/i),
  ]

  it("a PRESENT agent is retried WITH its id and the row keeps the attribution", async () => {
    // Pass 15 measured this branch landing `agent_id = null` while
    // `SELECT org_id FROM kernel.agents WHERE id = AGENT` returned ORG itself:
    // the probe had just PROVEN the id was good and the recovery threw it away.
    // A11 costs a DEAD agent its name, and this agent is not dead.
    const realAgentFkError = await captureRealAgentFkError()
    const seen: (string | null | undefined)[] = []
    // The concurrent write: the first insert is refused, the identical retry is
    // not. Everything after attempt 1 is the real writeAuditLog.
    const spy = spyOnAuditWrite(seen, (n) => (n === 1 ? realAgentFkError : null))

    const logs = captureLogs()
    try {
      await runDurableConsumers({
        eventId: crypto.randomUUID(),
        event: agentEvent(ORG, "fx30-present"),
      })
    } finally {
      logs.restore()
      spy.mockRestore()
    }

    // MUTATION `agentId = null` unconditional (the pre-FX30 line): seen becomes
    // [AGENT, null] and agent_id comes back null.
    expect(seen).toEqual([AGENT, AGENT])
    const [row] = await sql<{ agent_id: string | null; org_id: string }[]>`
      SELECT agent_id, org_id FROM kernel.audit_log
      WHERE org_id = ${ORG} AND action = 'message.fx30-present'`
    console.log(`FX30 present-branch row: ${JSON.stringify(row)}`)
    expect(row).toBeDefined()
    expect(row!.agent_id).toBe(AGENT)

    // And the report says which of the two things happened, since they differ
    // by whether the attribution survived.
    const present = withMsg(logs.events.warns, /retrying with the agent id/i)
    expect(present).toHaveLength(1)
    expect(present[0]!.obj.agentId).toBe(AGENT)
    expect(present[0]!.obj.retryingWithAgentId).toBe(true)
    // It is neither of the other two causes: the agent is right here.
    expect(withMsg(logs.events.warns, /no longer exists/i)).toHaveLength(0)
    expect(withMsg(logs.events.errors, /different org/i)).toHaveLength(0)
  })

  it("when the retry keeping the present id fails too, the id goes and the row still lands", async () => {
    // The other half of the same decision. Keeping a valid name is worth one
    // attempt; keeping it twice would start trading the ROW for the name, which
    // is the trade FX26 exists to refuse.
    const realAgentFkError = await captureRealAgentFkError()
    const seen: (string | null | undefined)[] = []
    const spy = spyOnAuditWrite(seen, (n) => (n <= 2 ? realAgentFkError : null))

    const logs = captureLogs()
    try {
      await runDurableConsumers({
        eventId: crypto.randomUUID(),
        event: agentEvent(ORG, "fx30-fallback"),
      })
    } finally {
      logs.restore()
      spy.mockRestore()
    }

    // MUTATION `attempt === 0 && cause.kind === "present"` -> `attempt < 5 &&
    // ...`: the third write carries AGENT too, is refused again, and no row
    // lands at all.
    expect(seen).toEqual([AGENT, AGENT, null])
    const [row] = await sql<Record<string, unknown>[]>`
      SELECT org_id, actor_id, actor_type, app, entity_type, action, changes, event_id, agent_id
      FROM kernel.audit_log WHERE org_id = ${ORG} AND action = 'message.fx30-fallback'`
    console.log(`FX30 fall-back-again row: ${JSON.stringify(row)}`)
    expect(row).toBeDefined()
    expect(row!.agent_id).toBeNull()
    expect(row!.org_id).toBe(ORG)
    expect(row!.actor_id).toBe(USER)
    expect(row!.actor_type).toBe("agent")
    for (const col of ["app", "entity_type", "changes", "event_id"]) {
      expect(row![col]).not.toBeNull()
    }

    // Both reports fired, and the second one no longer claims a retry it did
    // not make.
    const present = withMsg(logs.events.warns, /present in this org/i)
    expect(present).toHaveLength(2)
    expect(present[0]!.obj.retryingWithAgentId).toBe(true)
    expect(present[1]!.obj.retryingWithAgentId).toBe(false)
  })

  it("the recovery is bounded by the ATTEMPT counter: three writes at most, then the error escapes", async () => {
    // What b0f5fd35 meant to pin and did not. Now that the `present` branch
    // KEEPS the id, "stop once the id is null" no longer terminates the loop,
    // so the counter is the only bound there is and a permanently refused id
    // is the case that walks into it.
    const realAgentFkError = await captureRealAgentFkError()
    const seen: (string | null | undefined)[] = []
    const spy = spyOnAuditWrite(seen, () => realAgentFkError)

    let propagated: unknown
    try {
      propagated = await captureError(() =>
        runDurableConsumers({
          eventId: crypto.randomUUID(),
          event: agentEvent(ORG, "fx30-bound"),
        }),
      )
    } finally {
      spy.mockRestore()
    }

    // MUTATION MAX_AGENT_FK_RECOVERIES 2 -> 5: six writes, not three.
    // MUTATION delete `attempt >= MAX_AGENT_FK_RECOVERIES ||` from the guard:
    // the loop never returns and this case dies on its timeout.
    expect(seen).toEqual([AGENT, AGENT, null])
    // Bounded does not mean swallowed: the row that could not be written
    // still fails the consumer, so the outbox retries and can dead-letter.
    expect(propagated).toBe(realAgentFkError)
    const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.audit_log
        WHERE org_id = ${ORG} AND action = 'message.fx30-bound'`
    expect(rows[0]!.n).toBe(0)
  }, 15_000)

  // FX2 item 8, the inherited repair. This case was written to reach
  // `writeAuditRowInOwnTx`'s constraint check end to end, and it could not: on
  // kernel.audit_log the ORG key `audit_log_org_fk` (0000) is evaluated BEFORE
  // the composite `audit_log_agent_org_fk` (0070), so a ghost-org insert
  // carrying a LIVE agent raises the ORG violation first and the agent fallback
  // is never entered at all. It expected two attempts and saw one. It now pins
  // what actually happens, and the case it MEANT to pin -- a real composite-FK
  // violation through the real consumer -- is the test after it, where a DEAD
  // agent makes the composite key the only one that can be violated.
  it("a ghost ORG through the durable consumer is refused by its OWN constraint, before the agent fallback", async () => {
    const seen: (string | null | undefined)[] = []
    const spy = spyOnAuditWrite(seen, () => null)

    const logs = captureLogs()
    let propagated: unknown
    try {
      propagated = await captureError(() =>
        runDurableConsumers({
          eventId: crypto.randomUUID(),
          event: agentEvent(GHOST_ORG, "fx30-ghost-org"),
        }),
      )
    } finally {
      logs.restore()
      spy.mockRestore()
    }

    // The org failure escapes intact: same SQLSTATE as the agent one, told
    // apart by name.
    expect(propagated).toBeDefined()
    expect(pgCode(propagated)).toBe("23503")
    expect(messageOf(propagated)).toContain("audit_log_org_fk")
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.audit_log WHERE org_id = ${GHOST_ORG}`
    expect(rows[0]!.n).toBe(0)

    // ONE attempt, and no recovery: the error is not an agent FK violation, so
    // the guard rethrows on the spot.
    // MUTATION delete `!isUnknownAgentFkError(err)` from the guard: the org
    // violation is treated as an agent one, the fallback runs on it, and a
    // second attempt plus a cause report appear for a row whose agent was never
    // the problem.
    expect(seen).toEqual([AGENT])
    expect(causeReports(logs)).toHaveLength(0)
  })

  it("a DEAD agent through the durable consumer IS the composite FK, and the row lands with no agent", async () => {
    // The case the ghost-org one could not reach. The org is real and the agent
    // id names nobody, so `audit_log_agent_org_fk` is the only key that can be
    // violated and the recovery inside `writeAuditRowInOwnTx` is what decides
    // the outcome -- through the REAL consumer, on a REAL postgres error, with
    // every write passed through.
    const seen: (string | null | undefined)[] = []
    const spy = spyOnAuditWrite(seen, () => null)

    const logs = captureLogs()
    let propagated: unknown
    try {
      propagated = await captureError(() =>
        runDurableConsumers({
          eventId: crypto.randomUUID(),
          event: { ...agentEvent(ORG, "fx2-dead-agent"), agentId: GHOST_AGENT },
        }),
      )
    } finally {
      logs.restore()
      spy.mockRestore()
    }

    // Nothing escapes: the recovery landed the row.
    expect(propagated).toBeUndefined()
    // MUTATION delete `!isUnknownAgentFkError(err)` and this still passes, which
    // is why the ghost-org case above is the one that pins the guard; delete the
    // recovery itself and the error escapes and the row is lost.
    expect(seen).toEqual([GHOST_AGENT, null])
    expect(causeReports(logs)).toHaveLength(1)

    // A11: a dead agent costs the NAME, never the record.
    const rows = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.audit_log
      WHERE org_id = ${ORG} AND action = 'message.fx2-dead-agent'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agent_id).toBeNull()
  })
})
