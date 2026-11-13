// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Routine flow agent steps (0303) with a stub agent invoker (the seam the routine worker tests
// use), which drives the bump loop the production invoker runs (`driveFlowBumps`):
//   - an outcome missing after the turn bumps the agent once, naming it; the agent then meets it
//     and the step is done, the run succeeded;
//   - an outcome never met is bumped `maxBumps` times, then the step and the run are flagged and
//     the owner gets an attention item naming the outcome;
//   - the agent step runs with the step's prompt, after the flow's actions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { RoutineFlow } from "@liaison/shared"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, updateTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { describeOutcome, driveFlowBumps } from "~/modules/agent/routines/flow-runner"
import { type RoutineTickOpts, runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { seedContext } from "~/seed/context"
import { seedRoutine } from "~/seed/factories/agent/routines"
import * as minimal from "~/seed/tiers/minimal"
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
