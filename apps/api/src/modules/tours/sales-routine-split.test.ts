// SPDX-License-Identifier: FSL-1.1-ALv2
// The services world's sales tour, played on the real sequence when the run
// splits its work (demo walk 2026-11-25): on Auto the routine asked for the
// company and the deal, paused there, and once that request was approved the
// reply came as a request of its own. The tour's `bundle`, `bundle-steps` and
// `approve` steps rang only the chained request's head row, which was not
// there, so "Approve once" never passed and its Do it for me spun. They ring
// the lone reply's row too now, and the step arrives on its approval. A run
// that ends "succeeded" without staging the reply never counts `researching`
// as arrived: the step says the run finished without doing it.
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
  STUDIO_PROSPECT_ROUTINE_NAME,
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

const TOUR = findTour("kernel.scenario-studio-sales") as Tour
const beats = effectiveBeats(TOUR, { installedApps: ["mail"], isDemo: true, worldId: "studio" })
const beat = (id: string) => beats.find((b) => b.id === id) as EffectiveBeat

/** The company and deal writes (a test app); the reply is the tour's own tool name. */
const APP = "sales_split_test"
const REPLY = "mail:reply"

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
  await withPrivilegedDb(orgId, "sales-split-reply", (tx) =>
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

/** The person stands on `beatId`, with the run's earlier steps as `states` left them. */
async function standOn(beatId: string, states: Record<string, unknown>) {
  await sql`UPDATE kernel.tour_progress
    SET beat_id = ${beatId}, beat_index = ${beats.findIndex((b) => b.id === beatId)},
      beat_states = ${JSON.stringify(states)}::jsonb, started_at = ${startedAt}
    WHERE org_id = ${orgId} AND user_id = ${userId} AND tour_id = ${TOUR.id}`
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

/** The request's row on Home, and its Approve as Home sends it. */
async function approveFromHome(requestId: string): Promise<string | undefined> {
  const items = await withRlsContext(owner, (tx) =>
    computeApprovalAttentionItems(tx, orgId, userId),
  )
  const item = items.find((i) => i.entityId === requestId)
  const action = item?.action
  if (action?.type !== "decide_approval") throw new Error("no Home row for the request")
  await decideApproval({
    orgId,
    requestId,
    actor: owner,
    decision: "approve",
    payloadHash: action.payloadHash,
    stepPayloadHashes: action.stepPayloadHashes,
  } as never)
  const tool = (item?.metadata as { toolName?: unknown } | undefined)?.toolName
  return typeof tool === "string" ? tool : undefined
}

/** The tools a step's `data-tool-name` ring names, in order of preference. */
function ringedTools(anchor: string | undefined): string[] {
  const m = /\[data-tool-name=([^\]]+)\]/.exec(anchor ?? "")
  return m?.[1]?.split("|") ?? []
}

/** The visitor's prospect routine, reporting in a conversation of its own. */
async function makeRoutine(name: string = STUDIO_PROSPECT_ROUTINE_NAME): Promise<string> {
  const conversation = await minimal.thread(orgId, userId)
  const [row] = await withPrivilegedDb(orgId, "sales-split-routine", (tx) =>
    tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        ownerAgentId,
        name,
        description: "Sales split test routine",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Record the firm and the deal, draft the proposal, reply.",
        scopes: [],
        reportThreadId: conversation,
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routinesTbl.id }),
  )
  return row?.id as string
}

const EARLIER = {
  enable: { state: "done", entityId: "" },
  "live-email": { state: "done", entityId: email },
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  // A visitor's workspace of the services world: the tour is that world's.
  await markDemoOrgForTest(orgId, visitorMarker(24, new Date(), ["sales"], { worldId: "studio" }))
  userId = (await minimal.person(orgId, { role: "admin" })).id
  ownerAgentId = await withPrivilegedDb(orgId, "sales-split-agent", (tx) =>
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
  tool(APP, "company", ["id", "name"], { id: "co-1", name: "Corail Paysages" })
  tool(APP, "deal", [], { id: "deal-1" })
  tool("mail", "reply", [], { sent: true })
  routineId = await makeRoutine()
  EARLIER.enable.entityId = routineId
  startedAt = new Date(Date.now() - 60_000).toISOString()
  const conversationId = await personalAgentDmId(orgId, userId)
  await withPrivilegedDb(orgId, "sales-split-tour", (tx) =>
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
  await standOn("researching", EARLIER)
})

afterAll(async () => {
  enqueueSpy.mockRestore()
  toolRegistry.deleteByPrefix([orgId])
  await clearRedisPatterns(["routine-lock:*"])
  await releaseTestLock()
})

describe("studio sales tour: a run that sends its reply as a request of its own", () => {
  it("rings the lone reply's row, and Approve once arrives on its approval", async () => {
    let seq = await outboxSeq()
    // The run's first turn: the company and the deal, chained, then it pauses.
    let head = ""
    let deal = ""
    const tick = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        head = await gated(input.threadId, `${APP}:company`, { name: "Corail Paysages" })
        deal = await gated(input.threadId, `${APP}:deal`, { companyId: `@ref:${head}:id` })
        await agentReply(input.threadId, "The reply goes out after those are approved.")
        return { turnsAdded: 1 }
      },
    })
    expect(tick.status).toBe("waiting_approval")
    seq = await deliverSince(seq)
    expect((await tourRow()).beat_states.researching).toBeUndefined()
    expect(await status()).toMatchObject({ kind: "routine-waiting", requestId: head })

    // Approved from Home (or Do it for me): the run resumes and sends the reply alone.
    await approveFromHome(head)
    const job = enqueued.filter(
      (j) => j.jobName === APPROVAL_RESULT_TURN_JOB && j.payload.approvalId === deal,
    )
    expect(job).toHaveLength(1)
    let reply = ""
    const resumed = await resumeRoutineRunOnDecision(
      job[0]?.payload as unknown as ApprovalResultTurnPayload,
      {
        loadOwnerScopes: async () => ["*"],
        checkCredits: async () => null,
        invoker: async (input) => {
          reply = await gated(input.threadId, REPLY, {
            conversationId: email,
            textBody:
              "Thank you for the brief, Corail Paysages: a proposal with its price follows.",
          })
          await agentReply(input.threadId, "Proposed the reply.")
          return { turnsAdded: 1 }
        },
      },
    )
    expect(resumed.status).toBe("waiting_approval")
    seq = await deliverSince(seq)
    expect((await tourRow()).beat_states.researching).toMatchObject({ state: "done" })

    // The request on Home is the reply alone: every step that opens or approves
    // the request rings its row, after the chained request's head.
    for (const id of ["bundle", "bundle-steps", "approve"]) {
      const tools = ringedTools(beat(id).anchor)
      expect({ id, head: tools[0] }).toEqual({ id, head: "kernel:companies_write" })
      expect({ id, reply: tools.includes(REPLY) }).toEqual({ id, reply: true })
    }
    const states = (await tourRow()).beat_states
    await standOn("approve", { ...states, bundle: "done", "bundle-steps": "done" })
    expect((await status()).kind).toBe("pending")
    const rowTool = await approveFromHome(reply)
    expect(rowTool).toBe(REPLY)
    expect(ringedTools(beat("approve").anchor)).toContain(REPLY)
    await deliverSince(seq)
    expect((await tourRow()).beat_states.approve).toMatchObject({ state: "done" })
  })

  it("a run that ends without staging the reply does not count researching as arrived", async () => {
    // Another routine: the first one's run still waits on its reply (a tick would overlap it).
    const name = `${STUDIO_PROSPECT_ROUTINE_NAME} (again)`
    routineId = await makeRoutine(name)
    EARLIER.enable.entityId = routineId
    startedAt = new Date().toISOString()
    await standOn("researching", EARLIER)
    const seq = await outboxSeq()
    const tick = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        await agentReply(input.threadId, "The reply to Margaux goes out after those are approved.")
        return { turnsAdded: 1 }
      },
    })
    expect(tick.status).toBe("succeeded")
    await deliverSince(seq)
    expect((await tourRow()).beat_states.researching).toBeUndefined()
    expect(await status()).toEqual({
      kind: "routine-incomplete",
      routineName: name,
    })
  })
})
