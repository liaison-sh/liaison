// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import * as jobsModule from "~/infra/jobs/jobs"
import { runAgentReinvoke } from "~/modules/agent/runtime/reinvoke"

// enqueueAppJob throws "No handler registered" in bun:test because kernel job
// workers are only registered in index.ts. Stub it so enqueues are recorded as
// no-ops — production defers them via BullMQ. The test drains the recorded
// `agent-reinvoke` job AFTER failBundle's transaction commits, exactly as
// BullMQ would (running it inside the tx would deadlock on the messages row).
// Use spyOn (restored in afterAll), NOT mock.module — mock.module leaks
// process-wide and would replace the whole jobs module for every later test
// file in the same `bun test` process.
const enqueuedJobs: Array<{ appName: string; jobName: string; payload: any }> = []
const enqueueAppJobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (
  appName: string,
  jobName: string,
  payload: any,
) => {
  enqueuedJobs.push({ appName, jobName, payload })
  return `${jobName}:stub`
}) as typeof jobsModule.enqueueAppJob)

/** Run every recorded agent-reinvoke job — mirrors the BullMQ worker. */
async function drainReinvokeJobs() {
  for (const job of enqueuedJobs.filter((j) => j.jobName === "agent-reinvoke")) {
    await runAgentReinvoke(job.payload)
  }
}

import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type ActorContext, type UserContext, withRlsContext } from "~/db/rls"
import * as agentService from "~/modules/agent/runtime/agent-service"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { decideApproval } from "~/modules/approvals/decide"
import { recordStarted, recordSucceeded } from "~/modules/approvals/handler-protocol"
import { POLL_SCHEDULE, runApprovalOutputPoll } from "~/modules/approvals/poll-output"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Replace ONLY invokeAgentForThread — mock.module would blank the whole surface.
const reinvokeSpy = spyOn(agentService, "invokeAgentForThread").mockResolvedValue({
  finishReason: "stop",
  turnsAdded: 1,
})

const ORG = "00000000-0000-4000-8000-0000000a7001"
const USER = "00000000-0000-4000-8000-0000000a7002"
const THREAD = "00000000-0000-4000-8000-0000000a7003"
const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["seq_test:write", "seq_test:approve"],
  dimensionGrants: {},
}

async function recordSelf(toolName: string, result: Record<string, unknown>) {
  const [row] = await sql`SELECT id, decided_by FROM kernel.approval_requests
    WHERE org_id = ${ORG} AND tool_name = ${toolName} AND status = 'approving' LIMIT 1`
  const ctx = { orgId: ORG, approvalRequestId: row.id, approvalDeciderId: row.decided_by, toolName }
  await withPrivilegedDb(ORG, "seq-rec", (tx) => recordStarted(tx, ctx, toolName))
  await withPrivilegedDb(ORG, "seq-rec", (tx) => recordSucceeded(tx, ctx, toolName, result))
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Cascade Fail Org', 'cascade-fail-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, 'cascade-fail@test.com', 'Decider', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}, ${ORG}, 'cascade-fail-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
  for (const scope of ["seq_test:write", "seq_test:approve"]) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }

  toolRegistry.set([ORG, "seq_test", "step1"], {
    appName: "seq_test",
    name: "step1",
    description: "s1",
    requiredScopes: ["seq_test:write"],
    gated: true,
    referenceableOutputs: ["value"],
    handler: async () => {
      const r = { value: "label-123" }
      await recordSelf("seq_test:step1", r)
      return r
    },
  } as any)
  toolRegistry.set([ORG, "seq_test", "step2_fail"], {
    appName: "seq_test",
    name: "step2_fail",
    description: "fails",
    requiredScopes: ["seq_test:write"],
    gated: true,
    handler: async () => {
      throw new Error("downstream boom")
    },
  } as any)
  toolRegistry.set([ORG, "seq_test", "step1_async_stuck"], {
    appName: "seq_test",
    name: "step1_async_stuck",
    description: "stuck async",
    requiredScopes: ["seq_test:write"],
    gated: true,
    referenceableOutputs: ["value"],
    handler: async () => {
      const { recordAwaitingOutput } = await import("~/modules/approvals/handler-protocol")
      const [row] = await sql`SELECT id, decided_by FROM kernel.approval_requests
        WHERE org_id = ${ORG} AND tool_name = 'seq_test:step1_async_stuck' AND status = 'approving' LIMIT 1`
      const ctx = {
        orgId: ORG,
        approvalRequestId: row.id,
        approvalDeciderId: row.decided_by,
        toolName: "seq_test:step1_async_stuck",
      }
      await withPrivilegedDb(ORG, "seq-rec", (tx) =>
        recordStarted(tx, ctx, "seq_test:step1_async_stuck"),
      )
      await withPrivilegedDb(ORG, "seq-rec", (tx) =>
        recordAwaitingOutput(tx, ctx, "seq_test:step1_async_stuck", { ticket: "stuck" }),
      )
      return {}
    },
    poll: async () => ({ ready: false }),
  } as any)
  toolRegistry.set([ORG, "seq_test", "step2"], {
    appName: "seq_test",
    name: "step2",
    description: "s2",
    requiredScopes: ["seq_test:write"],
    gated: true,
    handler: async (p: any) => {
      const r = { sent: p.note }
      await recordSelf("seq_test:step2", r)
      return r
    },
  } as any)
})
afterEach(async () => {
  reinvokeSpy.mockClear()
  enqueuedJobs.length = 0
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})
afterAll(async () => {
  enqueueAppJobSpy.mockRestore()
  reinvokeSpy.mockRestore()
  toolRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

async function gated(tool: string, params: Record<string, unknown>) {
  const r = await executeTool({
    toolName: `seq_test:${tool}`,
    orgId: ORG,
    actor,
    params,
    origin: "in-app-agent",
    threadId: THREAD,
  })
  return r.blocked!.approvalRequestId!
}
async function statusOf(id: string) {
  const [r] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return r.status as string
}

describe("bundle failure path", () => {
  it("a downstream step failure cancels the remainder and re-invokes the agent", async () => {
    const a1 = await gated("step1", { kind: "x" })
    const a2 = await gated("step2_fail", { note: `@ref:${a1}:value` })

    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })
    await drainReinvokeJobs()

    expect(await statusOf(a1)).toBe("approved")
    expect(await statusOf(a2)).toBe("cancelled")
    const msgs = await sql`SELECT content FROM kernel.messages
      WHERE thread_id = ${THREAD} AND content ILIKE '%could not complete%'`
    expect(msgs.length).toBeGreaterThan(0)
    expect(reinvokeSpy).toHaveBeenCalled()
    // The agent is told the failed step's REAL error, what ran, what did not,
    // and to propose a corrected sequence as new calls.
    const reinvoke = enqueuedJobs.find((j) => j.jobName === "agent-reinvoke")!
    const context = reinvoke.payload.context as string
    expect(context).toContain("downstream boom")
    expect(context).not.toContain("failed with no side effect")
    expect(context).toContain("Step 2 (seq_test:step2_fail): FAILED when it ran")
    expect(context).toContain(
      'Step 1 (seq_test:step1): RAN and took effect, result: {"value":"label-123"}',
    )
    expect(context).toContain("propose a corrected sequence as NEW tool calls")
    const [stamped] =
      await sql`SELECT metadata->'executionFailure' AS f FROM kernel.approval_requests WHERE id = ${a2}`
    expect(stamped.f).toMatchObject({ failedStepId: a2, reason: "downstream boom" })
    const lastCall = reinvokeSpy.mock.calls.at(-1)!
    const reinvokeActor = lastCall[2] as { userId: string; scopes: string[] }
    expect(reinvokeActor.userId).toBe(USER)
    expect(Array.isArray(reinvokeActor.scopes)).toBe(true)
    expect(reinvokeActor.scopes.length).toBeGreaterThan(0)
  })

  // A routine run's bundle: the run waiting on it is resumed through the
  // decision job (routine-run-resume.ts), never a chat re-invocation acting on
  // the same failure outside the run.
  it("a routine run's bundle failing hands it to its run, with no chat re-invocation", async () => {
    const routineId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const frame = {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      routineId,
      routineRunId: runId,
      effectiveScope: actor.scopes,
      turnScopeAccumulator: createTurnScopeAccumulator(),
    }
    const a1 = await runContextStore.run(frame, () => gated("step1", { kind: "x" }))
    const a2 = await runContextStore.run(frame, () =>
      gated("step2_fail", { note: `@ref:${a1}:value` }),
    )
    const [meta] =
      await sql`SELECT metadata->>'originRoutineRunId' AS r FROM kernel.approval_requests WHERE id = ${a2}`
    expect(meta.r).toBe(runId)
    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })
    expect(await statusOf(a2)).toBe("cancelled")
    expect(enqueuedJobs.filter((j) => j.jobName === "agent-reinvoke")).toHaveLength(0)
    const decision = enqueuedJobs.filter(
      (j) => j.jobName === "approval-result-turn" && j.payload.approvalId === a2,
    )
    expect(decision).toHaveLength(1)
    expect(decision[0]!.payload.routineId).toBe(routineId)
  })

  it("re-running the reinvoke job is idempotent — no duplicate post or agent invoke (I-REL-10)", async () => {
    const a1 = await gated("step1", { kind: "x" })
    await gated("step2_fail", { note: `@ref:${a1}:value` })

    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })

    // First drain runs the reinvoke (posts message + invokes agent once).
    await drainReinvokeJobs()
    const invokesAfterFirst = reinvokeSpy.mock.calls.length
    const [{ count: msgsAfterFirst }] = await sql`SELECT count(*)::int AS count
      FROM kernel.messages
      WHERE thread_id = ${THREAD}
        AND metadata ->> 'type' = 'bundle-reinvoke'`
    expect(invokesAfterFirst).toBeGreaterThan(0)
    expect(msgsAfterFirst).toBe(1)

    // A BullMQ retry / duplicate enqueue re-runs the same job — must no-op.
    await drainReinvokeJobs()
    expect(reinvokeSpy.mock.calls.length).toBe(invokesAfterFirst)
    const [{ count: msgsAfterSecond }] = await sql`SELECT count(*)::int AS count
      FROM kernel.messages
      WHERE thread_id = ${THREAD}
        AND metadata ->> 'type' = 'bundle-reinvoke'`
    expect(msgsAfterSecond).toBe(1)
  })

  it("the failure-context message carries the requester's scopes and RLS hides it from a member lacking them", async () => {
    const LACKER = "00000000-0000-4000-8000-0000000a7004"
    const ROOM = "00000000-0000-4000-8000-0000000a7005"
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${LACKER}, ${ORG}, 'cascade-fail-lacker@test.com', 'Lacker', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${ROOM}, ${ORG}, 'cascade-fail-room', 'thread', ${USER}) ON CONFLICT DO NOTHING`
    for (const member of [USER, LACKER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${ROOM}, ${member}, ${ORG}) ON CONFLICT DO NOTHING`
    }
    try {
      await runAgentReinvoke({
        orgId: ORG,
        threadId: ROOM,
        bundleId: crypto.randomUUID(),
        requesterId: USER,
        context: 'Step 1 (seq_test:step1): SUCCEEDED, result: {"value":"label-123"}',
      })

      const [row] = await sql<{ id: string; required_scopes: string[] }[]>`
        SELECT id, required_scopes FROM kernel.messages
        WHERE thread_id = ${ROOM} AND metadata ->> 'type' = 'bundle-reinvoke'`
      // No record keeps the failed turn's scopes, so it fails closed to the
      // requester's whole scope set, which bounds whatever that turn read.
      expect(row?.required_scopes).toEqual(["seq_test:approve", "seq_test:write"])

      const visibleIds = (userId: string, scopes: string[]) =>
        withRlsContext(
          { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: {} },
          async (tx) =>
            extractRows<{ id: string }>(
              await tx.execute(
                drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${ROOM}`,
              ),
            ).map((r) => r.id),
        )
      expect(await visibleIds(USER, actor.scopes)).toContain(row?.id)
      expect(await visibleIds(LACKER, [])).not.toContain(row?.id)
    } finally {
      await sql`DELETE FROM kernel.messages WHERE thread_id = ${ROOM}`
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${ROOM}`
      await sql`DELETE FROM kernel.threads WHERE id = ${ROOM}`
      await sql`DELETE FROM kernel.users WHERE id = ${LACKER}`
    }
  })

  it("the sequence-failed notice carries the requester's scopes and RLS hides it from a member lacking them", async () => {
    const LACKER = "00000000-0000-4000-8000-0000000a7006"
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${LACKER}, ${ORG}, 'cascade-fail-lacker-2@test.com', 'Lacker', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD}, ${LACKER}, ${ORG}) ON CONFLICT DO NOTHING`
    try {
      const a1 = await gated("step1", { kind: "x" })
      await gated("step2_fail", { note: `@ref:${a1}:value` })
      await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })

      // The notice quotes the failure reason, which can carry tool or poll error text.
      const rows = await sql<{ id: string; required_scopes: string[] }[]>`
        SELECT id, required_scopes FROM kernel.messages
        WHERE thread_id = ${THREAD} AND metadata ->> 'type' = 'sequence-failed'`
      expect(rows.length).toBeGreaterThan(0)
      const visibleIds = (userId: string, scopes: string[]) =>
        withRlsContext(
          { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: {} },
          async (tx) =>
            extractRows<{ id: string }>(
              await tx.execute(
                drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${THREAD}`,
              ),
            ).map((r) => r.id),
        )
      const lackerSees = await visibleIds(LACKER, [])
      const requesterSees = await visibleIds(USER, actor.scopes)
      for (const row of rows) {
        expect(row.required_scopes).toEqual(["seq_test:approve", "seq_test:write"])
        expect(lackerSees).not.toContain(row.id)
        expect(requesterSees).toContain(row.id)
      }
    } finally {
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD} AND user_id = ${LACKER}`
      await sql`DELETE FROM kernel.users WHERE id = ${LACKER}`
    }
  })

  it("poll deadline exceeded fails the bundle", async () => {
    const a1 = await gated("step1_async_stuck", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })
    for (let i = 0; i < POLL_SCHEDULE.length; i++) {
      await runApprovalOutputPoll({
        orgId: ORG,
        approvalRequestId: a1,
        toolName: "seq_test:step1_async_stuck",
        attempt: i,
      })
    }
    await drainReinvokeJobs()
    expect(await statusOf(a2)).toBe("cancelled")
    expect(reinvokeSpy).toHaveBeenCalled()
    // I4: the head's execution must be terminalized off `awaiting_output` so a
    // late provider webhook cannot pass resolveDeferredOutput's dedup gate and
    // re-cascade an already-failed bundle.
    const [exec] = await sql`SELECT status FROM kernel.approved_handler_executions
      WHERE approval_request_id = ${a1} AND tool_name = 'seq_test:step1_async_stuck'`
    expect(exec.status).toBe("failed_no_effect")
  })
})
