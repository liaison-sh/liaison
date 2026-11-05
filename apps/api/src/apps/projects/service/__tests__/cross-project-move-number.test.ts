// SPDX-License-Identifier: FSL-1.1-ALv2
// A cross-project move gives every moved task (subtree included) a FRESH number
// from the destination project's counter. Task numbers are unique per project
// (app_projects_tasks_number_uidx on (project_id, number)) and allocated by
// app_projects.allocate_task_number. A move that kept the source numbers either
// collided with a destination task holding the same number (the move failed with
// `conflict`), or left the destination's counter pointing at a number a moved
// task already held, so every later create in that project failed with `conflict`.
// The bulk `move` action forwards the destination `projectId` to the same code path.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { moveTask } from "~/apps/projects/service/move-task"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { runBulkDispatch } from "~/modules/apps/bulk-dispatch"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Hermetic copy of execute-tool (a neighbouring file mock.module()s it; see
// assignee-name-enrichment.test.ts for the full story).
const { executeToolCore } = (await import(
  `${import.meta.dir}/../../../../modules/apps/execute-tool.ts?hermetic=projects-move-number`
)) as typeof import("~/modules/apps/execute-tool")

let orgId: string
let actor: UserContext

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:approve",
  "kernel:threads:write",
  "kernel:threads:read",
]

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'XMove Number Org', ${`xmove-number-${Date.now()}-${Math.random()}`})
      RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`xmove-number-${Date.now()}@test.com`}, 'XMove Number', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  actor = {
    actorType: "user",
    userId: user!.id,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }
})

afterAll(async () => {
  await releaseTestLock()
})

interface Env {
  projectId: string
  openStatusId: string
}

async function makeProject(): Promise<Env> {
  return withRlsContext(actor, async (tx) => {
    const r = await createProject({
      tx,
      orgId,
      actor,
      input: { name: `xmn ${randomUUID().slice(0, 8)}` },
    })
    return { projectId: r.id, openStatusId: r.statuses.find((s) => !s.terminal)!.id }
  })
}

async function makeTask(env: Env, title: string, parentTaskId?: string): Promise<string> {
  const t = await withRlsContext(actor, (tx) =>
    createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId: env.projectId,
        statusId: env.openStatusId,
        title,
        ...(parentTaskId ? { parentTaskId } : {}),
      },
    }),
  )
  return t.id
}

async function taskRow(id: string): Promise<{ project_id: string; number: number }> {
  return extractRows<{ project_id: string; number: number }>(
    await db.execute(
      drizzleSql`SELECT project_id, number FROM app_projects.tasks WHERE id = ${id}::uuid`,
    ),
  )[0]!
}

async function counter(projectId: string): Promise<number> {
  return extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT next_task_number AS n FROM app_projects.projects WHERE id = ${projectId}::uuid`,
    ),
  )[0]!.n
}

async function numbersIn(projectId: string): Promise<number[]> {
  return extractRows<{ number: number }>(
    await db.execute(
      drizzleSql`SELECT number FROM app_projects.tasks WHERE project_id = ${projectId}::uuid ORDER BY number`,
    ),
  ).map((r) => r.number)
}

describe("projects.move cross-project renumbers from the destination counter", () => {
  it("moves a task into a project already holding its number, with a fresh number", async () => {
    const src = await makeProject()
    const dest = await makeProject()
    const srcIds = [await makeTask(src, "s1"), await makeTask(src, "s2"), await makeTask(src, "s3")]
    for (const t of ["d1", "d2", "d3"]) await makeTask(dest, t)
    const moving = srcIds[2]!
    expect((await taskRow(moving)).number).toBe(3) // dest already holds number 3

    await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId: moving, targetProjectId: dest.projectId }),
    )

    const after = await taskRow(moving)
    expect(after.project_id).toBe(dest.projectId)
    expect(after.number).toBe(4)
    expect(await counter(dest.projectId)).toBe(5)
    expect(await numbersIn(dest.projectId)).toEqual([1, 2, 3, 4])
  })

  it("renumbers the whole moved subtree and a later create in the destination succeeds", async () => {
    const src = await makeProject()
    const dest = await makeProject() // fresh board: counter at 1
    const parent = await makeTask(src, "parent")
    const child = await makeTask(src, "child", parent)
    const grandchild = await makeTask(src, "grandchild", child)
    const lone = await makeTask(src, "lone")

    for (const id of [parent, lone]) {
      await withRlsContext(actor, (tx) =>
        moveTask({ tx, orgId, actor, taskId: id, targetProjectId: dest.projectId }),
      )
    }
    const moved = await Promise.all([parent, child, grandchild, lone].map(taskRow))
    for (const r of moved) expect(r.project_id).toBe(dest.projectId)
    expect(moved.map((r) => r.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(await counter(dest.projectId)).toBe(5)

    // Without renumbering, the dest counter (1) would hand out a number a moved
    // task already holds and this create would fail with a unique conflict.
    const created = await makeTask(dest, "after the move")
    expect((await taskRow(created)).number).toBe(5)
    expect(await numbersIn(dest.projectId)).toEqual([1, 2, 3, 4, 5])
  })

  it("leaves the number unchanged on a move within the same project", async () => {
    const env = await makeProject()
    const a = await makeTask(env, "a")
    await makeTask(env, "b")
    await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId: a, targetProjectId: env.projectId }),
    )
    expect((await taskRow(a)).number).toBe(1)
    expect(await counter(env.projectId)).toBe(3)
  })
})

describe("projects bulkUpdate move with a destination projectId", () => {
  it("moves every selected task across projects with fresh numbers", async () => {
    await ensureAppsForOrg(orgId, {})
    const src = await makeProject()
    const dest = await makeProject()
    await makeTask(dest, "d1")
    const ids = [await makeTask(src, "b1"), await makeTask(src, "b2"), await makeTask(src, "b3")]

    const res = await runBulkDispatch(
      {
        app: "projects",
        action: "move",
        ids,
        params: { projectId: dest.projectId },
        idempotencyKey: randomUUID(),
        actor,
        origin: "mcp",
      },
      { dispatch: executeToolCore, ensureOriginThread: async () => undefined },
    )
    expect(res.failed).toBe(0)
    expect(res.succeeded).toBe(3)
    for (const id of ids) expect((await taskRow(id)).project_id).toBe(dest.projectId)
    expect(await numbersIn(dest.projectId)).toEqual([1, 2, 3, 4])
    expect(await numbersIn(src.projectId)).toEqual([])
    const created = await makeTask(dest, "after bulk")
    expect((await taskRow(created)).number).toBe(5)
  }, 30_000)
})
