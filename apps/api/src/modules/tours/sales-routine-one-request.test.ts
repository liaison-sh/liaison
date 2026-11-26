// SPDX-License-Identifier: FSL-1.1-ALv2
// A routine run's work is ONE request, whatever each step cites (demo walk
// 2026-11-25, services world). The sales run asked for the company, then the
// deal and the proposal citing it with @ref tokens, then the reply naming the
// firm in plain words: that reply cited no token, so it became a request of
// its own, staged two seconds after the rest. Both waited at once, Home folded
// them into one collapsed group the tour could not see into, and a visitor
// who opened the group approved the reply first: it went out before the
// company, the deal and the proposal it spoke of existed.
//
// Now every gated call of a routine's run joins the run's request, in the
// order proposed: the reply is its last step, it cannot be approved on its
// own, it runs last on the one approval, and a write it makes is marked as
// the routine's own work so the routine does not run again on it.
//
// What is real: the routine tick and its pause, executeTool in the run's frame,
// the Home feed, decideApproval and its cascade. Stubbed: the agent's turn (it
// makes the calls a model would) and the job queue, which records.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import * as jobsModule from "~/infra/jobs/jobs"

const enqueueSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (
    _app: string,
    jobName: string,
    _payload: Record<string, unknown>,
    opts?: { jobId?: string },
  ) => opts?.jobId ?? `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)

import { STUDIO_PROSPECT_ROUTINE_NAME } from "@liaison/shared"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { routines as routinesTbl } from "~/db/schema/kernel"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import {
  currentRunContext,
  inheritedRunFields,
  type RunContext,
  runContextStore,
} from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const APP = "sales_one_request_test"

let orgId: string
let userId: string
let ownerAgentId: string
let owner: UserContext
let routineId: string
/** The writes as they ran, and the routine each one's frame said it was approved for. */
const ran: Array<{ tool: string; approvedFor: string | undefined }> = []

/** The run's turn frame, as agent-service.ts builds it once per turn. */
function turnFrame(): RunContext {
  return {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    background: true,
    humanTurn: false,
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
    routineId: currentRunContext()?.routineId,
    ...inheritedRunFields(currentRunContext()),
  }
}

/** One gated call of the turn, in its frame. */
async function gated(
  frame: RunContext,
  threadId: string,
  toolName: string,
  params: Record<string, unknown>,
) {
  const res = await runContextStore.run(frame, () =>
    executeTool({ toolName, orgId, actor: owner, params, threadId, origin: "in-app-agent" }),
  )
  expect(res.blocked?.approvalRequestId).toBeString()
  return res.blocked?.approvalRequestId as string
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  ownerAgentId = await withPrivilegedDb(orgId, "one-request-agent", (tx) =>
    getOrCreatePersonalAgentId(tx, { orgId, userId }),
  )
  owner = { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: { "*": ["*"] } }
  const tool = (app: string, name: string, outputs: string[], result: Record<string, unknown>) =>
    toolRegistry.set([orgId, app, name], {
      appName: app,
      name,
      description: `${name} (gated)`,
      requiredScopes: [`${app}:${name}:write`],
      gated: true,
      referenceableOutputs: outputs,
      handler: async () => {
        ran.push({ tool: `${app}:${name}`, approvedFor: currentRunContext()?.approvedForRoutineId })
        return result
      },
    } as never)
  tool(APP, "company", ["id", "name"], { id: "co-1", name: "Corail Paysages" })
  tool(APP, "deal", [], { id: "deal-1" })
  tool(APP, "proposal", [], { id: "sow-1" })
  tool("mail", "reply", [], { sent: true })
  const conversation = await minimal.thread(orgId, userId)
  const [row] = await withPrivilegedDb(orgId, "one-request-routine", (tx) =>
    tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        ownerAgentId,
        name: STUDIO_PROSPECT_ROUTINE_NAME,
        description: "One request test routine",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Record the firm, the deal and the proposal, then reply.",
        scopes: [],
        reportThreadId: conversation,
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routinesTbl.id }),
  )
  routineId = row?.id as string
})

afterAll(async () => {
  enqueueSpy.mockRestore()
  toolRegistry.deleteByPrefix([orgId])
  await clearRedisPatterns(["routine-lock:*"])
  await releaseTestLock()
})

describe("a routine run's work is one request", () => {
  it("a reply citing no token joins the run's request, is decided with it and runs last", async () => {
    const ids: Record<string, string> = {}
    const tick = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        const frame = turnFrame()
        ids.company = await gated(frame, input.threadId, `${APP}:company`, {
          name: "Corail Paysages",
        })
        ids.deal = await gated(frame, input.threadId, `${APP}:deal`, {
          companyId: `@ref:${ids.company}:id`,
        })
        ids.proposal = await gated(frame, input.threadId, `${APP}:proposal`, {
          companyId: `@ref:${ids.company}:id`,
        })
        // The firm named in plain words: no token cited.
        ids.reply = await gated(frame, input.threadId, "mail:reply", {
          conversationId: crypto.randomUUID(),
          textBody: "Thank you for the brief, Corail Paysages: a proposal with its price follows.",
        })
        return { turnsAdded: 1 }
      },
    })
    expect(tick.status).toBe("waiting_approval")

    // One request: the company heads it, the other steps wait behind it in the order proposed.
    const rows = (await sql`SELECT id, status, bundle_id, bundle_position, depends_on_id
      FROM kernel.approval_requests WHERE org_id = ${orgId} ORDER BY bundle_position`) as Array<{
      id: string
      status: string
      bundle_id: string | null
      bundle_position: number | null
      depends_on_id: string | null
    }>
    expect(rows.map((r) => r.id)).toEqual([ids.company, ids.deal, ids.proposal, ids.reply])
    expect(rows.map((r) => r.status)).toEqual(["pending", "deferred", "deferred", "deferred"])
    expect(new Set(rows.map((r) => r.bundle_id))).toEqual(new Set([ids.company]))
    // The reply waits for the proposal: declining that declines the reply with it.
    expect(rows[3]?.depends_on_id).toBe(ids.proposal)

    // Home shows one row for it, the company's.
    const items = await withRlsContext(owner, (tx) =>
      computeApprovalAttentionItems(tx, orgId, userId),
    )
    const approvals = items.filter((i) => i.kind === "approval_pending")
    expect(approvals.map((i) => i.entityId)).toEqual([ids.company])

    // The reply cannot be approved ahead of the writes it speaks of.
    await expect(
      decideApproval({ orgId, requestId: ids.reply, actor: owner, decision: "approve" } as never),
    ).rejects.toThrow("decide the sequence via its first step")
    expect(ran).toEqual([])

    // One approval runs every step, in order, the reply last; each write is the routine's own.
    const action = approvals[0]?.action
    if (action?.type !== "decide_approval") throw new Error("no Home action for the request")
    await decideApproval({
      orgId,
      requestId: ids.company,
      actor: owner,
      decision: "approve",
      payloadHash: action.payloadHash,
      stepPayloadHashes: action.stepPayloadHashes,
    } as never)
    expect(ran.map((r) => r.tool)).toEqual([
      `${APP}:company`,
      `${APP}:deal`,
      `${APP}:proposal`,
      "mail:reply",
    ])
    expect(new Set(ran.map((r) => r.approvedFor))).toEqual(new Set([routineId]))
  })
})
