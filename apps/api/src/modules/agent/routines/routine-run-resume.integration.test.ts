// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine run that hits a held call waits for the decision, then carries on
// with the call's real result, in the same run, and reports once at the end.
//
// Live, a routine whose web fetch was gated ended its run with "pending your
// approval"; the fetch ran when approved and its page landed in the output
// thread with nobody to read it, so the CRM record it was for was never filled
// in. Here a real tick runs through `runRoutineTick` (the agent is a stub that
// makes the gated call through the real executeTool inside the tick's frame and
// writes its reply, as a turn does), the approval is decided through
// decideApproval (which runs the real handler and enqueues the same
// approval-result-turn job a chat agent's approval takes), and that job's
// routine branch, `resumeRoutineRunOnDecision`, resumes the run.
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

const { and, asc, eq } = await import("drizzle-orm")
const { sql } = await import("~/db")
const { withPrivilegedDb, withSystemDb } = await import("~/db/privileged")
const { messages, routineRuns, routines: routinesTbl } = await import("~/db/schema/kernel")
const { getOrCreatePersonalAgentId } = await import("~/modules/agent/directory/personal-agent")
const { resumeRoutineRunOnDecision, sweepWaitingRoutineRuns } = await import(
  "~/modules/agent/routines/routine-run-resume"
)
const { finishRun, RoutineLockTestAccess, routineRunScopes, runRoutineTick } = await import(
  "~/modules/agent/routines/routine-worker"
)
const { APPROVAL_RESULT_TURN_JOB } = await import("~/modules/approvals/approval-result-turn")
const { redis } = await import("~/lib/redis")
const { decideApproval } = await import("~/modules/approvals/decide")
const { withdrawApproval } = await import("~/modules/approvals/withdraw")
const { approvalPayloadHash } = await import("~/modules/approvals/payload-hash")
const { toolRegistry } = await import("~/modules/apps/app-registries")
const { executeTool } = await import("~/modules/apps/execute-tool")
const { createTurnScopeAccumulator } = await import("~/modules/agent/scopes/turn-scope-accumulator")
const { currentRunContext, inheritedRunFields, runContextStore } = await import(
  "~/modules/agent/runtime/run-context"
)
const { recordStepTokens } = await import("~/modules/agent/runtime/run-token-limit")
const { setTaintFlag, taintThreadForTriggerEvent } = await import("~/modules/agent/scopes/taint")
const { WebToolsTestAccess } = await import("~/modules/agent/tools/web-tools")
const { isMessageVisible } = await import("~/services/security/visibility")
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

const APP = "resume_test"
const PAGE = (url: string) => `Page of ${url}: Acme Corp, 42 employees, ceo Jane Roe`
const SENDER_DOMAIN = "northwind-acoustics.example"
const SENDER_ROOT = `https://${SENDER_DOMAIN}/`
const webFetched: string[] = []

/**
 * A web_fetch from one turn of the run, in the frame agent-service.ts builds for it: what the run
 * frame hands every turn (inheritedRunFields), and a turn that has already read org data. A web
 * read never parks (scope-taint.ts, rule 9), whatever the turn read.
 */
async function turnWebFetch(url: string, threadId: string) {
  const turnScopeAccumulator = createTurnScopeAccumulator({ orgId })
  turnScopeAccumulator.markInternalRead()
  const frame: RunContext = {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    background: true,
    humanTurn: false,
    turnScopeAccumulator,
    // agent-service.ts stamps the routine on a routine turn's frame (params.routineId).
    routineId: currentRunContext()?.routineId,
    ...inheritedRunFields(currentRunContext()),
  }
  return runContextStore.run(frame, () =>
    executeTool({
      toolName: "kernel:web_fetch",
      orgId,
      actor: owner,
      params: { url },
      threadId,
      origin: "in-app-agent",
    }),
  )
}

async function makeRoutine(reportThreadId: string, scopes: string[] = []) {
  const name = `resume-${crypto.randomUUID().slice(0, 8)}`
  return withPrivilegedDb(orgId, "resume-seed-routine", async (tx) => {
    const [row] = await tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        ownerAgentId,
        name,
        description: "Resume test routine",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Fetch the customer's site, then fill in the CRM record.",
        scopes,
        reportThreadId,
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routinesTbl.id, name: routinesTbl.name })
    return row!
  })
}

async function agentReply(threadId: string, content: string) {
  await withPrivilegedDb(orgId, "resume-seed-reply", (tx) =>
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

/** The agent's gated call, made inside the run's frame as a turn makes it. */
async function gatedFetch(threadId: string, url: string): Promise<string> {
  const res = await executeTool({
    toolName: `${APP}:fetch`,
    orgId,
    actor: owner,
    params: { url },
    threadId,
    origin: "in-app-agent",
  })
  expect(res.blocked?.approvalRequestId).toBeString()
  return res.blocked!.approvalRequestId!
}

/** A tick whose turn makes `urls.length` gated calls, then says it waits. */
async function tickWithGates(routineId: string, urls: string[]) {
  const approvalIds: string[] = []
  let outputThreadId = ""
  const result = await runRoutineTick({
    orgId,
    routineId,
    scheduledAt: new Date().toISOString(),
    loadOwnerScopes: async () => ["*"],
    checkCredits: async () => null,
    agentInvoker: async (input) => {
      outputThreadId = input.threadId
      for (const url of urls) approvalIds.push(await gatedFetch(input.threadId, url))
      await agentReply(input.threadId, "Fetching the site; waiting for the approval.")
      return { turnsAdded: 1 }
    },
  })
  return { result, approvalIds, outputThreadId }
}

async function decide(approvalId: string, decision: "approve" | "deny") {
  const [row] =
    await sql`SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${approvalId}`
  await decideApproval({
    orgId,
    requestId: approvalId,
    actor: owner,
    decision,
    ...(decision === "approve"
      ? { payloadHash: approvalPayloadHash(row!.tool_name as string, row!.current_payload) }
      : {}),
  } as never)
}

async function runRow(runId: string) {
  const [row] = await withSystemDb("resume-read-run", (db) =>
    db.select().from(routineRuns).where(eq(routineRuns.id, runId)),
  )
  return row!
}

async function threadRows(threadId: string) {
  return withSystemDb("resume-read-thread", (db) =>
    db
      .select({ content: messages.content, metadata: messages.metadata })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.orgId, orgId)))
      .orderBy(asc(messages.createdAt)),
  )
}

async function reportsIn(threadId: string) {
  return (await threadRows(threadId)).filter(
    (m) => (m.metadata as { routineReport?: unknown } | null)?.routineReport,
  )
}

async function runLines(threadId: string) {
  return (await threadRows(threadId)).flatMap((m) => {
    const run = (m.metadata as { routineRun?: { status: string } } | null)?.routineRun
    return run ? [run.status] : []
  })
}

/** The decision jobs enqueued for an approval (approval-result-turn.ts). */
function decisionJobs(approvalId: string) {
  return enqueued.filter(
    (j) => j.jobName === APPROVAL_RESULT_TURN_JOB && j.payload.approvalId === approvalId,
  )
}

/** Run the decision job of `approvalId` (its last enqueued one), with a stub turn. */
async function resume(
  approvalId: string,
  turn: (input: { content: string; threadId: string }) => Promise<void> = async () => {},
  opts: { ownerScopes?: string[] } = {},
) {
  const job = decisionJobs(approvalId).at(-1)
  expect(job).toBeDefined()
  expect(job!.payload.routineId).toBeString()
  let content = ""
  const result = await resumeRoutineRunOnDecision(
    job!.payload as unknown as ApprovalResultTurnPayload,
    {
      loadOwnerScopes: async () => opts.ownerScopes ?? ["*"],
      checkCredits: async () => null,
      invoker: async (input) => {
        content = input.content
        await turn({ content: input.content, threadId: input.threadId })
        return { turnsAdded: 1 }
      },
    },
  )
  return { result, content }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  ownerAgentId = await withPrivilegedDb(orgId, "resume-seed-agent", (tx) =>
    getOrCreatePersonalAgentId(tx, { orgId, userId }),
  )
  owner = { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: { "*": ["*"] } }
  toolRegistry.set([orgId, APP, "fetch"], {
    appName: APP,
    name: "fetch",
    description: "Fetch a page (gated)",
    requiredScopes: [`${APP}:pages:read`],
    gated: true,
    // A read: what it returns is what the run waits for.
    readOnly: true,
    handler: async (params: { url: string }) => ({ text: PAGE(params.url) }),
  } as never)
  WebToolsTestAccess.setWebFetchMockHosts((host) => host.endsWith(".example"))
  WebToolsTestAccess.setWebFetch((async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    webFetched.push(url)
    return new Response("<html><head><title>Northwind</title></head><body>Panels.</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })
  }) as typeof fetch)
  const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
  await registerKernelAgentTools(orgId)
})

afterAll(async () => {
  WebToolsTestAccess.setWebFetchMockHosts(null)
  WebToolsTestAccess.setWebFetch(null)
  toolRegistry.deleteByPrefix([orgId])
  await clearRedisPatterns(["routine-lock:*"])
  await releaseTestLock()
})

describe("a routine run waits for its held call and resumes with the result", () => {
  it("pauses on the gated call, resumes through the approval's own job, and reports once", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)

    const { result, approvalIds, outputThreadId } = await tickWithGates(routine.id, [
      "https://acme.example",
    ])
    expect(result.status).toBe("waiting_approval")
    const runId = result.runId!
    const paused = await runRow(runId)
    expect(paused.status).toBe("waiting_approval")
    expect(paused.pauseState?.approvalIds).toEqual(approvalIds)
    expect(await runLines(conversation)).toEqual(["waiting_approval"])
    expect(await reportsIn(conversation)).toHaveLength(0)
    const [r] = await withSystemDb("resume-read-routine", (db) =>
      db
        .select({ lastRunStatus: routinesTbl.lastRunStatus })
        .from(routinesTbl)
        .where(eq(routinesTbl.id, routine.id)),
    )
    expect(r!.lastRunStatus).toBe("waiting_approval")

    await decide(approvalIds[0]!, "approve")
    // The approval took the job a chat agent's approval takes, keyed to it.
    const jobs = decisionJobs(approvalIds[0]!)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.jobId).toBe(`${APPROVAL_RESULT_TURN_JOB}:${approvalIds[0]}`)

    const resumed = await resume(approvalIds[0]!, async ({ threadId }) => {
      expect(threadId).toBe(outputThreadId)
      await agentReply(threadId, "CRM record filled in: Acme Corp, 42 employees.")
    })
    expect(resumed.content).toContain(PAGE("https://acme.example"))
    expect(resumed.content).toContain("untrusted tool output")
    expect(resumed.content).toContain("Fetching the site; waiting for the approval.")
    expect(resumed.result.status).toBe("succeeded")

    const ended = await runRow(runId)
    expect(ended.status).toBe("succeeded")
    expect(ended.turnsAdded).toBe(2)
    expect(await runLines(conversation)).toEqual(["succeeded"])
    const reports = await reportsIn(conversation)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.content).toBe("CRM record filled in: Acme Corp, 42 employees.")

    // The same job again (a retry, a replay) does nothing: the per-approval claim.
    const again = await resume(approvalIds[0]!)
    expect(again.result.status).toBe("no_run")
    expect(await reportsIn(conversation)).toHaveLength(1)
  })

  it("a denied call resumes the run once, told it did not run, and the run ends", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, approvalIds } = await tickWithGates(routine.id, ["https://denied.example"])
    expect(result.status).toBe("waiting_approval")
    const runId = result.runId!

    await decide(approvalIds[0]!, "deny")
    // A denial takes the same job, for a routine run's approval.
    expect(decisionJobs(approvalIds[0]!)).toHaveLength(1)

    const resumed = await resume(approvalIds[0]!, async ({ threadId }) => {
      // Even a new gated call here does not pause the run again: no retry loop.
      await gatedFetch(threadId, "https://denied.example/again")
      await agentReply(threadId, "Could not read the site: the fetch was refused.")
    })
    expect(resumed.content).toContain("did NOT run")
    expect(resumed.content).toContain("last part")
    expect(resumed.content).not.toContain(PAGE("https://denied.example"))
    expect(resumed.result.status).toBe("succeeded")
    expect((await runRow(runId)).status).toBe("succeeded")
    const reports = await reportsIn(conversation)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.content).toBe("Could not read the site: the fetch was refused.")
  })

  it("two gated calls in one turn: only the last decision resumes, once", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, approvalIds } = await tickWithGates(routine.id, [
      "https://one.example",
      "https://two.example",
    ])
    const runId = result.runId!
    expect((await runRow(runId)).pauseState?.approvalIds).toHaveLength(2)

    await decide(approvalIds[0]!, "approve")
    const first = await resume(approvalIds[0]!)
    expect(first.result.status).toBe("no_run")
    expect((await runRow(runId)).status).toBe("waiting_approval")

    await decide(approvalIds[1]!, "approve")
    const second = await resume(approvalIds[1]!, async ({ threadId }) => {
      await agentReply(threadId, "Both pages read; CRM updated.")
    })
    expect(second.content).toContain(PAGE("https://one.example"))
    expect(second.content).toContain(PAGE("https://two.example"))
    expect(second.result.status).toBe("succeeded")
    expect(await reportsIn(conversation)).toHaveLength(1)
  })

  it("a resumed turn that hits another gate waits again; a late job for the first approval never resumes it twice", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, approvalIds } = await tickWithGates(routine.id, ["https://first.example"])
    const runId = result.runId!
    await decide(approvalIds[0]!, "approve")

    let second = ""
    const first = await resume(approvalIds[0]!, async ({ threadId }) => {
      second = await gatedFetch(threadId, "https://second.example")
      await agentReply(threadId, "Now fetching the second page.")
    })
    expect(first.result.status).toBe("waiting_approval")
    const waiting = await runRow(runId)
    expect(waiting.pauseState?.approvalIds).toEqual([second])
    expect(waiting.pauseState?.resumeCount).toBe(1)
    expect(await runLines(conversation)).toEqual(["waiting_approval"])

    // A replayed job for the first approval, while the run waits on the second.
    const late = await resume(approvalIds[0]!)
    expect(late.result.status).toBe("no_run")
    expect((await runRow(runId)).pauseState?.approvalIds).toEqual([second])
    expect(await reportsIn(conversation)).toHaveLength(0)

    await decide(second, "approve")
    const done = await resume(second, async ({ threadId }) => {
      await agentReply(threadId, "Both pages used.")
    })
    expect(done.content).toContain(PAGE("https://second.example"))
    expect(done.content).not.toContain(PAGE("https://first.example"))
    expect(done.result.status).toBe("succeeded")
    expect(await reportsIn(conversation)).toHaveLength(1)
  })

  it("an owner who lost a scope meanwhile: the run does not resume, ends failed, the routine pauses", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation, [`${APP}:pages:read`])
    const { result, approvalIds } = await tickWithGates(routine.id, ["https://scope.example"])
    const runId = result.runId!
    expect(result.status).toBe("waiting_approval")
    await decide(approvalIds[0]!, "approve")
    let turned = false
    const res = await resume(
      approvalIds[0]!,
      async () => {
        turned = true
      },
      { ownerScopes: [] },
    )
    expect(turned).toBe(false)
    expect(res.result.status).toBe("failed")
    const ended = await runRow(runId)
    expect(ended.status).toBe("failed")
    expect(ended.error).toContain(`${APP}:pages:read`)
    const [r] = await withSystemDb("resume-read-routine", (db) =>
      db
        .select({ status: routinesTbl.status })
        .from(routinesTbl)
        .where(eq(routinesTbl.id, routine.id)),
    )
    expect(r!.status).toBe("paused_scope_mismatch")
    expect(await reportsIn(conversation)).toHaveLength(0)
  })

  it("the resume keeps the routine lock alive while its turn runs", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { approvalIds } = await tickWithGates(routine.id, ["https://lock.example"])
    await decide(approvalIds[0]!, "approve")
    const before = RoutineLockTestAccess.heartbeatMs
    RoutineLockTestAccess.heartbeatMs = 40
    try {
      let ttl = -1
      await resume(approvalIds[0]!, async () => {
        const key = `routine-lock:${routine.id}`
        await redis.expire(key, 2)
        await new Promise((r) => setTimeout(r, 250))
        ttl = await redis.ttl(key)
      })
      expect(ttl).toBeGreaterThan(60)
    } finally {
      RoutineLockTestAccess.heartbeatMs = before
    }
  })

  it("an approved call that failed when it ran is said to have run and failed", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { approvalIds } = await tickWithGates(routine.id, ["https://broken.example"])
    await decide(approvalIds[0]!, "approve")
    // Its execution record says the call failed (as a handler that threw leaves it).
    await sql`UPDATE kernel.approved_handler_executions SET status = 'failed_no_effect'
      WHERE approval_request_id = ${approvalIds[0]!}`
    const res = await resume(approvalIds[0]!, async ({ threadId }) => {
      await agentReply(threadId, "The fetch failed.")
    })
    expect(res.content).toContain("FAILED")
    expect(res.content).not.toContain("did NOT run")
    expect(res.result.status).toBe("succeeded")
  })

  it("the sweep resumes a run whose decision job was lost, and ends a run whose resume died", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, approvalIds } = await tickWithGates(routine.id, ["https://lost.example"])
    const runId = result.runId!
    await decide(approvalIds[0]!, "approve")
    // Its job was lost (a restart): the run sat waiting with everything decided.
    enqueued.splice(0, enqueued.length)
    await sql`UPDATE kernel.routine_runs SET ran_at = now() - interval '20 minutes' WHERE id = ${runId}`
    const swept = await sweepWaitingRoutineRuns()
    expect(swept.resumed).toBeGreaterThanOrEqual(1)
    const rerun = decisionJobs(approvalIds[0]!)
    expect(rerun).toHaveLength(1)
    expect(rerun[0]!.payload.rerun).toBe(true)
    const res = await resume(approvalIds[0]!, async ({ threadId }) => {
      await agentReply(threadId, "Picked up after the restart.")
    })
    expect(res.result.status).toBe("succeeded")
    expect(await reportsIn(conversation)).toHaveLength(1)

    // A resume that claimed a run and died: the sweep ends the run.
    const other = await tickWithGates(routine.id, ["https://dead.example"])
    const deadRun = other.result.runId!
    await sql`UPDATE kernel.routine_runs
        SET pause_state = pause_state || jsonb_build_object('resumingAt', (now() - interval '1 hour')::text)
      WHERE id = ${deadRun}`
    const sweptDead = await sweepWaitingRoutineRuns()
    expect(sweptDead.ended).toBeGreaterThanOrEqual(1)
    const dead = await runRow(deadRun)
    expect(dead.status).toBe("failed")
    expect(dead.error).toContain("did not finish")
  })

  it("a scheduled tick while a run of the routine waits is skipped, not a second waiting run", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const first = await tickWithGates(routine.id, ["https://busy.example"])
    expect(first.result.status).toBe("waiting_approval")
    const second = await tickWithGates(routine.id, ["https://busy.example/2"])
    expect(second.result.status).toBe("skipped_overlap")
    expect(second.approvalIds).toHaveLength(0)
    expect((await runRow(second.result.runId!)).error).toContain("waiting for an approval")
  })

  it("a run ends once: a second ender (the sweep after a resume) changes nothing, one summary", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, approvalIds, outputThreadId } = await tickWithGates(routine.id, [
      "https://race.example",
    ])
    const runId = result.runId!
    await decide(approvalIds[0]!, "approve")
    await resume(approvalIds[0]!, async ({ threadId }) => {
      await agentReply(threadId, "Done before the sweep.")
    })
    expect((await runRow(runId)).status).toBe("succeeded")
    // What the sweep's ender does with the run as it read it before the resume ended it.
    const [row] = await withSystemDb("resume-read-routine-row", (db) =>
      db.select().from(routinesTbl).where(eq(routinesTbl.id, routine.id)),
    )
    const late = await finishRun({
      orgId,
      routine: row!,
      outputThreadId,
      recreated: false,
      startedAt: Date.now() - 60_000,
      runLineId: null,
      ownerScopes: [],
      agentError: "The run stopped while it carried on after an approval, and did not finish.",
      turnsAdded: 1,
      trigger: "schedule",
      eventEntityId: null,
      runId,
    })
    expect(late.status).toBe("no_run")
    const ended = await runRow(runId)
    expect(ended.status).toBe("succeeded")
    expect(ended.error).toBeNull()
    expect(await reportsIn(conversation)).toHaveLength(1)
  })

  it("a withdrawn call resumes the run at once, through the same job", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const { result, approvalIds } = await tickWithGates(routine.id, ["https://withdrawn.example"])
    expect(result.status).toBe("waiting_approval")
    await withdrawApproval({ orgId, requestId: approvalIds[0]!, actor: owner })
    expect(decisionJobs(approvalIds[0]!)).toHaveLength(1)
    const res = await resume(approvalIds[0]!, async ({ threadId }) => {
      await agentReply(threadId, "The fetch was withdrawn.")
    })
    expect(res.content).toContain("did NOT run")
    expect(res.result.status).toBe("succeeded")
  })

  it("a routine granted kernel:threads:write but not :read can read its own resume message", async () => {
    // Live: the routine's grant held `kernel:threads:write` and not `kernel:threads:read`. Its tick
    // prompt is stamped with its scopes; rule 5 classified that as `kernel:threads:read`, the
    // approval's result row and the resume message quoting it carried it, and the resumed turn,
    // which could not read that scope, saw no task at all. The routine now runs with the read
    // sibling of its write scope (its owner holds it), so it reads what it caused.
    const conversation = await minimal.thread(orgId, userId)
    const grant = ["kernel:threads:write", `${APP}:pages:read`]
    const routine = await makeRoutine(conversation, grant)
    const approvalIds: string[] = []
    let turnScopes: string[] = []
    const result = await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        turnScopes = input.scopes
        // The turn's frame: it reads its own prompt (stamped with its scopes) as instructions.
        const acc = createTurnScopeAccumulator({ orgId })
        acc.recordInstructions(input.scopes)
        const res = await executeTool({
          toolName: `${APP}:fetch`,
          orgId,
          actor: { ...owner, scopes: input.scopes },
          params: { url: "https://grant.example" },
          threadId: input.threadId,
          origin: "in-app-agent",
          turnTaintScopes: acc.snapshot(),
        } as never)
        approvalIds.push(res.blocked!.approvalRequestId!)
        await agentReply(input.threadId, "Fetching the site; waiting for the approval.")
        return { turnsAdded: 1 }
      },
    })
    expect(result.status).toBe("waiting_approval")
    expect([...turnScopes].sort()).toEqual([...grant, "kernel:threads:read"].sort())
    await decide(approvalIds[0]!, "approve")

    let resumeScopes: string[] = []
    let stamp: string[] = []
    const job = decisionJobs(approvalIds[0]!).at(-1)!
    const resumed = await resumeRoutineRunOnDecision(
      job.payload as unknown as ApprovalResultTurnPayload,
      {
        loadOwnerScopes: async () => ["*"],
        checkCredits: async () => null,
        invoker: async (input) => {
          resumeScopes = input.scopes
          // What the resume message is stamped with (defaultResumeInvoker).
          stamp = [...new Set([...input.scopes, ...input.extraRequiredScopes])]
          expect(input.content).toContain(PAGE("https://grant.example"))
          return { turnsAdded: 1 }
        },
      },
    )
    expect(resumed.status).toBe("succeeded")
    expect([...resumeScopes].sort()).toEqual([...turnScopes].sort())
    // The result row the resume quotes, and the resume message itself, are readable by the turn.
    const viewer = { userId, grants: resumeScopes }
    const [resultRow] = await sql`
      SELECT required_scopes FROM kernel.messages
       WHERE org_id = ${orgId} AND metadata->>'type' = 'approval-result'
         AND metadata->>'requestId' = ${approvalIds[0]!}`
    expect(resultRow).toBeDefined()
    const resultScopes = resultRow!.required_scopes as string[]
    expect(resultScopes).toContain("kernel:threads:read")
    expect(isMessageVisible({ requiredScopes: resultScopes, disclosureList: null }, viewer)).toBe(
      true,
    )
    expect(isMessageVisible({ requiredScopes: stamp, disclosureList: null }, viewer)).toBe(true)
  })

  it("a routine never gains a read its owner lacks", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const grant = ["kernel:threads:write", `${APP}:pages:read`]
    const routine = await makeRoutine(conversation, grant)
    let turnScopes: string[] = []
    const result = await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      // The owner may write threads but not read them.
      loadOwnerScopes: async () => [...grant],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        turnScopes = input.scopes
        await agentReply(input.threadId, "Done.")
        return { turnsAdded: 1 }
      },
    })
    expect(result.status).toBe("succeeded")
    expect([...turnScopes].sort()).toEqual([...grant].sort())
    expect(routineRunScopes(["kernel:threads:write"], ["kernel:*"])).toEqual([
      "kernel:threads:write",
      "kernel:threads:read",
    ])
    // Only a `:write` scope's own `:read` sibling, never another verb's.
    expect(routineRunScopes(["kernel:threads:close"], ["*"])).toEqual(["kernel:threads:close"])
    expect(routineRunScopes(["kernel:threads:write"], ["kernel:threads:write"])).toEqual([
      "kernel:threads:write",
    ])
  })

  it("a run started by an outside email reads the web without waiting, before and after a resume", async () => {
    // Live: the run paused for its CRM approval, resumed, read the sender's site again, and the
    // fetch was held, so the run stalled. A web read never parks now (rule 9), on the tick's turn
    // and on the resume's alike, while the run's token account carries across the pause.
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    // A hard limit: what the run spent before the pause still counts after it.
    await sql`UPDATE kernel.routines SET hard_token_limit = 100000 WHERE id = ${routine.id}`
    const mail = {
      app: "mail",
      entity: "message",
      action: "create",
      entityId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
      origin: "external" as const,
      data: { direction: "inbound", from: { email: `ines@${SENDER_DOMAIN}` } },
    }
    const approvalIds: string[] = []
    let tickAccountId = ""
    const result = await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      triggerEvent: mail,
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        // As the production invoker does: the outside email marks the tick's thread.
        await taintThreadForTriggerEvent(input.threadId, orgId, input.triggerEvent)
        const first = await turnWebFetch(SENDER_ROOT, input.threadId)
        expect(first.blocked).toBeUndefined()
        const account = currentRunContext()!.tokenAccount!
        tickAccountId = account.id
        await recordStepTokens(account, 700)
        approvalIds.push(await gatedFetch(input.threadId, "https://crm.example"))
        await agentReply(input.threadId, "Proposed the CRM record; waiting for the approval.")
        return { turnsAdded: 1 }
      },
    })
    expect(result.status).toBe("waiting_approval")
    expect(webFetched).toEqual([SENDER_ROOT])
    const paused = await runRow(result.runId!)
    expect(paused.pauseState?.triggerEventId).toBe(mail.eventId)

    await decide(approvalIds[0]!, "approve")
    let again: Awaited<ReturnType<typeof turnWebFetch>> | undefined
    let other: Awaited<ReturnType<typeof turnWebFetch>> | undefined
    let resumedAccount: { id: string; used: number } | undefined
    const resumed = await resume(approvalIds[0]!, async ({ threadId }) => {
      const account = currentRunContext()?.tokenAccount
      resumedAccount = account ? { id: account.id, used: account.used } : undefined
      again = await turnWebFetch(SENDER_ROOT, threadId)
      // Any other address runs too: a read is never held, the guardrails bound it instead.
      other = await turnWebFetch(`https://${SENDER_DOMAIN}/pricing`, threadId)
      await agentReply(threadId, "Read the site again; the reply is drafted.")
    })
    expect(again?.blocked).toBeUndefined()
    expect(other?.blocked).toBeUndefined()
    expect(webFetched).toEqual([SENDER_ROOT, SENDER_ROOT, `https://${SENDER_DOMAIN}/pricing`])
    expect(resumedAccount).toEqual({ id: tickAccountId, used: 700 })
    // Nothing else was held: the run no longer waits.
    expect(resumed.result.status).not.toBe("waiting_approval")
  })

  it("a resumed run keeps where the outside text it read came from", async () => {
    const conversation = await minimal.thread(orgId, userId)
    const routine = await makeRoutine(conversation)
    const approvalIds: string[] = []
    const result = await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        // The only outside text the run read came from one MCP server.
        await setTaintFlag(input.threadId, orgId, { source: "mcp:crm" })
        approvalIds.push(await gatedFetch(input.threadId, "https://source.example"))
        await agentReply(input.threadId, "Waiting for the approval.")
        return { turnsAdded: 1 }
      },
    })
    expect(result.status).toBe("waiting_approval")
    const paused = await runRow(result.runId!)
    expect(paused.pauseState?.tainted).toBe(true)
    expect(paused.pauseState?.taintedSources).toEqual(["mcp:crm"])
    await decide(approvalIds[0]!, "approve")
    const job = decisionJobs(approvalIds[0]!).at(-1)!
    let input: { tainted: boolean; taintedSources: string[] | null } | undefined
    await resumeRoutineRunOnDecision(job.payload as unknown as ApprovalResultTurnPayload, {
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      invoker: async (i) => {
        input = { tainted: i.tainted, taintedSources: i.taintedSources }
        await agentReply(i.threadId, "Done.")
        return { turnsAdded: 1 }
      },
    })
    // The approved call read no outside text: the run goes on marked by that one server only, not
    // by an unknown source (which would hold every call rule 6g lets through).
    expect(input).toEqual({ tainted: true, taintedSources: ["mcp:crm"] })
  })
})
