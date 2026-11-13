// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Routine flows (0303), run through `runRoutineTick` as the routine-tick job runs them, with the
// real tool path (executeTool -> projects / kernel handlers) as the routine's owner:
//   - an action-only flow assigns the task to the least loaded member, messages the assignee
//     (attributed to the routine, never to the owner), notifies the owner (attention pipeline)
//     and comments on the task, with ZERO agent calls; each step's state is on the run row;
//   - a step whose `if` does not hold is skipped and the flow goes on;
//   - a task the owner cannot read runs nothing: the run ends `skipped_condition`;
//   - a legacy routine (no flow) still calls the agent invoker exactly as before (S14).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { RoutineFlow } from "@liaison/shared"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { resumeFlowOnDecision } from "~/modules/agent/routines/flow-runner"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { seedContext } from "~/seed/context"
import { seedRoutine } from "~/seed/factories/agent/routines"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import * as minimal from "~/seed/tiers/minimal"
import { clearRedisPatterns } from "~/tests/route-test-setup"

let ORG = ""
let OWNER = ""
let ALICE = ""
let BOB = ""
/** A member with no projects scope: cannot read a task. */
let CAROL = ""
/** A member who left. */
let DAVE = ""
const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:read",
  "kernel:threads:write",
]
const ctx = (userId: string): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: { "*": ["*"] },
  roles: [],
})

const FIELDS = [{ key: "kind", label: "Kind", type: "choice", choices: ["Noise", "Power"] }]
let projectId = ""
let openStatus = ""

async function task(title: string, extra: { assigneeId?: string; kind?: string } = {}) {
  const t = await withRlsContext(ctx(OWNER), (tx) =>
    createTask({
      tx,
      orgId: ORG,
      actor: ctx(OWNER),
      input: {
        projectId,
        statusId: openStatus,
        title,
        ...(extra.assigneeId ? { assigneeId: extra.assigneeId } : {}),
        ...(extra.kind ? { fields: { kind: extra.kind } } : {}),
      },
    }),
  )
  return t.id
}

async function flowRoutine(name: string, flow: RoutineFlow | null, scopes = SCOPES) {
  return seedRoutine(seedContext({ orgId: ORG, now: new Date() }), {
    createdByUserId: OWNER,
    ownerScopes: ["*"],
    enabled: true,
    routine: {
      name,
      description: "flow",
      kind: "event",
      event: "projects:task:status_changed",
      ownerUserId: OWNER,
      scopes,
      prompt: "Handle the task",
      ...(flow ? { flow } : {}),
    },
  })
}

function tickFor(
  routineId: string,
  taskId: string,
  invoked: string[],
  flowDeps?: Parameters<typeof runRoutineTick>[0]["flowDeps"],
) {
  return runRoutineTick({
    orgId: ORG,
    routineId,
    scheduledAt: new Date().toISOString(),
    triggerEvent: {
      app: "projects",
      entity: "task",
      action: "status_changed",
      entityId: taskId,
      data: { id: taskId, projectId, fromStatusId: null, toStatusId: openStatus },
      origin: "internal",
    },
    agentInvoker: async ({ prompt }) => {
      invoked.push(prompt)
      return { turnsAdded: 1 }
    },
    ...(flowDeps ? { flowDeps } : {}),
  })
}

async function runRow(runId: string) {
  const [row] = await sql<
    { status: string; steps: Array<{ id: string; state: string; note: string | null }> | null }[]
  >`SELECT status, steps FROM kernel.routine_runs WHERE id = ${runId}::uuid`
  return row!
}

beforeAll(async () => {
  ORG = (await minimal.secondOrg({ name: "Flow Org" })).orgId
  OWNER = (await minimal.person(ORG, { name: "Owner" })).id
  ALICE = (await minimal.person(ORG, { name: "Alice Example" })).id
  BOB = (await minimal.person(ORG, { name: "Bob Example" })).id
  for (const id of [OWNER, ALICE, BOB]) await minimal.grantScope(id, "*")
  CAROL = (await minimal.person(ORG, { name: "Carol Example" })).id
  DAVE = (await minimal.person(ORG, { name: "Dave Example" })).id
  await minimal.grantScope(DAVE, "*")
  await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${DAVE}::uuid`
  await ensureAppsForOrg(ORG, {})
  const p = await withRlsContext(ctx(OWNER), (tx) =>
    createProject({ tx, orgId: ORG, actor: ctx(OWNER), input: { name: "Intake", fields: FIELDS } }),
  )
  projectId = p.id
  openStatus = p.statuses.find((s) => !s.terminal)!.id
  // Alice already holds two open tasks, Bob none.
  await task("Old one", { assigneeId: ALICE })
  await task("Old two", { assigneeId: ALICE })
}, 120_000)

beforeEach(async () => {
  await clearRedisPatterns(["routine-lock:*"])
})

afterAll(async () => {
  await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
})

describe("routine flows: actions", () => {
  it("an action-only flow assigns least loaded, messages, notifies and comments, with no agent", async () => {
    const routineId = await flowRoutine("intake-assign", {
      version: 1,
      steps: [
        {
          id: "assign",
          type: "action",
          action: "assign",
          args: { to: { leastLoaded: [ALICE, BOB] } },
        },
        {
          id: "dm",
          type: "action",
          action: "message",
          args: {
            to: "{{task.assigneeId}}",
            text: "New task for you: {{task.title}} ({{task.fields.kind}})",
          },
        },
        {
          id: "ping",
          type: "action",
          action: "notify",
          args: { to: ["{{owner}}"], text: "Assigned {{task.title}}" },
        },
        {
          id: "note",
          type: "action",
          action: "comment",
          args: { text: "Assigned to {{task.assigneeName}}" },
        },
      ],
    })
    const taskId = await task("Crackling noise", { kind: "Noise" })
    const invoked: string[] = []
    const result = await tickFor(routineId, taskId, invoked)
    expect(invoked).toEqual([])
    const row = await runRow(result.runId!)
    expect({ status: row.status, steps: row.steps?.map((s) => [s.id, s.state]) }).toEqual({
      status: "succeeded",
      steps: [
        ["assign", "done"],
        ["dm", "done"],
        ["ping", "done"],
        ["note", "done"],
      ],
    })

    const [t] = await sql<{ assignee_id: string; thread_id: string }[]>`
      SELECT assignee_id, thread_id FROM app_projects.tasks WHERE id = ${taskId}::uuid`
    expect(t!.assignee_id).toBe(BOB)

    // The direct message: in a conversation with Bob, written by the routine's agent identity.
    const dms = await sql<
      { author_type: string; author_id: string; content: string; label: unknown }[]
    >`
      SELECT m.author_type, m.author_id, m.content, m.metadata->>'agentAuthorLabel' AS label
        FROM kernel.messages m
        JOIN kernel.thread_participants p ON p.thread_id = m.thread_id AND p.user_id = ${BOB}::uuid
       WHERE m.org_id = ${ORG}::uuid AND m.content LIKE 'New task for you:%'`
    expect(dms.length).toBe(1)
    expect(dms[0]!.content).toBe("New task for you: Crackling noise (Noise)")
    expect(dms[0]!.author_type).toBe("agent")
    expect(dms[0]!.label).toBe("Routine intake-assign")

    const comments = await sql<{ content: string; author_type: string }[]>`
      SELECT content, author_type FROM kernel.messages WHERE thread_id = ${t!.thread_id}::uuid
         AND content = 'Assigned to Bob Example'`
    expect(comments.length).toBe(1)
    expect(comments[0]!.author_type).toBe("agent")

    const notes = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.pending_events
       WHERE org_id = ${ORG} AND payload->>'entity' = 'agent_notification'
         AND payload->'data'->>'summary' = 'Assigned Crackling noise'
         AND payload->'data'->'targetUserIds' ? ${OWNER}`
    expect(notes[0]!.n).toBe(1)
  }, 60_000)

  it("a step whose condition does not hold is skipped; the flow goes on", async () => {
    const routineId = await flowRoutine("intake-cond", {
      version: 1,
      steps: [
        {
          id: "power-only",
          type: "action",
          action: "assign",
          args: { to: ALICE },
          if: { field: "fields.kind", op: "eq", value: "Power" },
        },
        { id: "note", type: "action", action: "comment", args: { text: "Seen" } },
      ],
    })
    const taskId = await task("Hum", { kind: "Noise" })
    const invoked: string[] = []
    const result = await tickFor(routineId, taskId, invoked)
    const row = await runRow(result.runId!)
    expect(row.steps?.map((s) => [s.id, s.state])).toEqual([
      ["power-only", "skipped"],
      ["note", "done"],
    ])
    expect(row.status).toBe("succeeded")
    const [t] = await sql<{ assignee_id: string | null }[]>`
      SELECT assignee_id FROM app_projects.tasks WHERE id = ${taskId}::uuid`
    expect(t!.assignee_id).toBeNull()
    expect(invoked).toEqual([])
  }, 60_000)

  it("a task its owner cannot read runs nothing: skipped_condition", async () => {
    // The routine holds no projects scope: under its owner's RLS the task reads as absent.
    const routineId = await flowRoutine(
      "intake-blind",
      {
        version: 1,
        steps: [
          {
            id: "dm",
            type: "action",
            action: "message",
            args: { to: BOB, text: "{{task.title}}" },
          },
        ],
      },
      ["kernel:threads:write"],
    )
    const taskId = await task("Secret task")
    const invoked: string[] = []
    const result = await tickFor(routineId, taskId, invoked)
    const row = await runRow(result.runId!)
    expect(row.status).toBe("skipped_condition")
    expect(row.steps?.map((s) => s.state)).toEqual(["skipped"])
    const leaked = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages WHERE org_id = ${ORG}::uuid AND content = 'Secret task'`
    expect(leaked[0]!.n).toBe(0)
  }, 60_000)

  it("a legacy routine (no flow) runs its agent as before", async () => {
    const routineId = await flowRoutine("intake-legacy", null)
    const taskId = await task("Legacy")
    const invoked: string[] = []
    const result = await tickFor(routineId, taskId, invoked)
    expect(invoked.length).toBe(1)
    expect(invoked[0]).toContain("Handle the task")
    expect(result.status).toBe("succeeded")
    const row = await runRow(result.runId!)
    expect(row.steps).toBeNull()
  }, 60_000)

  // No model key (or no credits): a flow with no agent step makes no model call, so it runs
  // and the routine stays active; one that starts with an agent step is still refused.
  const noModel = async () => ({ reason: "Auto has no model to run", pause: true })
  it("an action-only flow runs with no model to run, and the routine is not paused", async () => {
    const routineId = await flowRoutine("intake-no-model", {
      version: 1,
      steps: [
        { id: "assign", type: "action", action: "assign", args: { to: ALICE } },
        { id: "note", type: "action", action: "comment", args: { text: "No model needed" } },
      ],
    })
    const taskId = await task("No model")
    const result = await runRoutineTick({
      orgId: ORG,
      routineId,
      scheduledAt: new Date().toISOString(),
      triggerEvent: {
        app: "projects",
        entity: "task",
        action: "status_changed",
        entityId: taskId,
        data: { id: taskId, projectId, fromStatusId: null, toStatusId: openStatus },
        origin: "internal",
      },
      checkCredits: noModel,
    })
    expect(result.status).toBe("succeeded")
    const [r] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.routines WHERE id = ${routineId}::uuid`
    expect(r!.status).toBe("active")
  }, 60_000)

  it("a flow that starts with an agent step is still refused with no model to run", async () => {
    const routineId = await flowRoutine("intake-no-model-agent", {
      version: 1,
      steps: [
        {
          id: "think",
          type: "agent",
          prompt: "Look at it",
          outcomes: [{ kind: "field_set", field: "kind" }],
        },
      ],
    })
    const taskId = await task("No model agent")
    const result = await runRoutineTick({
      orgId: ORG,
      routineId,
      scheduledAt: new Date().toISOString(),
      triggerEvent: {
        app: "projects",
        entity: "task",
        action: "status_changed",
        entityId: taskId,
        data: { id: taskId, projectId, fromStatusId: null, toStatusId: openStatus },
        origin: "internal",
      },
      checkCredits: noModel,
      agentInvoker: async () => ({ turnsAdded: 1 }),
    })
    expect(result.status).toBe("skipped_no_credits")
  }, 60_000)

  for (const decision of ["approved", "denied"] as const) {
    it(`a gated action parks on its approval and goes on once ${decision}`, async () => {
      const routineId = await flowRoutine(`intake-gated-${decision}`, {
        version: 1,
        steps: [
          { id: "assign", type: "action", action: "assign", args: { to: ALICE } },
          { id: "note", type: "action", action: "comment", args: { text: "After approval" } },
        ],
      })
      const taskId = await task(`Gated ${decision}`)
      const approvalId = randomUUID()
      let gatedOnce = false
      const result = await tickFor(routineId, taskId, [], {
        // The org's policy gates the assign: the call parks as an approval, as executeTool does.
        callTool: async (call) => {
          if (call.toolName === "projects:update" && !gatedOnce) {
            gatedOnce = true
            const frame = currentRunContext()
            await seedApprovalRequests(seedContext({ orgId: ORG, now: new Date() }), [
              {
                id: approvalId,
                handle: `request-${approvalId.slice(0, 6)}`,
                threadId: call.threadId,
                toolName: call.toolName,
                payload: call.params,
                requestedBy: OWNER,
                agentId: null,
                notifyUserIds: [OWNER],
                status: decision,
                createdAt: new Date(),
                metadata: {
                  originRoutineId: frame?.routineId,
                  originRoutineRunId: frame?.routineRunId,
                },
              },
            ])
            return { blocked: { approvalRequestId: approvalId } }
          }
          return { ok: true, data: {} }
        },
      })
      expect(result.status).toBe("waiting_approval")
      let row = await runRow(result.runId!)
      expect(row.steps?.map((s) => s.state)).toEqual(["awaiting_approval", "pending"])
      const resumed = await resumeFlowOnDecision(ORG, approvalId, {
        callTool: async () => ({ ok: true, data: {} }),
      })
      row = await runRow(result.runId!)
      if (decision === "approved") {
        expect(resumed?.status).toBe("succeeded")
        expect(row.steps?.map((s) => s.state)).toEqual(["done", "done"])
      } else {
        expect(resumed?.status).toBe("failed")
        expect(row.steps?.map((s) => s.state)).toEqual(["failed", "skipped"])
      }
      // A second decision event finds the run ended: nothing runs twice.
      expect((await resumeFlowOnDecision(ORG, approvalId))?.status).toBe("no_run")
    }, 60_000)
  }
})

describe("routine flows: notify", () => {
  const notifyFlow = (to: string[]): RoutineFlow => ({
    version: 1,
    steps: [
      { id: "tell", type: "action", action: "notify", args: { to, text: "Look: {{task.title}}" } },
    ],
  })
  async function notified(title: string, userId: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.pending_events
       WHERE org_id = ${ORG} AND payload->>'entity' = 'agent_notification'
         AND payload->'data'->>'summary' = ${`Look: ${title}`}
         AND payload->'data'->'targetUserIds' ? ${userId}`
    return row!.n
  }

  it("notifies a teammate who can read the task", async () => {
    const routineId = await flowRoutine("notify-alice", notifyFlow([ALICE]))
    const taskId = await task("Readable")
    const result = await tickFor(routineId, taskId, [])
    expect((await runRow(result.runId!)).status).toBe("succeeded")
    expect(await notified("Readable", ALICE)).toBe(1)
  }, 60_000)

  const refusals: Array<[string, () => string[], string[] | undefined, string]> = [
    ["someone outside the org", () => [randomUUID()], undefined, "not an active member"],
    ["a member who left", () => [DAVE], undefined, "not an active member"],
    ["a member who cannot read the task", () => [CAROL], undefined, "cannot read the task"],
    [
      "a teammate, without the scope to notify others",
      () => [ALICE],
      ["projects:projects:read", "projects:tasks:read"],
      "projects:tasks:write",
    ],
  ]
  for (const [who, to, scopes, reason] of refusals) {
    it(`refuses to notify ${who}: the step fails and nothing is sent`, async () => {
      const targets = to()
      const routineId = await flowRoutine(`notify-refused-${who}`, notifyFlow(targets), scopes)
      const title = `Refused for ${who}`
      const taskId = await task(title)
      const result = await tickFor(routineId, taskId, [])
      const row = await runRow(result.runId!)
      expect(row.status).toBe("failed")
      expect(row.steps?.[0]?.note).toContain(reason)
      expect(await notified(title, targets[0]!)).toBe(0)
    }, 60_000)
  }

  it("notifies the owner without the scope to notify others", async () => {
    const routineId = await flowRoutine("notify-self", notifyFlow(["{{owner}}"]), [
      "projects:projects:read",
      "projects:tasks:read",
    ])
    const taskId = await task("Self only")
    const result = await tickFor(routineId, taskId, [])
    expect((await runRow(result.runId!)).status).toBe("succeeded")
    expect(await notified("Self only", OWNER)).toBe(1)
  }, 60_000)
})
