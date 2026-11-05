// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import * as jobsModule from "~/infra/jobs/jobs"

// enqueueAppJob throws "No handler registered" inside bun:test — kernel job
// workers are only registered in the server entrypoints. Stub it so
// enqueuePoll becomes a recorded no-op; the test drives runApprovalOutputPoll
// directly, so no real queued job is needed. Use spyOn (restored in afterAll),
// NOT mock.module — mock.module leaks process-wide and would replace the whole
// jobs module for every later test file in the same `bun test` process,
// breaking any test that needs the real enqueueAppJob.
const enqueuedJobs: Array<{ appName: string; jobName: string; payload: unknown }> = []
const enqueueAppJobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (
  appName: string,
  jobName: string,
  payload: unknown,
) => {
  enqueuedJobs.push({ appName, jobName, payload })
  return `${jobName}:stub`
}) as typeof jobsModule.enqueueAppJob)

import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { decideApproval } from "~/modules/approvals/decide"
import {
  recordAwaitingOutput,
  recordStarted,
  recordSucceeded,
} from "~/modules/approvals/handler-protocol"
import { POLL_SCHEDULE, runApprovalOutputPoll } from "~/modules/approvals/poll-output"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000a6001"
const USER = "00000000-0000-4000-8000-0000000a6002"
const THREAD = "00000000-0000-4000-8000-0000000a6003"
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
async function recordAwaitingSelf(toolName: string, partial: unknown) {
  const [row] = await sql`SELECT id, decided_by FROM kernel.approval_requests
    WHERE org_id = ${ORG} AND tool_name = ${toolName} AND status = 'approving' LIMIT 1`
  const ctx = { orgId: ORG, approvalRequestId: row.id, approvalDeciderId: row.decided_by, toolName }
  await withPrivilegedDb(ORG, "seq-rec", (tx) => recordStarted(tx, ctx, toolName))
  await withPrivilegedDb(ORG, "seq-rec", (tx) => recordAwaitingOutput(tx, ctx, toolName, partial))
}

let pollCalls = 0

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Poll Output Org', 'poll-output-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
    VALUES (${USER}, ${ORG}, 'poll-output@test.com', 'Decider', 'active', 'hash') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}, ${ORG}, 'poll-output-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
  for (const scope of ["seq_test:write", "seq_test:approve"]) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }

  toolRegistry.set([ORG, "seq_test", "step1_async"], {
    appName: "seq_test",
    name: "step1_async",
    description: "async s1",
    requiredScopes: ["seq_test:write"],
    gated: true,
    referenceableOutputs: ["value"],
    handler: async () => {
      await recordAwaitingSelf("seq_test:step1_async", { ticket: "T-1" })
      return {}
    },
    poll: async () => {
      pollCalls++
      return pollCalls >= 2 ? { ready: true, result: { value: "label-123" } } : { ready: false }
    },
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
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})
afterAll(async () => {
  enqueueAppJobSpy.mockRestore()
  toolRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

async function gated(tool: string, params: Record<string, unknown>) {
  const r = await executeTool({
    toolName: `seq_test:${tool}`,
    orgId: ORG,
    actor,
    params,
    threadId: THREAD,
    origin: "in-app-agent",
  })
  return r.blocked!.approvalRequestId!
}
async function statusOf(id: string) {
  const [r] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return r.status as string
}

describe("async output polling", () => {
  it("parks the cascade on awaiting_output, resumes step 2 when the poll resolves", async () => {
    pollCalls = 0
    const a1 = await gated("step1_async", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })

    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })
    expect(await statusOf(a1)).toBe("approved")
    expect(await statusOf(a2)).toBe("deferred")
    const [exec] = await sql`SELECT status FROM kernel.approved_handler_executions
      WHERE approval_request_id = ${a1}`
    expect(exec.status).toBe("awaiting_output")

    await runApprovalOutputPoll({
      orgId: ORG,
      approvalRequestId: a1,
      toolName: "seq_test:step1_async",
      attempt: 0,
    })
    expect(await statusOf(a2)).toBe("deferred")
    await runApprovalOutputPoll({
      orgId: ORG,
      approvalRequestId: a1,
      toolName: "seq_test:step1_async",
      attempt: 1,
    })
    await runApprovalOutputPoll({
      orgId: ORG,
      approvalRequestId: a1,
      toolName: "seq_test:step1_async",
      attempt: 2,
    })

    expect(await readDecidedResult(ORG, a1)).toEqual({ value: "label-123" })
    expect(await statusOf(a2)).toBe("approved")
    expect(await readDecidedResult(ORG, a2)).toEqual({ sent: "label-123" })
  })

  it("duplicate output resolution cascades exactly once", async () => {
    pollCalls = 0
    const a1 = await gated("step1_async", { kind: "x" })
    const a2 = await gated("step2", { note: `@ref:${a1}:value` })
    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })

    const { resolveDeferredOutput } = await import("~/modules/approvals/poll-output")
    await resolveDeferredOutput(ORG, a1, "seq_test:step1_async", { value: "label-123" })
    await resolveDeferredOutput(ORG, a1, "seq_test:step1_async", { value: "label-123" })

    expect(await statusOf(a2)).toBe("approved")
    const execs = await sql`SELECT id FROM kernel.approved_handler_executions
      WHERE approval_request_id = ${a2}`
    expect(execs.length).toBe(1)
  })

  it("POLL_SCHEDULE is a monotonic-increasing backoff starting at 0", () => {
    expect(POLL_SCHEDULE.length).toBeGreaterThanOrEqual(2)
    expect(POLL_SCHEDULE[0]).toBe(0)
    for (let i = 1; i < POLL_SCHEDULE.length; i++) {
      expect(POLL_SCHEDULE[i]).toBeGreaterThan(POLL_SCHEDULE[i - 1])
    }
  })
})
