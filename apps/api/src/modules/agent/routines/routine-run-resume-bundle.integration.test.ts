// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine run that proposes ONE sequenced bundle (a write, then a document
// built from its result, then a reply carrying the document) waits for the
// single approval, and resumes once, after the whole cascade has finished, told
// each step's real outcome. A step that fails when it runs stops the bundle (the
// later steps never run) and the run resumes with the real error and an
// instruction to propose a corrected bundle, within the resume cap.
//
// The tick and the decision are real (runRoutineTick, executeTool in the run's
// frame, decideApproval and its cascade); only the agent's turns are stubs and
// the job queue records instead of running.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import crypto from "node:crypto"

const enqueued: Array<{ jobName: string; payload: Record<string, unknown>; jobId?: string }> = []
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (
    _app: string,
    jobName: string,
    payload: Record<string, unknown>,
    opts?: { jobId?: string },
  ) => {
    enqueued.push({ jobName, payload, jobId: opts?.jobId })
    return opts?.jobId ?? "job-id"
  },
}))
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const { eq } = await import("drizzle-orm")
const { sql } = await import("~/db")
const { withPrivilegedDb, withSystemDb } = await import("~/db/privileged")
const { messages, routineRuns, routines: routinesTbl } = await import("~/db/schema/kernel")
const { getOrCreatePersonalAgentId } = await import("~/modules/agent/directory/personal-agent")
const { MAX_ROUTINE_RUN_RESUMES, resumeRoutineRunOnDecision } = await import(
  "~/modules/agent/routines/routine-run-resume"
)
const { runRoutineTick } = await import("~/modules/agent/routines/routine-worker")
const { APPROVAL_RESULT_TURN_JOB } = await import("~/modules/approvals/approval-result-turn")
const { decideApproval } = await import("~/modules/approvals/decide")
const { approvalPayloadHash } = await import("~/modules/approvals/payload-hash")
const { toolRegistry } = await import("~/modules/apps/app-registries")
const { executeTool } = await import("~/modules/apps/execute-tool")
const { createTurnScopeAccumulator } = await import("~/modules/agent/scopes/turn-scope-accumulator")
const { currentRunContext, inheritedRunFields, runContextStore } = await import(
  "~/modules/agent/runtime/run-context"
)
const minimal = await import("~/seed/tiers/minimal")
const { createTestOrg } = await import("~/tests/helpers/org")
const { acquireTestLock, clearRedisPatterns, releaseTestLock } = await import(
  "~/tests/route-test-setup"
)

import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import type { ApprovalResultTurnPayload } from "~/modules/approvals/approval-result-turn"

let orgId: string
let userId: string
let ownerAgentId: string
let owner: UserContext

const APP = "bundle_resume_test"
/** How the quote step behaves in the current test. */
let quoteMode: "ok" | "throw" | "no_pdf" = "ok"
/** What the reply step was called with, per run of it. */
const replies: Array<Record<string, unknown>> = []
/** The write step refuses for good (a handler's `final` soft error). */
let writeFinal = false
const WRITE_ERROR = "the CRM record changed since it was proposed: read it again"
const QUOTE_ERROR = "customer has no billing address: set billing_address on the quote"

async function makeRoutine(reportThreadId: string) {
  return withPrivilegedDb(orgId, "bundle-resume-routine", async (tx) => {
    const [row] = await tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        ownerAgentId,
        name: `bundle-${crypto.randomUUID().slice(0, 8)}`,
        description: "Bundle resume test routine",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Record the lead, quote it, reply with the quote.",
        scopes: [],
        reportThreadId,
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routinesTbl.id })
    return row!
  })
}

async function agentReply(threadId: string, content: string) {
  await withPrivilegedDb(orgId, "bundle-resume-reply", (tx) =>
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

/** A gated call from one turn of the run, in the frame agent-service.ts builds for it (a turn that read nothing yet). */
async function gated(threadId: string, tool: string, params: Record<string, unknown>) {
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
    executeTool({
      toolName: `${APP}:${tool}`,
      orgId,
      actor: owner,
      params,
      threadId,
      origin: "in-app-agent",
    }),
  )
  expect(res.blocked?.approvalRequestId).toBeString()
  return res.blocked!.approvalRequestId!
}

/** The three-step bundle, proposed in one turn: write → quote (refs the write) → reply (refs the quote). */
async function proposeBundle(threadId: string, opts: { replyRefsHead?: boolean } = {}) {
  const write = await gated(threadId, "write", { name: "Acme" })
  const quote = await gated(threadId, "quote", { customer: `@ref:${write}:record_id` })
  const source = opts.replyRefsHead ? write : quote
  const reply = await gated(
    threadId,
    "reply",
    opts.replyRefsHead
      ? { body: `Recorded as @ref:${source}:record_id` }
      : {
          body: `Your quote @ref:${source}:number is attached.`,
          attachments: [`@ref:${source}:pdf_file_id`],
        },
  )
  return [write, quote, reply] as const
}

async function tick(routineId: string, opts: { replyRefsHead?: boolean } = {}) {
  let ids: readonly string[] = []
  let outputThreadId = ""
  const result = await runRoutineTick({
    orgId,
    routineId,
    scheduledAt: new Date().toISOString(),
    loadOwnerScopes: async () => ["*"],
    checkCredits: async () => null,
    agentInvoker: async (input) => {
      outputThreadId = input.threadId
      ids = await proposeBundle(input.threadId, opts)
      await agentReply(input.threadId, "Proposed the quote bundle; waiting for the approval.")
      return { turnsAdded: 1 }
    },
  })
  return { result, ids, outputThreadId }
}

async function approve(approvalId: string) {
  const [row] =
    await sql`SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${approvalId}`
  const steps = await sql`SELECT id, tool_name, current_payload FROM kernel.approval_requests
    WHERE bundle_id = (SELECT bundle_id FROM kernel.approval_requests WHERE id = ${approvalId})
      AND status = 'deferred'`
  await decideApproval({
    orgId,
    requestId: approvalId,
    actor: owner,
    decision: "approve",
    payloadHash: approvalPayloadHash(row!.tool_name as string, row!.current_payload),
    stepPayloadHashes: Object.fromEntries(
      steps.map((s) => [
        s.id as string,
        approvalPayloadHash(s.tool_name as string, s.current_payload),
      ]),
    ),
  } as never)
}

async function statuses(ids: readonly string[]) {
  const rows =
    await sql`SELECT id::text, status FROM kernel.approval_requests WHERE id = ANY(${ids as string[]}::uuid[])`
  const by = new Map(rows.map((r) => [r.id as string, r.status as string]))
  return ids.map((id) => by.get(id))
}

function decisionJobs(approvalId: string) {
  return enqueued.filter(
    (j) => j.jobName === APPROVAL_RESULT_TURN_JOB && j.payload.approvalId === approvalId,
  )
}

async function runRow(runId: string) {
  const [row] = await withSystemDb("bundle-resume-run", (db) =>
    db.select().from(routineRuns).where(eq(routineRuns.id, runId)),
  )
  return row!
}

async function resume(
  approvalId: string,
  turn: (input: { content: string; threadId: string }) => Promise<void> = async () => {},
) {
  const job = decisionJobs(approvalId).at(-1)
  expect(job).toBeDefined()
  let content = ""
  let extraRequiredScopes: string[] = []
  const result = await resumeRoutineRunOnDecision(
    job!.payload as unknown as ApprovalResultTurnPayload,
    {
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      invoker: async (input) => {
        content = input.content
        extraRequiredScopes = input.extraRequiredScopes
        await turn({ content: input.content, threadId: input.threadId })
        return { turnsAdded: 1 }
      },
    },
  )
  return { result, content, extraRequiredScopes }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  ownerAgentId = await withPrivilegedDb(orgId, "bundle-resume-agent", (tx) =>
    getOrCreatePersonalAgentId(tx, { orgId, userId }),
  )
  owner = { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: { "*": ["*"] } }
  toolRegistry.set([orgId, APP, "write"], {
    appName: APP,
    name: "write",
    description: "Write a CRM record (gated)",
    requiredScopes: [`${APP}:records:write`],
    gated: true,
    referenceableOutputs: ["record_id"],
    handler: async () =>
      writeFinal
        ? { error: { code: "record_changed", message: WRITE_ERROR, final: true } }
        : { record_id: "rec-77" },
  } as never)
  toolRegistry.set([orgId, APP, "quote"], {
    appName: APP,
    name: "quote",
    description: "Create and issue a quote (gated)",
    requiredScopes: [`${APP}:quotes:write`],
    gated: true,
    referenceableOutputs: ["number", "pdf_file_id"],
    handler: async (p: { customer: string }) => {
      if (quoteMode === "throw") throw new Error(QUOTE_ERROR)
      if (quoteMode === "no_pdf") return { number: "Q-2026-0042" }
      return { number: "Q-2026-0042", pdf_file_id: `pdf-for-${p.customer}` }
    },
  } as never)
  toolRegistry.set([orgId, APP, "reply"], {
    appName: APP,
    name: "reply",
    description: "Reply to the customer (gated)",
    requiredScopes: [`${APP}:mail:send`],
    gated: true,
    handler: async (p: Record<string, unknown>) => {
      replies.push(p)
      return { sent: true }
    },
  } as never)
})

afterAll(async () => {
  toolRegistry.deleteByPrefix([orgId])
  await clearRedisPatterns(["routine-lock:*"])
  await releaseTestLock()
})

describe("a routine run's sequenced bundle", () => {
  it("pauses on the whole bundle and resumes once, after the last step ran, with every result", async () => {
    quoteMode = "ok"
    replies.length = 0
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, ids } = await tick(routine.id)
    expect(result.status).toBe("waiting_approval")
    const runId = result.runId!
    expect(await statuses(ids)).toEqual(["pending", "deferred", "deferred"])
    // The deferred steps are waited on too.
    expect((await runRow(runId)).pauseState?.approvalIds).toEqual([...ids])

    await approve(ids[0])
    expect(await statuses(ids)).toEqual(["approved", "approved", "approved"])
    // The refs resolved between the steps.
    expect(replies).toEqual([
      { body: "Your quote Q-2026-0042 is attached.", attachments: ["pdf-for-rec-77"] },
    ])
    // Only the step that completed the bundle hands the run its decision.
    expect(decisionJobs(ids[0])).toHaveLength(0)
    expect(decisionJobs(ids[1])).toHaveLength(0)
    expect(decisionJobs(ids[2])).toHaveLength(1)

    const resumed = await resume(ids[2], async ({ threadId }) => {
      await agentReply(threadId, "Lead recorded, quote Q-2026-0042 sent.")
    })
    expect(resumed.result.status).toBe("succeeded")
    expect(resumed.content).toContain("Q-2026-0042")
    expect(resumed.content).toContain("rec-77")
    expect(resumed.content).not.toContain("FAILED")
    expect((await runRow(runId)).status).toBe("succeeded")
    // Once: the same job again does nothing.
    expect((await resume(ids[2])).result.status).toBe("no_run")
  })

  it("a bundle whose later steps all refer to the head resumes only after its last step", async () => {
    quoteMode = "ok"
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, ids } = await tick(routine.id, { replyRefsHead: true })
    await approve(ids[0])
    expect(await statuses(ids)).toEqual(["approved", "approved", "approved"])
    // The quote step depends on the head, not on anything after it: it must not
    // hand the turn back while the reply still waits behind it.
    expect(decisionJobs(ids[1])).toHaveLength(0)
    expect(decisionJobs(ids[2])).toHaveLength(1)
    const resumed = await resume(ids[2], async ({ threadId }) => {
      await agentReply(threadId, "Done.")
    })
    expect(resumed.result.status).toBe("succeeded")
    expect((await runRow(result.runId!)).status).toBe("succeeded")
  })

  it("a step that fails when it runs stops the bundle; the run resumes with the real error and proposes a corrected one", async () => {
    quoteMode = "throw"
    replies.length = 0
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, ids } = await tick(routine.id)
    const runId = result.runId!

    await approve(ids[0])
    // The write ran; the quote failed; the reply never ran.
    expect(await statuses(ids)).toEqual(["approved", "cancelled", "cancelled"])
    expect(replies).toHaveLength(0)
    expect(decisionJobs(ids[1])).toHaveLength(1)

    quoteMode = "ok"
    let corrected: readonly string[] = []
    const resumed = await resume(ids[1], async ({ threadId }) => {
      corrected = await proposeBundle(threadId)
      await agentReply(threadId, "Proposed a corrected quote bundle.")
    })
    expect(resumed.content).toContain(QUOTE_ERROR)
    expect(resumed.content).toContain(`${APP}:quote`)
    expect(resumed.content).toContain("FAILED")
    expect(resumed.content).toContain("NOT RUN")
    expect(resumed.content).toContain("propose a corrected")
    expect(resumed.content).toContain("rec-77")
    expect(resumed.content).not.toContain("last part")
    // The resume is read under what the steps' own result notices demand (the
    // proposing turn's scopes plus what each tool reads), not the failure
    // notices' fail-closed stamp of the owner's whole scope set ("*"), which a
    // run narrowed to its routine's scope cannot read: it would resume blind.
    expect(resumed.extraRequiredScopes).not.toContain("*")
    expect(resumed.extraRequiredScopes).toEqual(
      expect.arrayContaining([`${APP}:records:write`, `${APP}:quotes:write`, `${APP}:mail:send`]),
    )
    // The corrected bundle is waited on, in the same run.
    expect(resumed.result.status).toBe("waiting_approval")
    const waiting = await runRow(runId)
    expect(waiting.status).toBe("waiting_approval")
    expect(waiting.pauseState?.approvalIds).toEqual([...corrected])

    await approve(corrected[0]!)
    expect(replies).toHaveLength(1)
    const done = await resume(corrected[2]!, async ({ threadId }) => {
      await agentReply(threadId, "Quote sent after the fix.")
    })
    expect(done.result.status).toBe("succeeded")
    expect((await runRow(runId)).status).toBe("succeeded")
  })

  it("an unresolvable ref names the keys the referenced step returns and declares", async () => {
    quoteMode = "no_pdf"
    replies.length = 0
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { ids } = await tick(routine.id)
    await approve(ids[0])
    expect(await statuses(ids)).toEqual(["approved", "approved", "cancelled"])
    expect(replies).toHaveLength(0)
    const resumed = await resume(ids[2], async ({ threadId }) => {
      await agentReply(threadId, "Will fix the reference.")
    })
    expect(resumed.content).toContain('missing output "pdf_file_id"')
    expect(resumed.content).toContain('that step returned "number"')
    expect(resumed.content).toContain("number, pdf_file_id")
    expect(resumed.content).toContain("Q-2026-0042")
  })

  it("a head that fails for good closes the bundle and resumes the run with its error", async () => {
    writeFinal = true
    replies.length = 0
    try {
      const conversation = await minimal.thread(orgId, userId)
      const routine = await makeRoutine(conversation)
      const { result, ids } = await tick(routine.id)
      await expect(approve(ids[0])).rejects.toThrow()
      expect(await statuses(ids)).toEqual(["cancelled", "cancelled", "cancelled"])
      expect(replies).toHaveLength(0)
      // Woken at once, not after the sweep's delay.
      expect(decisionJobs(ids[0])).toHaveLength(1)
      const resumed = await resume(ids[0], async ({ threadId }) => {
        await agentReply(threadId, "Will re-read the record and propose again.")
      })
      expect(resumed.content).toContain(WRITE_ERROR)
      expect(resumed.content).toContain("propose a corrected")
      expect(resumed.content).not.toContain("last part")
      expect((await runRow(result.runId!)).status).toBe("succeeded")
    } finally {
      writeFinal = false
    }
  })

  it("a lone call that fails for good resumes the run with its error, not as a refusal", async () => {
    writeFinal = true
    try {
      const conversation = await minimal.thread(orgId, userId)
      const routine = await makeRoutine(conversation)
      let id = ""
      const { result } = await runRoutineTick({
        orgId,
        routineId: routine.id,
        scheduledAt: new Date().toISOString(),
        loadOwnerScopes: async () => ["*"],
        checkCredits: async () => null,
        agentInvoker: async (input) => {
          id = await gated(input.threadId, "write", { name: "Solo" })
          await agentReply(input.threadId, "Waiting for the write.")
          return { turnsAdded: 1 }
        },
      }).then((r) => ({ result: r }))
      expect(result.status).toBe("waiting_approval")
      await expect(approve(id)).rejects.toThrow()
      expect(decisionJobs(id)).toHaveLength(1)
      const resumed = await resume(id, async ({ threadId }) => {
        await agentReply(threadId, "Done.")
      })
      expect(resumed.content).toContain(WRITE_ERROR)
      expect(resumed.content).toContain("propose a corrected")
      expect(resumed.content).not.toContain("did NOT run")
      expect(resumed.content).not.toContain("last part")
    } finally {
      writeFinal = false
    }
  })

  it("at the resume cap, the run is told it cannot propose a corrected bundle", async () => {
    quoteMode = "throw"
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, ids } = await tick(routine.id)
    const runId = result.runId!
    // As if the run had already waited (and resumed) up to one below the cap.
    await sql`UPDATE kernel.routine_runs
      SET pause_state = pause_state || jsonb_build_object('resumeCount', ${MAX_ROUTINE_RUN_RESUMES - 1}::int)
      WHERE id = ${runId}`
    await approve(ids[0])
    const resumed = await resume(ids[1], async ({ threadId }) => {
      await agentReply(threadId, "The quote failed; a person must redo it.")
    })
    expect(resumed.content).toContain(QUOTE_ERROR)
    expect(resumed.content).toContain(`${MAX_ROUTINE_RUN_RESUMES} times`)
    expect(resumed.content).toContain("last part")
    expect(resumed.result.status).toBe("succeeded")
    expect((await runRow(runId)).status).toBe("succeeded")
  })
})
