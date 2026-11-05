// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { moveTask } from "~/apps/projects/service/move-task"
import { createTask, getTask, updateTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let actor: UserContext

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-hierarchy-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Hierarchy Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`hierarchy-${Date.now()}@test.com`}, 'Hierarchy Tester', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user!.id
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }
})

afterAll(async () => {
  await releaseTestLock()
})

async function makeProjectWithStatuses(name: string): Promise<{
  projectId: string
  openStatusId: string
  terminalStatusId: string
}> {
  return withRlsContext(actor, async (tx) => {
    const result = await createProject({ tx, orgId, actor, input: { name } })
    return {
      projectId: result.id,
      openStatusId: result.statuses.find((s) => !s.terminal)!.id,
      terminalStatusId: result.statuses.find((s) => s.terminal)!.id,
    }
  })
}

async function chainOfDepth(projectId: string, statusId: string, depth: number): Promise<string[]> {
  return withRlsContext(actor, async (tx) => {
    const ids: string[] = []
    let parent: string | null = null
    for (let i = 0; i < depth; i++) {
      const t = await createTask({
        tx,
        orgId,
        actor,
        input: { projectId, statusId, parentTaskId: parent, title: `t${i}` },
      })
      ids.push(t.id)
      parent = t.id
    }
    return ids
  })
}

describe("projects.hierarchy", () => {
  it("projects.hierarchy.cycle-direct", async () => {
    const env = await makeProjectWithStatuses("cycle-direct")
    const [t1] = await chainOfDepth(env.projectId, env.openStatusId, 1)
    await expect(
      withRlsContext(actor, async (tx) =>
        moveTask({ tx, orgId, actor, taskId: t1!, parentTaskId: t1! }),
      ),
    ).rejects.toMatchObject({ code: "task_cycle_detected" })
  })

  it("projects.hierarchy.cycle-indirect", async () => {
    const env = await makeProjectWithStatuses("cycle-indirect")
    const [t1, _t2, t3] = await chainOfDepth(env.projectId, env.openStatusId, 3)
    await expect(
      withRlsContext(actor, async (tx) =>
        moveTask({ tx, orgId, actor, taskId: t1!, parentTaskId: t3! }),
      ),
    ).rejects.toMatchObject({ code: "task_cycle_detected" })
  })

  it("projects.hierarchy.depth-boundary", async () => {
    const env = await makeProjectWithStatuses("depth-boundary")
    const chain = await chainOfDepth(env.projectId, env.openStatusId, 8)
    const leaf = chain[7]!
    const depth7Ancestor = chain[6]!
    const other = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: env.projectId, statusId: env.openStatusId, title: "other" },
      }),
    )
    await expect(
      withRlsContext(actor, async (tx) =>
        moveTask({ tx, orgId, actor, taskId: other.id, parentTaskId: leaf }),
      ),
    ).rejects.toMatchObject({ code: "task_depth_exceeded" })
    const moved = await withRlsContext(actor, async (tx) =>
      moveTask({ tx, orgId, actor, taskId: other.id, parentTaskId: depth7Ancestor }),
    )
    expect(moved.parentTaskId).toBe(depth7Ancestor)
  })

  it("projects.hierarchy.cross-project-and-root-moves", async () => {
    const a = await makeProjectWithStatuses("cross-a")
    const b = await makeProjectWithStatuses("cross-b")
    const taskA = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: a.projectId, statusId: a.openStatusId, title: "a" },
      }),
    )
    const taskB = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: b.projectId, statusId: b.openStatusId, title: "b" },
      }),
    )
    await expect(
      withRlsContext(actor, async (tx) =>
        moveTask({ tx, orgId, actor, taskId: taskA.id, parentTaskId: taskB.id }),
      ),
    ).rejects.toMatchObject({ code: "cross_project_move" })

    const child = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: a.projectId,
          statusId: a.openStatusId,
          parentTaskId: taskA.id,
          title: "child",
        },
      }),
    )
    const result = await withRlsContext(actor, async (tx) =>
      moveTask({ tx, orgId, actor, taskId: child.id, parentTaskId: null }),
    )
    expect(result.parentTaskId).toBeNull()
  })
})

describe("projects.tasks.completedAt", () => {
  it("projects.tasks.completed-at-enter-terminal", async () => {
    const env = await makeProjectWithStatuses("enter-terminal")
    const t = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: env.projectId, statusId: env.openStatusId, title: "x" },
      }),
    )
    expect(t.completedAt).toBeNull()
    const updated = await withRlsContext(actor, async (tx) =>
      updateTask({
        tx,
        orgId,
        actor,
        taskId: t.id,
        input: { statusId: env.terminalStatusId },
      }),
    )
    expect(updated.completedAt).toBeTruthy()
  })

  it("projects.tasks.completed-at-leave-terminal", async () => {
    const env = await makeProjectWithStatuses("leave-terminal")
    const t = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: env.projectId, statusId: env.terminalStatusId, title: "x" },
      }),
    )
    // Force a completedAt
    await withRlsContext(actor, async (tx) =>
      tx.execute(drizzleSql`
        UPDATE app_projects.tasks SET completed_at = now()
        WHERE id = ${t.id}::uuid AND org_id = ${orgId}::uuid
      `),
    )
    const updated = await withRlsContext(actor, async (tx) =>
      updateTask({
        tx,
        orgId,
        actor,
        taskId: t.id,
        input: { statusId: env.openStatusId },
      }),
    )
    expect(updated.completedAt).toBeNull()
  })

  it("projects.tasks.completed-at-move-induced-status-change", async () => {
    const env = await makeProjectWithStatuses("move-completed")
    const t = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: env.projectId, statusId: env.openStatusId, title: "x" },
      }),
    )
    const moved = await withRlsContext(actor, async (tx) =>
      moveTask({ tx, orgId, actor, taskId: t.id, statusId: env.terminalStatusId }),
    )
    expect(moved.completedAt).toBeTruthy()
    const fetched = await withRlsContext(actor, async (tx) => getTask({ tx, orgId, taskId: t.id }))
    expect(fetched.completedAt).toBeTruthy()
  })
})
