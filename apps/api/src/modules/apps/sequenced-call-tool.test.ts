// SPDX-License-Identifier: FSL-1.1-ALv2
// A step that cites an earlier step's @ref token and is called through
// `kernel__call_tool` (a tool loaded outside the thread's fixed tool list) is
// the named tool's step. `kernel:call_tool` runs nothing itself: staged as the
// bundle step, its approved execution answered "did not run" and, being a
// read, that answer was recorded as the step's success. The bundle reported
// every step approved while the write it stood for never happened.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { deferrableRef } from "@liaison/shared"
import { z } from "zod"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import * as jobsModule from "~/infra/jobs/jobs"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { recordStarted, recordSucceeded } from "~/modules/approvals/handler-protocol"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const enqueueAppJobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (_appName: string, jobName: string) =>
    `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)

const ORG = "00000000-0000-4000-8000-0000000a7001"
const USER = "00000000-0000-4000-8000-0000000a7002"
const THREAD = "00000000-0000-4000-8000-0000000a7003"
const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["seq_ct:write", "seq_ct:approve", "kernel:threads:read"],
  dimensionGrants: {},
}

const effects: { writes: string[] } = { writes: [] }

async function recordSelf(toolName: string, result: Record<string, unknown>) {
  const [row] = await sql`SELECT id, decided_by FROM kernel.approval_requests
    WHERE org_id = ${ORG} AND tool_name = ${toolName} AND status = 'approving' LIMIT 1`
  const ctx = { orgId: ORG, approvalRequestId: row.id, approvalDeciderId: row.decided_by, toolName }
  await withPrivilegedDb(ORG, "seq-ct-rec", (tx) => recordStarted(tx, ctx, toolName))
  await withPrivilegedDb(ORG, "seq-ct-rec", (tx) => recordSucceeded(tx, ctx, toolName, result))
}

beforeAll(async () => {
  await acquireTestLock()
  const seed = { onConflictDoNothing: true }
  await sql.unsafe(
    insertSql(
      "kernel.organizations",
      { id: ORG, name: "Call Tool Seq Org", slug: "call-tool-seq-org" },
      seed,
    ),
  )
  await sql.unsafe(
    insertSql(
      "kernel.users",
      {
        id: USER,
        org_id: ORG,
        email: "call-tool-seq@test.com",
        name: "Requester",
        status: "active",
        password_hash: "hash",
      },
      seed,
    ),
  )
  await sql.unsafe(
    insertSql(
      "kernel.threads",
      {
        id: THREAD,
        org_id: ORG,
        handle: "call-tool-seq-thread",
        type: "agent_chat",
        created_by: USER,
      },
      seed,
    ),
  )
  await sql.unsafe(
    insertSql(
      "kernel.thread_participants",
      { thread_id: THREAD, user_id: USER, org_id: ORG, role: "admin" },
      seed,
    ),
  )
  await sql.unsafe(
    insertSql("kernel.user_thread_state", { user_id: USER, thread_id: THREAD, org_id: ORG }, seed),
  )
  await sql.unsafe(
    insertSql(
      "kernel.user_scope_grants",
      (actor.scopes ?? []).map((scope) => ({ user_id: USER, org_id: ORG, scope })),
      seed,
    ),
  )
  await registerKernelAgentTools(ORG)

  // The gated head (the company the sales routines write first).
  toolRegistry.set([ORG, "seq_ct", "head"], {
    appName: "seq_ct",
    name: "head",
    description: "gated head producing an id",
    requiredScopes: ["seq_ct:write"],
    gated: true,
    referenceableOutputs: ["id"],
    handler: async () => {
      const r = { id: "company-42" }
      await recordSelf("seq_ct:head", r)
      return r
    },
  } as any)

  // The write that cites it (the contact), loaded outside the fixed list.
  toolRegistry.set([ORG, "seq_ct", "write"], {
    appName: "seq_ct",
    name: "write",
    description: "write citing the head",
    requiredScopes: ["seq_ct:write"],
    gated: true,
    params: z.object({ name: z.string(), companyId: deferrableRef(z.string()) }),
    handler: async (p: any) => {
      effects.writes.push(`${p.name}@${p.companyId}`)
      const r = { written: p.companyId }
      await recordSelf("seq_ct:write", r)
      return r
    },
  } as any)
})
afterEach(async () => {
  effects.writes = []
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})
afterAll(async () => {
  enqueueAppJobSpy.mockRestore()
  toolRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

/** A chat turn's frame: the tools it holds, the cited write among them. */
function turnFrame(): RunContext {
  return {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId: ORG }),
    turnToolNames: new Set(["kernel__call_tool", "seq_ct__head", "seq_ct__write"]),
  } as RunContext
}

function call(toolName: string, params: Record<string, unknown>) {
  return runContextStore.run(turnFrame(), () =>
    executeTool({ toolName, orgId: ORG, actor, params, threadId: THREAD, origin: "in-app-agent" }),
  )
}

describe("a deferred step called through kernel__call_tool", () => {
  it("is staged as the tool it names, and runs on the head's approval", async () => {
    const head = await call("seq_ct:head", {})
    const a1 = head.blocked!.approvalRequestId!

    const r = await call("kernel:call_tool", {
      name: "seq_ct__write",
      arguments: { name: "Ana", companyId: `@ref:${a1}:id` },
    })
    expect(r.blocked?.sequenced).toBe(true)
    const a2 = r.blocked!.approvalRequestId!
    const [step] = await sql`SELECT tool_name, status, bundle_id, current_payload
      FROM kernel.approval_requests WHERE id = ${a2}`
    expect(step.status).toBe("deferred")
    expect(step.bundle_id).toBe(a1)
    expect(step.tool_name).toBe("seq_ct:write")
    expect(effects.writes).toEqual([])

    await decideApproval({ orgId: ORG, requestId: a1, actor, decision: "approve" })

    // The write happened, with the head's real id.
    expect(effects.writes).toEqual(["Ana@company-42"])
    expect(await readDecidedResult(ORG, a2)).toEqual({ written: "company-42" })
  })

  it("never stages kernel:call_tool itself when it names no tool the turn holds", async () => {
    const head = await call("seq_ct:head", {})
    const a1 = head.blocked!.approvalRequestId!
    await expect(
      call("kernel:call_tool", {
        name: "seq_ct__unknown",
        arguments: { companyId: `@ref:${a1}:id` },
      }),
    ).rejects.toThrow(/No tool named "seq_ct__unknown"/)
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM kernel.approval_requests
      WHERE org_id = ${ORG} AND tool_name = 'kernel:call_tool'`
    expect(n).toBe(0)
  })
})
