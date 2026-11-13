// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Routine flow agent steps (0303) with a stub agent invoker (the seam the routine worker tests
// use), which drives the bump loop the production invoker runs (`driveFlowBumps`):
//   - an outcome missing after the turn bumps the agent once, naming it; the agent then meets it
//     and the step is done, the run succeeded;
//   - an outcome never met is bumped `maxBumps` times, then the step and the run are flagged and
//     the owner gets an attention item naming the outcome;
//   - the agent step runs with the step's prompt, after the flow's actions;
//   - `tool_called` and `message_posted` count this run's own calls and messages only (another
//     run of the routine in the same thread at the same time never meets them), a tool reached
//     through kernel__call_tool by its inner name, and `{{owner}}` as a direct message.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { RoutineFlow, RoutineFlowOutcome } from "@liaison/shared"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, updateTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { describeOutcome, driveFlowBumps } from "~/modules/agent/routines/flow-runner"
import { type RoutineTickOpts, runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { currentRunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { sendMessage } from "~/modules/threads/message"
import { createThread } from "~/modules/threads/thread"
import { seedContext } from "~/seed/context"
import { seedRoutine } from "~/seed/factories/agent/routines"
import * as minimal from "~/seed/tiers/minimal"
import { clearRedisPatterns } from "~/tests/route-test-setup"

let ORG = ""
let OWNER = ""
let ALICE = ""
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

const FIELDS = [{ key: "diagnosis", label: "Diagnosis", type: "text" }]

async function task(title: string) {
  const t = await withRlsContext(ctx(), (tx) =>
    createTask({ tx, orgId: ORG, actor: ctx(), input: { projectId, statusId: openStatus, title } }),
  )
  return t.id
}

async function routine(name: string, flow: RoutineFlow) {
  return seedRoutine(seedContext({ orgId: ORG, now: new Date() }), {
    createdByUserId: OWNER,
    ownerScopes: ["*"],
    enabled: true,
    routine: {
      name,
      description: "agent step",
      kind: "event",
      event: "projects:task:status_changed",
      ownerUserId: OWNER,
      scopes: SCOPES,
      prompt: "Diagnose the task",
      flow,
    },
  })
}

const DIAGNOSE = (maxBumps?: number): RoutineFlow => ({
  version: 1,
  steps: [
    { id: "note", type: "action", action: "comment", args: { text: "Looking into it" } },
    {
      id: "diagnose",
      type: "agent",
      prompt: "Write the diagnosis into the task",
      outcomes: [{ kind: "field_set", field: "diagnosis" }],
      ...(maxBumps !== undefined ? { maxBumps } : {}),
    },
  ],
})

/** A stub agent: records each prompt and steer, and meets the outcome on the turn `fixOnTurn`. */
function stubAgent(taskId: string, fixOnTurn: number | null) {
  const turns: string[] = []
  const invoker: NonNullable<RoutineTickOpts["agentInvoker"]> = async ({ prompt, nextSteer }) => {
    turns.push(prompt)
    const act = async () => {
      if (fixOnTurn !== null && turns.length === fixOnTurn) {
        await withRlsContext(ctx(), (tx) =>
          updateTask({
            tx,
            orgId: ORG,
            actor: ctx(),
            taskId,
            input: { fields: { diagnosis: "Loose cable" } },
          }),
        )
      }
    }
    await act()
    await driveFlowBumps(nextSteer, async (steer) => {
      turns.push(steer)
      await act()
      return true
    })
    return { turnsAdded: turns.length }
  }
  return { turns, invoker }
}

function tick(
  routineId: string,
  taskId: string,
  invoker: NonNullable<RoutineTickOpts["agentInvoker"]>,
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
    agentInvoker: invoker,
  })
}

async function run(runId: string) {
  const [row] = await sql<
    {
      status: string
      error: string | null
      steps: Array<{ id: string; state: string; note: string | null; output?: { bumps?: number } }>
    }[]
  >`SELECT status, error, steps FROM kernel.routine_runs WHERE id = ${runId}::uuid`
  return row!
}

beforeAll(async () => {
  ORG = (await minimal.secondOrg({ name: "Flow Agent Org" })).orgId
  OWNER = (await minimal.person(ORG, { name: "Owner" })).id
  await minimal.grantScope(OWNER, "*")
  ALICE = (await minimal.person(ORG, { name: "Alice" })).id
  await ensureAppsForOrg(ORG, {})
  const p = await withRlsContext(ctx(), (tx) =>
    createProject({ tx, orgId: ORG, actor: ctx(), input: { name: "Bench", fields: FIELDS } }),
  )
  projectId = p.id
  openStatus = p.statuses.find((s) => !s.terminal)!.id
}, 120_000)

beforeEach(async () => {
  await clearRedisPatterns(["routine-lock:*"])
})

afterAll(async () => {
  await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
})

describe("routine flow agent steps", () => {
  it("a missing outcome bumps the agent once; met, the step is done", async () => {
    const routineId = await routine("diagnose-once", DIAGNOSE())
    const taskId = await task("Crackle")
    const agent = stubAgent(taskId, 2)
    const res = await tick(routineId, taskId, agent.invoker)
    expect(agent.turns).toEqual([
      "Write the diagnosis into the task",
      `Before finishing you still need to: ${describeOutcome({ kind: "field_set", field: "diagnosis" })}.`,
    ])
    const row = await run(res.runId!)
    expect(row.status).toBe("succeeded")
    expect(row.steps.map((s) => [s.id, s.state])).toEqual([
      ["note", "done"],
      ["diagnose", "done"],
    ])
    expect(row.steps[1]!.output?.bumps).toBe(1)
  }, 60_000)

  it("an outcome never met is bumped maxBumps times, then flagged with an attention item", async () => {
    const routineId = await routine("diagnose-never", DIAGNOSE())
    const taskId = await task("Hum")
    const agent = stubAgent(taskId, null)
    const res = await tick(routineId, taskId, agent.invoker)
    // The prompt, then the default 2 bumps.
    expect(agent.turns.length).toBe(3)
    const row = await run(res.runId!)
    expect(row.status).toBe("flagged")
    expect(row.steps[1]!.state).toBe("flagged")
    expect(row.steps[1]!.note).toContain('set the task field "diagnosis"')
    const alerts = await sql<{ summary: string; targets: string[] }[]>`
      SELECT payload->'data'->>'summary' AS summary,
             ARRAY(SELECT jsonb_array_elements_text(payload->'data'->'targetUserIds')) AS targets
        FROM kernel.pending_events
       WHERE org_id = ${ORG} AND payload->>'entity' = 'agent_notification'
         AND payload->'data'->'routineFlag'->>'runId' = ${res.runId!}`
    expect(alerts.length).toBe(1)
    expect(alerts[0]!.targets).toEqual([OWNER])
    expect(alerts[0]!.summary).toContain('set the task field "diagnosis"')
  }, 60_000)

  it("the flag names the routine by its title and the person by name, never by id", async () => {
    const routineId = await routine("message-alice", {
      version: 1,
      steps: [
        {
          id: "tell",
          type: "agent",
          prompt: "Tell Alice about the task",
          outcomes: [{ kind: "message_posted", to: ALICE }],
          maxBumps: 0,
        },
      ],
    })
    await sql`UPDATE kernel.routines SET title = 'Tell Alice on a status' WHERE id = ${routineId}::uuid`
    const taskId = await task("Rattle")
    const res = await tick(routineId, taskId, stubAgent(taskId, null).invoker)
    const row = await run(res.runId!)
    expect(row.steps[0]!.note).toContain("send Alice a message")
    expect(row.steps[0]!.note).not.toContain(ALICE)
    const [alert] = await sql<{ summary: string }[]>`
      SELECT payload->'data'->>'summary' AS summary FROM kernel.pending_events
       WHERE org_id = ${ORG} AND payload->>'entity' = 'agent_notification'
         AND payload->'data'->'routineFlag'->>'runId' = ${res.runId!}`
    expect(alert!.summary).toStartWith('Routine "Tell Alice on a status"')
    expect(alert!.summary).not.toContain(ALICE)
  }, 60_000)

  it("maxBumps 0 flags at once, without a bump", async () => {
    const routineId = await routine("diagnose-strict", DIAGNOSE(0))
    const taskId = await task("Buzz")
    const agent = stubAgent(taskId, null)
    const res = await tick(routineId, taskId, agent.invoker)
    expect(agent.turns.length).toBe(1)
    expect((await run(res.runId!)).status).toBe("flagged")
  }, 60_000)

  it("the bump loop stops when a re-prompt cannot be posted", async () => {
    let asked = 0
    const n = await driveFlowBumps(
      async () => {
        asked++
        return "steer"
      },
      async () => false,
    )
    expect({ n, asked }).toEqual({ n: 0, asked: 1 })
    expect(await driveFlowBumps(undefined, async () => true)).toBe(0)
  })
})

describe("routine flow outcomes are this run's own", () => {
  const withOutcome = (outcome: RoutineFlowOutcome): RoutineFlow => ({
    version: 1,
    steps: [{ id: "act", type: "agent", prompt: "Act", outcomes: [outcome], maxBumps: 0 }],
  })

  /** Runs `fn` as another run of the same routine would, in the same frame but its own run id. */
  function asOtherRun<T>(fn: () => Promise<T>): Promise<T> {
    const frame = currentRunContext()!
    const other = crypto.randomUUID()
    return runContextStore.run(
      { ...frame, runId: other, rootRunId: other, routineRunId: other },
      fn,
    )
  }

  /** A reply the agent's turn writes in the output thread, with its tool calls. */
  async function reply(threadId: string, toolCalls: unknown[]) {
    await withRlsContext(ctx(), (tx) =>
      sendMessage(tx, {
        orgId: ORG,
        userId: OWNER,
        threadId,
        content: "Done.",
        authorType: "agent",
        requiredScopes: [],
        metadata: { toolCalls },
      }),
    )
  }

  /** A direct message the agent's turn posts (kernel threads_create). */
  async function dm(to: string[], text: string) {
    await withRlsContext(ctx(), (tx) =>
      createThread(tx, {
        orgId: ORG,
        userId: OWNER,
        participantIds: to,
        initialMessage: {
          content: text,
          authorType: "agent",
          agentAuthorLabel: "Routine x",
          requiredScopes: [],
        },
      }),
    )
  }

  const update = (name: string) => [{ toolCallId: crypto.randomUUID(), toolName: name, args: {} }]
  const cases: Array<{
    name: string
    outcome: Parameters<typeof withOutcome>[0]
    act: (threadId: string) => Promise<void>
    status: string
  }> = [
    {
      name: "tool_called: this run's call counts",
      outcome: { kind: "tool_called", tool: "projects:update" },
      act: (t) => reply(t, update("projects__update")),
      status: "succeeded",
    },
    {
      name: "tool_called: a call through kernel__call_tool counts by its inner name",
      outcome: { kind: "tool_called", tool: "projects:update" },
      act: (t) =>
        reply(t, [
          {
            toolCallId: crypto.randomUUID(),
            toolName: "kernel__call_tool",
            args: { name: "projects__update", arguments: {} },
          },
        ]),
      status: "succeeded",
    },
    {
      name: "tool_called: another run's call in the same thread does not count",
      outcome: { kind: "tool_called", tool: "projects:update" },
      act: (t) => asOtherRun(() => reply(t, update("projects__update"))),
      status: "flagged",
    },
    {
      name: "message_posted: this run's message to a person counts",
      outcome: { kind: "message_posted", to: "ALICE" },
      act: () => dm([ALICE], "For Alice"),
      status: "succeeded",
    },
    {
      name: "message_posted: another run's message to that person does not count",
      outcome: { kind: "message_posted", to: "ALICE" },
      act: () => asOtherRun(() => dm([ALICE], "For Alice, from another run")),
      status: "flagged",
    },
    {
      name: "message_posted: {{owner}} is met by a direct message to the owner",
      outcome: { kind: "message_posted", to: "{{owner}}" },
      act: () => dm([], "For the owner"),
      status: "succeeded",
    },
    {
      name: "message_posted: {{owner}} is not met by a message to someone else",
      outcome: { kind: "message_posted", to: "{{owner}}" },
      act: () => dm([ALICE], "For Alice, not the owner"),
      status: "flagged",
    },
  ]
  for (const c of cases) {
    it(c.name, async () => {
      const outcome =
        c.outcome.kind === "message_posted" && c.outcome.to === "ALICE"
          ? { ...c.outcome, to: ALICE }
          : c.outcome
      const routineId = await routine(`outcome-${c.name}`, withOutcome(outcome))
      const taskId = await task(c.name)
      const res = await tick(routineId, taskId, async ({ threadId }) => {
        await c.act(threadId)
        return { turnsAdded: 1 }
      })
      expect((await run(res.runId!)).status).toBe(c.status)
    }, 60_000)
  }
})
