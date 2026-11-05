// SPDX-License-Identifier: FSL-1.1-ALv2
// `createProject` with its initial tasks. An agent asked to plan work as a
// project created the board, then its tasks with `create`; when the board's
// creation was held for approval (a turn that read data some project readers
// cannot see), the tasks had no project to go in, and approving the board
// created an empty one with nothing resuming the agent. The tasks now ride in
// the create call: one approval creates the project and every task in it, in
// one transaction, and the card lists them.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { MAX_INITIAL_TASKS, normalizeInitialTasks } from "~/apps/projects/service/create-project"
import { summarizeCreateProject } from "~/apps/projects/summarizers"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { decideApproval } from "~/modules/approvals/decide"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// A fresh, unmocked execute-tool (see list-project-tasks.total.test.ts).
const { executeTool } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-initial-tasks`
)) as typeof import("~/modules/apps/execute-tool")

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:approve",
  "tickets:tickets:read",
  "kernel:threads:read",
  "kernel:threads:write",
]

let orgId: string
let userId: string
let threadId: string
let actor: UserContext

async function projectByName(name: string): Promise<{ id: string } | undefined> {
  return extractRows<{ id: string }>(
    await db.execute(drizzleSql`SELECT id::text AS id FROM app_projects.projects
      WHERE org_id = ${orgId}::uuid AND name = ${name}`),
  )[0]
}

async function taskTitles(projectId: string): Promise<string[]> {
  return extractRows<{ title: string }>(
    await db.execute(drizzleSql`SELECT title FROM app_projects.tasks
      WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid ORDER BY number`),
  ).map((r) => r.title)
}

function viaBridge(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withRlsContext(actor, async (tx) => {
    const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, SCOPES)
    return JSON.parse(await bridge.projects_createProject(JSON.stringify(input)))
  })
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Initial Tasks Org', ${`projects-initial-tasks-${Date.now()}`})
      RETURNING id`),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`initial-tasks-${Date.now()}@test.com`},
              'Planner', 'active', 'hash', 1, 1)
      RETURNING id`),
  )
  userId = u!.id
  for (const scope of SCOPES) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
  }
  // A teammate who reads projects but not tickets: a board written from a turn
  // that read tickets would show them what they may not see, so it waits.
  const [mate] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`initial-tasks-mate-${Date.now()}@test.com`},
              'Teammate', 'active', 'hash', 1, 1)
      RETURNING id`),
  )
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${mate!.id}, ${orgId}, 'projects:projects:read') ON CONFLICT DO NOTHING`
  const [t] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`plan-${Date.now()}`}, 'agent_chat', ${userId}::uuid)
      RETURNING id`),
  )
  threadId = t!.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${threadId}, ${userId}, ${orgId}, 'admin') ON CONFLICT DO NOTHING`
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
  await ensureAppsForOrg(orgId, {})
})

afterAll(async () => {
  await releaseTestLock()
})

describe("createProject's initial tasks: the list", () => {
  it("takes up to the cap, trims titles and keeps each task's fields", () => {
    expect(MAX_INITIAL_TASKS).toBe(20)
    expect(normalizeInitialTasks(undefined)).toEqual([])
    expect(
      normalizeInitialTasks([
        { title: "  Pick dates ", description: "Two Tuesdays" },
        { title: "Book speakers", assigneeName: "Planner" },
      ]),
    ).toEqual([
      { title: "Pick dates", description: "Two Tuesdays" },
      { title: "Book speakers", assigneeName: "Planner" },
    ])
  })

  it("refuses an empty title, an unknown field, a non-list or too many tasks", () => {
    expect(() => normalizeInitialTasks([{ title: "   " }])).toThrow(/invalid_tasks/)
    expect(() => normalizeInitialTasks([{ title: "A", statusId: "x" }])).toThrow(/invalid_tasks/)
    expect(() => normalizeInitialTasks("A, B")).toThrow(/invalid_tasks/)
    expect(() =>
      normalizeInitialTasks(Array.from({ length: 21 }, (_, i) => ({ title: `t${i}` }))),
    ).toThrow(/invalid_tasks: at most 20 tasks \(got 21\)/)
  })

  it("is declared on the tool with the task-create tool's own fields, at most 20", () => {
    const tools = projectsManifest.tools as Record<string, { params: Record<string, unknown> }>
    const create = (tools.create!.params as { properties: Record<string, unknown> }).properties
    const tasks = (
      tools.createProject!.params as {
        properties: { tasks: { maxItems: number; items: { properties: Record<string, unknown> } } }
      }
    ).properties.tasks
    expect(tasks.maxItems).toBe(20)
    for (const field of ["title", "description", "assigneeId", "assigneeName"]) {
      expect(tasks.items.properties[field]).toEqual(create[field])
    }
  })
})

describe("createProject's initial tasks: the write", () => {
  it("creates the project with its N tasks in one call", async () => {
    const name = `Webinars ${Date.now()}`
    const created = await viaBridge({
      name,
      tasks: [
        { title: "Pick the theme" },
        { title: "Book speakers", description: "Two speakers per session" },
        { title: "Open registrations", assigneeName: "Planner" },
      ],
    })
    expect(created.id).toBeTruthy()
    expect((created.tasks as Array<{ title: string }>).map((t) => t.title)).toEqual([
      "Pick the theme",
      "Book speakers",
      "Open registrations",
    ])
    expect(await taskTitles(created.id as string)).toEqual([
      "Pick the theme",
      "Book speakers",
      "Open registrations",
    ])
  })

  it("creates nothing when one task cannot be created", async () => {
    const name = `Broken plan ${Date.now()}`
    await expect(
      viaBridge({
        name,
        tasks: [{ title: "Fine" }, { title: "Who?", assigneeName: "Nobody At All" }],
      }),
    ).rejects.toThrow()
    expect(await projectByName(name)).toBeUndefined()
  })
})

describe("a held createProject with tasks", () => {
  it("parks with its tasks on the card, and approving it creates the project and every task", async () => {
    const name = `Held plan ${Date.now()}`
    const tasks = [{ title: "Theme" }, { title: "Dates" }, { title: "Speakers" }]
    // `executeTool` forwards the turn's taint to the dispatch (ExecuteToolCoreOptions).
    const call: Parameters<typeof executeTool>[0] & { turnTaintScopes: string[] } = {
      toolName: "projects:createProject",
      orgId,
      actor,
      params: { name, tasks },
      threadId,
      origin: "in-app-agent",
      // The turn read ticket data first: the board's readers may not hold it.
      turnTaintScopes: ["tickets:tickets:read"],
    }
    const res = await executeTool(call)
    const requestId = res.blocked?.approvalRequestId
    expect(requestId).toBeTruthy()
    expect(await projectByName(name)).toBeUndefined()

    const decided = await decideApproval({
      orgId,
      requestId: requestId as string,
      actor,
      decision: "approve",
    })
    expect(decided).toBeTruthy()
    const project = await projectByName(name)
    expect(project).toBeDefined()
    expect(await taskTitles(project!.id)).toEqual(["Theme", "Dates", "Speakers"])
  })

  it("lists the tasks on the approval card", async () => {
    const summary = await withRlsContext(actor, (tx) =>
      summarizeCreateProject(
        {
          name: "Autumn webinars",
          description: "Four sessions",
          tasks: [{ title: "Theme" }, { title: "Dates", assigneeName: "Planner" }],
        },
        { tx, orgId, userId },
      ),
    )
    expect(summary.title).toBe("Create project: Autumn webinars")
    expect(summary.lines.join("\n")).toContain("2 tasks")
    expect(summary.lines.join("\n")).toContain("1. Theme")
    expect(summary.lines.join("\n")).toContain("2. Dates (Planner)")
  })
})
