// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Routine flow waits (0303), with a fake clock and the resume job captured instead of queued:
//   - a wait parks the run (`waiting`) and arms one resume job at the working-time deadline,
//     keyed per routine, record and step (a newer arm replaces it);
//   - at the deadline, a condition still true goes on with the next step;
//   - a task whose status changed since the trigger ends the run `skipped_condition`, no step after;
//   - a job that fires early re-arms for the rest of the wait;
//   - a second run for the same task supersedes the first, which ends `skipped_condition`;
//   - the job takes the routine+record lock and comes back later while it is held.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { RoutineFlow } from "@liaison/shared"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, updateTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { enqueueAppJob, getJobQueue, registerJobWorker } from "~/infra/jobs/jobs"
import { redis } from "~/lib/redis"
import {
  FLOW_RESUME_JOB,
  type FlowDeps,
  type FlowResumePayload,
  flowWaitJobId,
  flowWaitRearmJobId,
  resumeFlowWait,
  runFlowResumeJob,
} from "~/modules/agent/routines/flow-runner"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { seedContext } from "~/seed/context"
import { seedRoutine } from "~/seed/factories/agent/routines"
import * as minimal from "~/seed/tiers/minimal"
import { waitFor } from "~/tests/helpers/wait-for"
import { clearRedisPatterns } from "~/tests/route-test-setup"

let ORG = ""
let OWNER = ""
const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:read",
  "kernel:threads:write",
]
const ctx = (): UserContext => ({
  actorType: "user",
  userId: OWNER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: { "*": ["*"] },
  roles: [],
})
let projectId = ""
let openStatus = ""
let nextStatus = ""
let routineId = ""

// Thursday 2026-11-12 10:00 Paris (UTC+1): + 1 working day (org default Mon-Fri 09-18 UTC).
const T0 = new Date("2026-11-12T10:00:00Z")

const FLOW: RoutineFlow = {
  version: 1,
  steps: [
    {
      id: "wait",
      type: "wait",
      for: { amount: 1, unit: "working_days" },
      until: { op: "status_unchanged_since_trigger" },
    },
    {
      id: "remind",
      type: "action",
      action: "comment",
      args: { text: "Still waiting: {{task.title}}" },
    },
  ],
}

const armed: Array<{ payload: FlowResumePayload; delayMs: number; jobId: string }> = []
const deps = (now: Date): FlowDeps => ({
  now: () => now,
  enqueueResume: async (payload, opts) => {
    armed.push({ payload, ...opts })
  },
})

async function task(title: string) {
  const t = await withRlsContext(ctx(), (tx) =>
    createTask({ tx, orgId: ORG, actor: ctx(), input: { projectId, statusId: openStatus, title } }),
  )
  return t.id
}

function tick(taskId: string, now: Date) {
  return runRoutineTick({
    orgId: ORG,
    routineId,
    scheduledAt: now.toISOString(),
    triggerEvent: {
      app: "projects",
      entity: "task",
      action: "status_changed",
      entityId: taskId,
      data: { id: taskId, projectId, fromStatusId: null, toStatusId: openStatus },
      origin: "internal",
    },
    agentInvoker: async () => {
      throw new Error("a flow without agent steps never calls the agent")
    },
    flowDeps: deps(now),
  })
}

async function run(runId: string) {
  const [row] = await sql<
    {
      status: string
      steps: Array<{ id: string; state: string; output?: { deadline?: string } }>
    }[]
  >`SELECT status, steps FROM kernel.routine_runs WHERE id = ${runId}::uuid`
  return row!
}

async function comments(taskId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.messages m
      JOIN app_projects.tasks t ON t.thread_id = m.thread_id
     WHERE t.id = ${taskId}::uuid AND m.content LIKE 'Still waiting:%'`
  return row!.n
}

beforeAll(async () => {
  ORG = (await minimal.secondOrg({ name: "Flow Wait Org" })).orgId
  OWNER = (await minimal.person(ORG, { name: "Owner" })).id
  await minimal.grantScope(OWNER, "*")
  await ensureAppsForOrg(ORG, {})
  const p = await withRlsContext(ctx(), (tx) =>
    createProject({ tx, orgId: ORG, actor: ctx(), input: { name: "Waiting room" } }),
  )
  projectId = p.id
  const open = p.statuses.filter((s) => !s.terminal)
  openStatus = open[0]!.id
  nextStatus = open[1]!.id
  routineId = await seedRoutine(seedContext({ orgId: ORG, now: new Date() }), {
    createdByUserId: OWNER,
    ownerScopes: ["*"],
    enabled: true,
    routine: {
      name: "remind-if-still",
      description: "remind",
      kind: "event",
      event: "projects:task:status_changed",
      ownerUserId: OWNER,
      scopes: SCOPES,
      prompt: "Remind when a task stays",
      flow: FLOW,
    },
  })
}, 120_000)

beforeEach(async () => {
  armed.length = 0
  await clearRedisPatterns(["routine-lock:*"])
})

afterAll(async () => {
  await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
})

describe("routine flow waits", () => {
  it("parks the run and arms one job at the working-time deadline", async () => {
    const taskId = await task("Parked")
    const res = await tick(taskId, T0)
    expect(res.status).toBe("waiting")
    const row = await run(res.runId!)
    expect(row.status).toBe("waiting")
    expect(row.steps.map((s) => s.state)).toEqual(["waiting", "pending"])
    expect(row.steps[0]!.output?.deadline).toBe("2026-11-13T10:00:00.000Z")
    expect(armed).toEqual([
      {
        payload: { orgId: ORG, routineId, runId: res.runId!, stepId: "wait" },
        delayMs: 24 * 3600_000,
        jobId: flowWaitJobId(routineId, taskId, "wait"),
      },
    ])
  })

  it("at the deadline, a condition still true goes on", async () => {
    const taskId = await task("Still here")
    const res = await tick(taskId, new Date())
    const deadline = new Date(String((await run(res.runId!)).steps[0]!.output?.deadline))
    const after = new Date(deadline.getTime() + 1000)
    const resumed = await resumeFlowWait(armed[0]!.payload, deps(after))
    expect(resumed.status).toBe("succeeded")
    const row = await run(res.runId!)
    expect(row.steps.map((s) => s.state)).toEqual(["done", "done"])
    expect(await comments(taskId)).toBe(1)
    // A replayed job finds the run ended: nothing runs twice.
    expect((await resumeFlowWait(armed[0]!.payload, deps(after))).status).toBe("no_run")
    expect(await comments(taskId)).toBe(1)
  })

  it("a status change since the trigger ends the run skipped_condition", async () => {
    const taskId = await task("Moved on")
    const res = await tick(taskId, new Date())
    await new Promise((r) => setTimeout(r, 20))
    await withRlsContext(ctx(), (tx) =>
      updateTask({ tx, orgId: ORG, actor: ctx(), taskId, input: { statusId: nextStatus } }),
    )
    const deadline = new Date(String((await run(res.runId!)).steps[0]!.output?.deadline))
    const resumed = await resumeFlowWait(
      armed[0]!.payload,
      deps(new Date(deadline.getTime() + 1000)),
    )
    expect(resumed.status).toBe("skipped_condition")
    const row = await run(res.runId!)
    expect(row.status).toBe("skipped_condition")
    expect(row.steps.map((s) => s.state)).toEqual(["skipped", "skipped"])
    expect(await comments(taskId)).toBe(0)
  })

  it("a job that fires early re-arms for the rest", async () => {
    const taskId = await task("Early")
    const res = await tick(taskId, T0)
    armed.length = 0
    const early = new Date("2026-11-13T09:00:00Z")
    const resumed = await resumeFlowWait(
      { orgId: ORG, routineId, runId: res.runId!, stepId: "wait" },
      deps(early),
    )
    expect(resumed.status).toBe("waiting")
    expect(armed.map((a) => a.delayMs)).toEqual([3600_000])
    expect((await run(res.runId!)).status).toBe("waiting")
  })

  it("on the real queue, an early job re-arms while it is itself the running job", async () => {
    const taskId = await task("Early on the queue")
    const res = await tick(taskId, T0)
    const early = new Date("2026-11-13T09:00:00Z")
    const handled: string[] = []
    registerJobWorker("kernel", FLOW_RESUME_JOB, async (payload: FlowResumePayload) => {
      // The default enqueue: the real kernel queue, while this job is active under the wait's id.
      const out = await runFlowResumeJob(payload, { now: () => early })
      handled.push(out.status)
    })
    const queue = getJobQueue("kernel", FLOW_RESUME_JOB)
    await enqueueAppJob(
      "kernel",
      FLOW_RESUME_JOB,
      { orgId: ORG, routineId, runId: res.runId!, stepId: "wait" },
      { jobId: flowWaitJobId(routineId, taskId, "wait"), delay: 0 },
    )
    await waitFor(() => handled.length === 1, { label: "the early job ran", timeoutMs: 15_000 })
    expect(handled).toEqual(["waiting"])
    const delayed = (await queue.getJobs(["delayed"])).filter(
      (j) => (j.data as FlowResumePayload).runId === res.runId,
    )
    expect(delayed.map((j) => j.opts.deduplication?.id)).toEqual([
      flowWaitRearmJobId(res.runId!, "wait", 1),
    ])
    expect((delayed[0]!.data as FlowResumePayload).rearms).toBe(1)
    for (const j of delayed) await j.remove()
  }, 30_000)

  it("a second run for the same task supersedes the first", async () => {
    const taskId = await task("Twice")
    const first = await tick(taskId, T0)
    const second = await tick(taskId, T0)
    const a = await run(first.runId!)
    expect(a.status).toBe("skipped_condition")
    expect(a.steps[0]!.state).toBe("skipped")
    expect((await run(second.runId!)).status).toBe("waiting")
    // Both arms carry the same job id: the newer replaces the older (replaceDelayed).
    expect(new Set(armed.map((x) => x.jobId)).size).toBe(1)
    expect(
      (await resumeFlowWait(armed[0]!.payload, deps(new Date(T0.getTime() + 2 * 86400_000))))
        .status,
    ).toBe("no_run")
  })

  it("the resume job comes back later while the record's lock is held", async () => {
    const taskId = await task("Busy")
    const res = await tick(taskId, T0)
    await redis.set(`routine-lock:${routineId}:${taskId}`, "someone", "EX", 60)
    armed.length = 0
    const out = await runFlowResumeJob(
      { orgId: ORG, routineId, runId: res.runId!, stepId: "wait" },
      deps(new Date(T0.getTime() + 2 * 86400_000)),
    )
    expect(out.status).toBe("lock_busy")
    expect(armed.map((a) => [a.jobId, a.delayMs, a.payload.lockRetries])).toEqual([
      [`flowwait-retry:${res.runId}:wait:1`, 60_000, 1],
    ])
    expect((await run(res.runId!)).status).toBe("waiting")
  })
})
