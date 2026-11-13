// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Authoring routine flows (0303) through the agent tools and the REST routes:
//   - create_routine through executeTool takes a flow and a projects event filter and stays gated
//     (an approval whose card names the flow); an invalid flow is refused before any approval;
//   - the handler stores the flow and the filter; update_routine replaces the flow, null clears it;
//   - the projects app's flow templates enable for one project, their placeholders filled from its
//     statuses; without a project they refuse;
//   - GET /api/agent/routines?projectId= lists that project's routines, with their flow, and a
//     run's steps come back on GET /:id/runs.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { RoutineFlow } from "@liaison/shared"
import { app } from "~/app"
import { createProject } from "~/apps/projects/service/create-project"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { routineRuns } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import {
  handleCreateRoutine,
  handleEnableRoutineTemplate,
  handleUpdateRoutine,
} from "~/modules/agent/tools/skills-routines-tools"
import { type AppContext, createAppContext } from "~/modules/apps/context"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"

let ORG = ""
let OWNER = ""
let OTHER = ""
let projectId = ""
let statuses: Array<{ id: string; label: string; terminal: boolean }> = []

const SCOPES = [
  "kernel:routines:read",
  "kernel:routines:write",
  "kernel:threads:read",
  "kernel:threads:write",
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]
const actor = (): UserContext => ({
  actorType: "user",
  userId: OWNER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: { "*": ["*"] },
  roles: [],
})

async function routineCtx(): Promise<AppContext & { scopes: string[] }> {
  return withRlsContext(actor(), async (tx) => ({
    ...createAppContext("kernel", OWNER, ORG, tx, "user", OWNER),
    scopes: SCOPES,
  }))
}

const statusId = (label: string) => statuses.find((s) => s.label === label)!.id

const FLOW = (): RoutineFlow => ({
  version: 1,
  steps: [
    {
      id: "assign",
      type: "action",
      action: "assign",
      args: { to: { leastLoaded: [OWNER, OTHER] } },
    },
    {
      id: "wait",
      type: "wait",
      for: { amount: 1, unit: "working_days" },
      until: { op: "status_unchanged_since_trigger" },
    },
  ],
})

beforeAll(async () => {
  ORG = (await minimal.secondOrg({ name: "Flow Authoring Org" })).orgId
  OWNER = (await minimal.person(ORG, { name: "Owner" })).id
  OTHER = (await minimal.person(ORG, { name: "Other" })).id
  await minimal.grantScope(OWNER, "*")
  await ensureAppsForOrg(ORG, {})
  const p = await withRlsContext(actor(), (tx) =>
    createProject({ tx, orgId: ORG, actor: actor(), input: { name: "Repairs" } }),
  )
  projectId = p.id
  statuses = p.statuses
}, 120_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
})

function createParams(name: string, flow: RoutineFlow) {
  return {
    name,
    description: "Assign new tasks",
    kind: "event" as const,
    event: "projects:task:status_changed",
    eventFilter: { projectId, toStatusId: statusId("todo") },
    prompt: "Assigns each task that reaches To do",
    scopes: ["projects:tasks:read", "projects:tasks:write"],
    flow,
  }
}

describe("routine flow authoring", () => {
  it("create_routine takes a flow through the tool path and stays gated", async () => {
    const res = await executeTool({
      toolName: "kernel:create_routine",
      orgId: ORG,
      actor: actor(),
      origin: "in-app-agent",
      params: createParams("assign-new", FLOW()),
    })
    expect(res.blocked?.reason).toBe("gated")
    const approvalId = (res.blocked as { approvalRequestId?: string }).approvalRequestId!
    const [row] = await sql<{ payload: { flow?: unknown }; summary: unknown }[]>`
      SELECT current_payload AS payload, summary FROM kernel.approval_requests WHERE id = ${approvalId}::uuid`
    expect(row!.payload.flow).toEqual(FLOW())
    expect(JSON.stringify(row!.summary)).toContain("Flow, 2 steps: assign -> wait 1 working days")
    // Nothing exists until a person approves it.
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.routines WHERE org_id = ${ORG} AND name = 'assign-new'`
    expect(n!.n).toBe(0)
  })

  it("an invalid flow is refused before any approval", async () => {
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await expect(
      executeTool({
        toolName: "kernel:create_routine",
        orgId: ORG,
        actor: actor(),
        origin: "in-app-agent",
        params: { ...createParams("assign-bad", FLOW()), flow: { version: 1, steps: [] } },
      }),
    ).rejects.toThrow()
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(after[0]!.n).toBe(before[0]!.n)
  })

  it("the handler stores the flow and filter; update replaces and clears the flow", async () => {
    const res = (await handleCreateRoutine(
      createParams("assign-stored", FLOW()),
      await routineCtx(),
    )) as {
      routine?: { id: string }
      error?: unknown
    }
    expect(res.error).toBeUndefined()
    const id = res.routine!.id
    const [stored] = await sql<{ flow: unknown; event_filter: unknown }[]>`
      SELECT flow, event_filter FROM kernel.routines WHERE id = ${id}::uuid`
    expect(stored!.flow).toEqual(FLOW())
    expect(stored!.event_filter).toEqual({ projectId, toStatusId: statusId("todo") })

    const one: RoutineFlow = {
      version: 1,
      steps: [{ id: "note", type: "action", action: "comment", args: { text: "Seen" } }],
    }
    expect(
      ((await handleUpdateRoutine({ id, flow: one }, await routineCtx())) as { error?: unknown })
        .error,
    ).toBeUndefined()
    let [row] = await sql<
      { flow: unknown }[]
    >`SELECT flow FROM kernel.routines WHERE id = ${id}::uuid`
    expect(row!.flow).toEqual(one)
    await handleUpdateRoutine({ id, flow: null }, await routineCtx())
    // The human name (0304): set, then cleared back to the identifier.
    await handleUpdateRoutine({ id, title: "Assign stored · Website" }, await routineCtx())
    let [named] = await sql<{ title: string | null }[]>`
      SELECT title FROM kernel.routines WHERE id = ${id}::uuid`
    expect(named!.title).toBe("Assign stored · Website")
    await handleUpdateRoutine({ id, title: null }, await routineCtx())
    ;[named] = await sql<{ title: string | null }[]>`
      SELECT title FROM kernel.routines WHERE id = ${id}::uuid`
    expect(named!.title).toBeNull()
    ;[row] = await sql<{ flow: unknown }[]>`SELECT flow FROM kernel.routines WHERE id = ${id}::uuid`
    expect(row!.flow).toBeNull()

    const bad = (await handleCreateRoutine(
      { ...createParams("assign-misfit", FLOW()), event: "projects:task:moved" },
      await routineCtx(),
    )) as { error?: { code: string } }
    expect(bad.error?.code).toBe("invalid_event_filter")
  })

  it("a projects flow template enables for one project, placeholders filled", async () => {
    const missing = (await handleEnableRoutineTemplate(
      { appName: "projects", templateKey: "remind-if-still" },
      await routineCtx(),
    )) as { error?: { code: string } }
    expect(missing.error?.code).toBe("project_required")

    const res = (await handleEnableRoutineTemplate(
      { appName: "projects", templateKey: "sla-to-reach", projectId },
      await routineCtx(),
    )) as { routine?: { id: string }; error?: unknown }
    expect(res.error).toBeUndefined()
    const [row] = await sql<{ flow: RoutineFlow; event_filter: unknown; event: string }[]>`
      SELECT flow, event_filter, event FROM kernel.routines WHERE id = ${res.routine!.id}::uuid`
    expect(row!.event).toBe("projects:task:status_changed")
    expect(row!.event_filter).toEqual({
      projectId,
      fromStatusId: null,
      toStatusId: statusId("backlog"),
    })
    const wait = row!.flow.steps[0]!
    expect(wait.type === "wait" && wait.until).toEqual({
      field: "status",
      op: "in",
      value: [statusId("backlog"), statusId("todo"), statusId("in_progress")],
    })
  })

  it("GET ?projectId= lists the project's routines with their flow; runs return their steps", async () => {
    const res = (await handleCreateRoutine(
      { ...createParams("assign-listed", FLOW()), title: "Assign on status · Website" },
      await routineCtx(),
    )) as {
      routine: { id: string }
    }
    const steps = [
      {
        id: "assign",
        type: "action" as const,
        state: "done" as const,
        startedAt: null,
        endedAt: null,
        note: "Assigned.",
      },
    ]
    await withPrivilegedDb(ORG, "flow-authoring-run", (tx) =>
      tx
        .insert(routineRuns)
        .values({ orgId: ORG, routineId: res.routine.id, status: "succeeded", steps }),
    )
    const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
    const held = await withPrivilegedDb(ORG, "flow-authoring-token", (tx) =>
      loadEffectivePermissions(tx, OWNER, ORG),
    )
    const [versions] = await sql<{ auth_version: number; permission_version: number }[]>`
      SELECT auth_version, permission_version FROM kernel.users WHERE id = ${OWNER}::uuid`
    const token = await signAccessToken(
      {
        userId: OWNER,
        orgId: ORG,
        name: "Owner",
        authVersion: versions!.auth_version,
        permissionVersion: versions!.permission_version,
        scopes: [...new Set([...SCOPES, ...held.scopes])],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    const headers = { Authorization: `Bearer ${token}` }
    const list = await app.request(`/api/agent/routines?projectId=${projectId}`, { headers })
    expect(list.status).toBe(200)
    const body = (await list.json()) as {
      data: Array<{ name: string; title?: string | null; flow: unknown }>
    }
    const listed = body.data.find((r) => r.name === "assign-listed")
    expect(listed?.flow).toEqual(FLOW())
    // The human name travels with the row; the kebab identifier stays the name.
    expect(listed?.title).toBe("Assign on status · Website")
    expect(
      body.data.every((r) => r.name.startsWith("assign-") || r.name.startsWith("projects-")),
    ).toBe(true)
    const runs = await app.request(`/api/agent/routines/${res.routine.id}/runs`, { headers })
    const runBody = (await runs.json()) as { data: Array<{ steps: unknown }> }
    expect(runBody.data[0]?.steps).toEqual(steps)
  })
})
