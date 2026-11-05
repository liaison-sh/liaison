// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T8 — Approval rerouting from sub-runs to the parent's thread.
//
// When a sub-run gates a tool, the resulting approval row must:
//  1. Surface in the PARENT run's thread (not buried in the hidden sub-run
//     thread) so the operator sees the approval card in their primary view.
//  2. Carry a breadcrumb in `metadata`: { runId, parentRunId, subagentType, label }
//     so the frontend can render "Triggered by sub-run …" with a deep-link.
//
// This file exercises the rerouting end-to-end by registering a gated test
// tool, planting parent + sub-run rows in `agent_runs`, opening a
// `runContextStore.run(...)` frame matching the sub-run, then calling
// executeTool — the same code path the worker uses inside its agent loop.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { agentRuns, approvalRequests, threads as kernelThreads } from "~/db/schema/kernel"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const TOOL_APP = "subrun_gate_test"
const TOOL_NAME = "gatedNoop"

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await releaseTestLock()
})

function actorFor(orgId: string, userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

async function createThread(
  orgId: string,
  userId: string,
  type: "thread" | "subrun" = "thread",
): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "create-thread", async (tx) =>
    tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `t-${crypto.randomUUID().slice(0, 8)}`,
        type,
        hiddenFromList: type === "subrun",
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id }),
  )
  return row.id
}

async function insertRun(opts: {
  orgId: string
  threadId: string
  actor: UserContext
  parentRunId?: string
  subagentType?: string
  summary?: string
  nestingDepth?: number
}): Promise<string> {
  const id = crypto.randomUUID()
  await withPrivilegedDb(opts.orgId, "insert-run", async (tx) => {
    await tx.insert(agentRuns).values({
      id,
      orgId: opts.orgId,
      parentRunId: opts.parentRunId ?? null,
      rootRunId: opts.parentRunId ?? id,
      threadId: opts.threadId,
      subagentType: opts.subagentType ?? null,
      actor: opts.actor,
      effectiveScopes: opts.actor.scopes,
      status: "running",
      prompt: "",
      maxSteps: 10,
      timeoutMs: 60_000,
      schemaRetryBudget: 3,
      nestingDepth: opts.nestingDepth ?? 0,
      summary: opts.summary ?? null,
    })
  })
  return id
}

describe("approval rerouting (T8)", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id

    // Register the gated test tool once per org. The handler is a no-op — we
    // only care that the approval row is created.
    toolRegistry.set([orgId, TOOL_APP, TOOL_NAME], {
      appName: TOOL_APP,
      name: TOOL_NAME,
      description: "Gated no-op for T8 rerouting",
      requiredScopes: [`${TOOL_APP}:gated:write`],
      gated: true,
      handler: async () => ({ ok: true }),
      returns: { schema: { ok: "boolean" } },
    } as never)
  })

  it("sub-run gated tool surfaces approval in parent thread with breadcrumb metadata", async () => {
    const parentThreadId = await createThread(orgId, userId, "thread")
    const subRunThreadId = await createThread(orgId, userId, "subrun")
    const actor = actorFor(orgId, userId, [`${TOOL_APP}:gated:write`])

    const parentRunId = await insertRun({
      orgId,
      threadId: parentThreadId,
      actor,
      nestingDepth: 0,
    })
    const subRunId = await insertRun({
      orgId,
      threadId: subRunThreadId,
      actor,
      parentRunId,
      subagentType: "ticket-investigator",
      summary: "JIRA-1234",
      nestingDepth: 1,
    })

    // Drive executeTool inside the sub-run's runContextStore frame. The frame
    // carries a turnScopeAccumulator exactly as subrun-worker.ts builds it: the
    // write guard reads the accumulator to judge the turn's scope taint, and a
    // frame without one means "taint unknowable", which fails closed.
    const envelope = await runContextStore.run(
      {
        runId: subRunId,
        parentRunId,
        rootRunId: parentRunId,
        nestingDepth: 1,
        turnScopeAccumulator: createTurnScopeAccumulator(),
      },
      () =>
        executeTool({
          toolName: `${TOOL_APP}:${TOOL_NAME}`,
          orgId,
          actor,
          params: {},
          threadId: subRunThreadId,
          origin: "in-app-agent",
        }),
    )
    const approvalRequestId =
      "blocked" in envelope ? envelope.blocked?.approvalRequestId : undefined
    expect(approvalRequestId).toBeDefined()
    if (!approvalRequestId) throw new Error("unreachable")

    const [row] = await withPrivilegedDb(orgId, "verify-approval", async (tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.id, approvalRequestId)).limit(1),
    )
    expect(row).toBeDefined()
    // Surface: parent thread, not the hidden sub-run thread.
    expect(row.threadId).toBe(parentThreadId)
    // Origin: still the sub-run thread (provenance).
    expect(row.originatingThreadId).toBe(subRunThreadId)
    // Breadcrumb metadata.
    const md = row.metadata as Record<string, unknown>
    expect(md.runId).toBe(subRunId)
    expect(md.parentRunId).toBe(parentRunId)
    expect(md.subagentType).toBe("ticket-investigator")
    expect(md.label).toBe("JIRA-1234")
  })

  it("root run (no parentRunId in frame) does NOT reroute — surface stays on the originating thread", async () => {
    const threadId = await createThread(orgId, userId, "thread")
    const actor = actorFor(orgId, userId, [`${TOOL_APP}:gated:write`])
    const rootRunId = await insertRun({
      orgId,
      threadId,
      actor,
      nestingDepth: 0,
    })

    const envelope = await runContextStore.run(
      {
        runId: rootRunId,
        parentRunId: null, // top-level run — no parent to reroute to
        rootRunId,
        nestingDepth: 0,
        turnScopeAccumulator: createTurnScopeAccumulator(),
      },
      () =>
        executeTool({
          toolName: `${TOOL_APP}:${TOOL_NAME}`,
          orgId,
          actor,
          params: {},
          threadId,
          origin: "in-app-agent",
        }),
    )
    const approvalRequestId =
      "blocked" in envelope ? envelope.blocked?.approvalRequestId : undefined
    expect(approvalRequestId).toBeDefined()
    if (!approvalRequestId) throw new Error("unreachable")

    const [row] = await withPrivilegedDb(orgId, "verify-root", async (tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.id, approvalRequestId)).limit(1),
    )
    // Without a parent frame, the approval surface stays on the discussion
    // thread (auto-created by createApprovalRequest when requesterCanApprove
    // is false) or the originating thread. Either way, no breadcrumb metadata
    // claiming a sub-run origin should appear.
    const md = row.metadata as Record<string, unknown>
    expect(md.runId).toBeUndefined()
    expect(md.parentRunId).toBeUndefined()
    expect(md.subagentType).toBeUndefined()
  })

  // Rerouting must never become a way around scope taint. The two cases above
  // run on an UNTAINTED sub-run turn, which is why their gated call reaches the
  // approval path at all. A turn that has read scoped data is refused at the
  // write guard instead, and no approval row is created for it: an approval is
  // a queued write, so queueing one here would launder the read past the
  // visibility gate the moment a human approved it. If this case ever goes
  // green by returning an approval, the write guard has been weakened.
  it("a tainted sub-run turn is refused before any approval row exists", async () => {
    const parentThreadId = await createThread(orgId, userId, "thread")
    const subRunThreadId = await createThread(orgId, userId, "subrun")
    const actor = actorFor(orgId, userId, [`${TOOL_APP}:gated:write`])

    const parentRunId = await insertRun({
      orgId,
      threadId: parentThreadId,
      actor,
      nestingDepth: 0,
    })
    const subRunId = await insertRun({
      orgId,
      threadId: subRunThreadId,
      actor,
      parentRunId,
      subagentType: "ticket-investigator",
      summary: "JIRA-1234",
      nestingDepth: 1,
    })

    const tainted = createTurnScopeAccumulator()
    tainted.recordInjected(["app_finance:invoices:read"])

    // The public executeTool wrapper turns a refusal envelope into a thrown
    // typed error carrying the code, so the refusal is a rejection here, not a
    // returned envelope. The call is made inside the assertion's own thunk so
    // it genuinely runs.
    const attempt = async () =>
      runContextStore.run(
        {
          runId: subRunId,
          parentRunId,
          rootRunId: parentRunId,
          nestingDepth: 1,
          turnScopeAccumulator: tainted,
        },
        () =>
          executeTool({
            toolName: `${TOOL_APP}:${TOOL_NAME}`,
            orgId,
            actor,
            params: {},
            threadId: subRunThreadId,
            origin: "in-app-agent",
          }),
      )

    await expect(attempt()).rejects.toMatchObject({ code: "E_SCOPE_TAINT_BLOCKED" })

    const rows = await withPrivilegedDb(orgId, "verify-no-approval", async (tx) =>
      tx
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.originatingThreadId, subRunThreadId)),
    )
    expect(rows).toHaveLength(0)
  })
})
