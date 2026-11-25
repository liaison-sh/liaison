// SPDX-License-Identifier: FSL-1.1-ALv2
// The sales tour's `researching` step, played on the real sequence (demo walk
// 2026-11-25): the visitor's routine asks for the company and the contact first
// and pauses there, before the quote and the reply. The step says which request
// the run waits on (its Do it for me approves it), the request is approved as
// Home's row approves it, the run resumes and proposes the quote and the reply,
// and the step arrives on the events that resumed run really queued.
//
// What is real: the routine tick and its pause, executeTool in the run's frame,
// the Home feed row, decideApproval and its cascade, the resume, the outbox
// rows, the tour consumer and the step status. Stubbed: the agent's turns (they
// make the calls a model would) and the job queue, which records.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import * as jobsModule from "~/infra/jobs/jobs"

const enqueued: Array<{ jobName: string; payload: Record<string, unknown> }> = []
const enqueueSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (
  _app: string,
  jobName: string,
  payload: Record<string, unknown>,
  opts?: { jobId?: string },
) => {
  enqueued.push({ jobName, payload })
  return opts?.jobId ?? `${jobName}:stub`
}) as typeof jobsModule.enqueueAppJob)

import {
  type EffectiveBeat,
  effectiveBeats,
  findTour,
  SAAS_PROSPECT_ROUTINE_NAME,
  type Tour,
  type TourProgress,
} from "@liaison/shared"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages, routines as routinesTbl } from "~/db/schema/kernel"
import type { AppEvent } from "~/infra/events/event-bus"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { resumeRoutineRunOnDecision } from "~/modules/agent/routines/routine-run-resume"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import {
  currentRunContext,
  inheritedRunFields,
  type RunContext,
  runContextStore,
} from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  APPROVAL_RESULT_TURN_JOB,
  type ApprovalResultTurnPayload,
} from "~/modules/approvals/approval-result-turn"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { visitorMarker } from "~/modules/demo/demo-org"
import { computeBeatStatus } from "~/modules/tours/beat-status"
import { handleTourProgressEvent } from "~/modules/tours/consumer"
import { personalAgentDmId } from "~/modules/tours/conversation"
import { startTour } from "~/modules/tours/service"
import * as minimal from "~/seed/tiers/minimal"
import { markDemoOrgForTest } from "~/tests/helpers/demo-org"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const TOUR = findTour("kernel.scenario-saas-sales") as Tour
const beats = effectiveBeats(TOUR, { installedApps: ["mail"], isDemo: true, worldId: "saas" })
const beat = (id: string) => beats.find((b) => b.id === id) as EffectiveBeat

/** The company and contact writes (a test app); the reply is the tour's own tool name. */
const APP = "sales_wait_test"

let orgId: string
let userId: string
let ownerAgentId: string
let owner: UserContext
let routineId: string
/** The prospect's conversation the live email beat recorded. */
const email = crypto.randomUUID()
let startedAt: string

/** One gated call of the run's turn, in the frame agent-service.ts builds for it. */
async function gated(threadId: string, toolName: string, params: Record<string, unknown>) {
  const frame: RunContext = {
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
  const res = await runContextStore.run(frame, () =>
    executeTool({ toolName, orgId, actor: owner, params, threadId, origin: "in-app-agent" }),
  )
  expect(res.blocked?.approvalRequestId).toBeString()
  return res.blocked?.approvalRequestId as string
}

async function agentReply(threadId: string, content: string) {
  await withPrivilegedDb(orgId, "sales-wait-reply", (tx) =>
    tx.insert(messages).values({
      threadId,
      orgId,
      authorId: userId,
      authorType: "agent",
      authorAgentId: ownerAgentId,
      content,
      requiredScopes: [],
    }),
  )
}

/** The person's run of the tour, standing on `researching`, as the earlier beats left it. */
function progressAt(beatId: string, beatStates: TourProgress["beatStates"]): TourProgress {
  return {
    tourId: TOUR.id,
    status: "active",
    beatId,
    beatIndex: beats.findIndex((b) => b.id === beatId),
    beatCount: beats.length,
    beatStates,
    source: "demo",
    startedAt,
    updatedAt: new Date().toISOString(),
  }
}

async function tourRow(): Promise<{ beat_id: string; beat_states: TourProgress["beatStates"] }> {
  const [row] = await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
    WHERE org_id = ${orgId} AND user_id = ${userId} AND tour_id = ${TOUR.id}`
  return row as { beat_id: string; beat_states: TourProgress["beatStates"] }
}

const status = async () => {
  const row = await tourRow()
  return computeBeatStatus({
    orgId,
    userId,
    progress: progressAt(row.beat_id, row.beat_states),
    beat: beat(row.beat_id),
    beats,
  })
}

/** The outbox delivered: every event queued since `fromSeq`, through the tour consumer. */
async function deliverSince(fromSeq: bigint): Promise<bigint> {
  const rows = await sql`SELECT id, seq, payload FROM kernel.pending_events
    WHERE org_id = ${orgId} AND seq > ${fromSeq.toString()} ORDER BY seq`
  let last = fromSeq
  for (const row of rows) {
    await handleTourProgressEvent({ eventId: String(row.id), event: row.payload as AppEvent })
    last = BigInt(row.seq as string | number)
  }
  return last
}

async function outboxSeq(): Promise<bigint> {
  const [row] = await sql`SELECT COALESCE(max(seq), 0) AS seq FROM kernel.pending_events`
  return BigInt((row?.seq as string | number) ?? 0)
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  // A visitor's workspace of the software world: the tour is that world's.
  await markDemoOrgForTest(orgId, visitorMarker(24, new Date(), ["sales"], { worldId: "saas" }))
  userId = (await minimal.person(orgId, { role: "admin" })).id
  ownerAgentId = await withPrivilegedDb(orgId, "sales-wait-agent", (tx) =>
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
      handler: async () => result,
    } as never)
  tool(APP, "company", ["id"], { id: "co-1" })
  tool(APP, "contact", ["id"], { id: "ct-1" })
  tool(APP, "quote", ["number"], { number: "Q-0042" })
  tool("mail", "reply", [], { sent: true })
  const conversation = await minimal.thread(orgId, userId)
  const [row] = await withPrivilegedDb(orgId, "sales-wait-routine", (tx) =>
    tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        ownerAgentId,
        name: SAAS_PROSPECT_ROUTINE_NAME,
        description: "Sales wait test routine",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Record the group, quote it, reply with the quote.",
        scopes: [],
        reportThreadId: conversation,
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routinesTbl.id }),
  )
  routineId = row?.id as string
  startedAt = new Date(Date.now() - 60_000).toISOString()
  // The visitor started the tour, switched the routine on, and the prospect's email came in.
  const conversationId = await personalAgentDmId(orgId, userId)
  await withPrivilegedDb(orgId, "sales-wait-tour", (tx) =>
    startTour(tx, {
      orgId,
      userId,
      tour: TOUR,
      beats,
      source: "demo",
      actor: { userId, actorType: "user" },
      conversationId,
    }),
  )
  await sql`UPDATE kernel.tour_progress
    SET beat_id = 'researching', beat_index = ${beats.findIndex((b) => b.id === "researching")},
      beat_states = beat_states || ${JSON.stringify({
        enable: { state: "done", entityId: routineId },
        "live-email": { state: "done", entityId: email },
      })}::jsonb,
      started_at = ${startedAt}
    WHERE org_id = ${orgId} AND user_id = ${userId} AND tour_id = ${TOUR.id}`
})

afterAll(async () => {
  enqueueSpy.mockRestore()
  toolRegistry.deleteByPrefix([orgId])
  await clearRedisPatterns(["routine-lock:*"])
  await releaseTestLock()
})

describe("sales tour: a routine that asks for the company first", () => {
  it("names the request the run waits on, is approved from Home, resumes, and the step arrives", async () => {
    let seq = await outboxSeq()
    // The run's first turn: the company and the contact, chained, then it pauses.
    let head = ""
    let contact = ""
    const tick = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        head = await gated(input.threadId, `${APP}:company`, { name: "Résidence Olympe" })
        contact = await gated(input.threadId, `${APP}:contact`, { companyId: `@ref:${head}:id` })
        await agentReply(input.threadId, "Approve them and the run goes on with the quote.")
        return { turnsAdded: 1 }
      },
    })
    expect(tick.status).toBe("waiting_approval")
    seq = await deliverSince(seq)
    // The step has not arrived (no reply yet): it says the run waits on THIS request.
    expect((await tourRow()).beat_states.researching).toBeUndefined()
    expect(await status()).toEqual({
      kind: "routine-waiting",
      routineName: SAAS_PROSPECT_ROUTINE_NAME,
      requestId: head,
      toolName: `${APP}:company`,
    })

    // Home shows the request as one row with its two steps; its Approve sends
    // what the row carries. Without the later step's fingerprint the server
    // refuses it (the walk's "Approve did nothing").
    const items = await withRlsContext(owner, (tx) =>
      computeApprovalAttentionItems(tx, orgId, userId),
    )
    const action = items.find((i) => i.entityId === head)?.action
    if (action?.type !== "decide_approval") throw new Error("no Home row for the request")
    expect(Object.keys(action.stepPayloadHashes ?? {})).toEqual([contact])
    await expect(
      decideApproval({
        orgId,
        requestId: head,
        actor: owner,
        decision: "approve",
        payloadHash: action.payloadHash,
      } as never),
    ).rejects.toMatchObject({ status: 409 })
    await decideApproval({
      orgId,
      requestId: head,
      actor: owner,
      decision: "approve",
      payloadHash: action.payloadHash,
      stepPayloadHashes: action.stepPayloadHashes,
    } as never)
    const decided = await sql`SELECT status FROM kernel.approval_requests
      WHERE id = ANY(${[head, contact]}::uuid[])`
    expect(decided.map((r) => r.status)).toEqual(["approved", "approved"])
    // Decided: nothing left for Do it for me to press.
    expect(await status()).toMatchObject({ requestId: null })

    // The decision resumes the run: it proposes the quote and the reply.
    const job = enqueued.filter(
      (j) => j.jobName === APPROVAL_RESULT_TURN_JOB && j.payload.approvalId === contact,
    )
    expect(job).toHaveLength(1)
    const resumed = await resumeRoutineRunOnDecision(
      job[0]?.payload as unknown as ApprovalResultTurnPayload,
      {
        loadOwnerScopes: async () => ["*"],
        checkCredits: async () => null,
        invoker: async (input) => {
          const quote = await gated(input.threadId, `${APP}:quote`, { customer: "co-1" })
          await gated(input.threadId, "mail:reply", {
            conversationId: email,
            textBody: `Your quote @ref:${quote}:number is attached.`,
          })
          await agentReply(input.threadId, "Proposed the quote and the reply.")
          return { turnsAdded: 1 }
        },
      },
    )
    expect(resumed.status).toBe("waiting_approval")

    // The events that resumed run queued reach the tour: the step arrives.
    await deliverSince(seq)
    const row = await tourRow()
    expect(row.beat_id).toBe("researching")
    expect(row.beat_states.researching).toMatchObject({ state: "done" })
    expect((await status()).kind).toBe("done")
  })
})
