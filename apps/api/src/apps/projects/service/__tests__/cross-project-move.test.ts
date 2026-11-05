// SPDX-License-Identifier: FSL-1.1-ALv2
// Regression (BL-213): projects move supports CROSS-PROJECT relocation. Previously
// `move` only repositioned/re-parented/restatused a task WITHIN its project — there
// was no way to move a task to another project, so an agent that mis-filed a task
// (e.g. into a stray project during triage) had to recreate it in the right project
// and delete the original, stranding duplicate tasks (the feature-request-triage
// failure mode). `move` now accepts a destination `projectId`: it relocates the task
// and its whole subtree, remapping each task's status into the destination project.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { moveTask } from "~/apps/projects/service/move-task"
import { createTask, getTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
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
  const slug = `projects-xmove-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'XMove Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`xmove-${Date.now()}@test.com`}, 'XMove Tester', 'active', 'hash', 1, 1)
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

async function makeProject(name: string): Promise<{
  projectId: string
  openStatusId: string
  terminalStatusId: string
}> {
  return withRlsContext(actor, async (tx) => {
    const r = await createProject({ tx, orgId, actor, input: { name } })
    return {
      projectId: r.id,
      openStatusId: r.statuses.find((s) => !s.terminal)!.id,
      terminalStatusId: r.statuses.find((s) => s.terminal)!.id,
    }
  })
}

describe("projects.move cross-project (BL-213)", () => {
  it("relocates a task into another project and remaps its status", async () => {
    const src = await makeProject("xmove-src")
    const dest = await makeProject("xmove-dest")
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: src.projectId, statusId: src.openStatusId, title: "stray task" },
      }),
    )

    const moved = await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId: task.id, targetProjectId: dest.projectId }),
    )

    // Status is remapped to a status that belongs to the DESTINATION project.
    expect(moved.statusId).not.toBe(src.openStatusId)
    const after = await withRlsContext(actor, (tx) => getTask({ tx, orgId, taskId: task.id }))
    expect(after?.projectId).toBe(dest.projectId)
    expect(after?.statusId).toBe(dest.openStatusId) // non-terminal → dest's non-terminal
  })

  it("moves the whole subtree with the parent, all rows landing in the destination", async () => {
    const src = await makeProject("xmove-tree-src")
    const dest = await makeProject("xmove-tree-dest")
    const parent = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: src.projectId, statusId: src.openStatusId, title: "parent" },
      }),
    )
    const child = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: src.projectId,
          statusId: src.openStatusId,
          parentTaskId: parent.id,
          title: "child",
        },
      }),
    )

    await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId: parent.id, targetProjectId: dest.projectId }),
    )

    const movedChildProject = extractRows<{ project_id: string; parent_task_id: string | null }>(
      await db.execute(
        drizzleSql`SELECT project_id, parent_task_id FROM app_projects.tasks WHERE id = ${child.id}::uuid`,
      ),
    )[0]
    expect(movedChildProject?.project_id).toBe(dest.projectId)
    // The child stays parented to its parent (the subtree is preserved).
    expect(movedChildProject?.parent_task_id).toBe(parent.id)
  })

  it("rejects moving a CHILD task across projects (would split the tree)", async () => {
    const src = await makeProject("xmove-child-src")
    const dest = await makeProject("xmove-child-dest")
    const parent = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: src.projectId, statusId: src.openStatusId, title: "p" },
      }),
    )
    const child = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: src.projectId,
          statusId: src.openStatusId,
          parentTaskId: parent.id,
          title: "c",
        },
      }),
    )
    await expect(
      withRlsContext(actor, (tx) =>
        moveTask({ tx, orgId, actor, taskId: child.id, targetProjectId: dest.projectId }),
      ),
    ).rejects.toThrow(/cross_project_child_move|top-level/)
  })

  it("preserves terminal-ness: a done task lands on the destination's terminal status", async () => {
    const src = await makeProject("xmove-term-src")
    const dest = await makeProject("xmove-term-dest")
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: src.projectId, statusId: src.terminalStatusId, title: "done task" },
      }),
    )
    const moved = await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId: task.id, targetProjectId: dest.projectId }),
    )
    expect(moved.statusId).toBe(dest.terminalStatusId)
  })
})
