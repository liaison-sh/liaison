// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Module J — Task J1: cross-project task-by-assignee query + soft-delete.
 * Service-level integration test (real DB + RLS), modeled on
 * service/__tests__/hierarchy.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { createProject } from "~/apps/projects/service/create-project"
import {
  createTask,
  deleteTask,
  listTasksAcrossProjects,
  updateTask,
} from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userU: string
let userV: string
let actor: UserContext

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

function ctx(uid: string): UserContext {
  return {
    actorType: "user",
    userId: uid,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }
}

async function makeUser(label: string): Promise<string> {
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${label}-${Date.now()}-${Math.random()}@xp.test`}, ${label}, 'active', 'h', 1, 1)
      RETURNING id
    `),
  )
  return u!.id
}

async function makeProject(name: string): Promise<{ projectId: string; statusId: string }> {
  return withRlsContext(actor, async (tx) => {
    const r = await createProject({ tx, orgId, actor, input: { name } })
    return { projectId: r.id, statusId: r.statuses.find((s) => !s.terminal)!.id }
  })
}

async function makeTask(
  projectId: string,
  statusId: string,
  opts: { assigneeId?: string; dueDate?: string; parentTaskId?: string; title?: string },
): Promise<string> {
  return withRlsContext(actor, async (tx) => {
    const t = await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId,
        statusId,
        parentTaskId: opts.parentTaskId ?? null,
        assigneeId: opts.assigneeId ?? null,
        dueDate: opts.dueDate ?? null,
        title: opts.title ?? "Task",
      },
    })
    return t.id
  })
}

async function archivedAt(taskId: string): Promise<string | null> {
  const rows = extractRows<{ archived_at: Date | string | null }>(
    await db.execute(drizzleSql`
      SELECT archived_at FROM ${projectsRel("tasks")} WHERE id = ${taskId}::uuid
    `),
  )
  const v = rows[0]?.archived_at ?? null
  return v instanceof Date ? v.toISOString() : v
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-xp-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'XP Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  userU = await makeUser("UserU")
  userV = await makeUser("UserV")
  actor = ctx(userU)
})

afterAll(releaseTestLock)

describe("projects cross-project query + delete (J1)", () => {
  it("tasks_byAssignee returns the assignee's tasks across ALL projects with project name", async () => {
    const p1 = await makeProject("P1")
    const p2 = await makeProject("P2")
    const t1 = await makeTask(p1.projectId, p1.statusId, { assigneeId: userU, title: "T1" })
    const t2 = await makeTask(p2.projectId, p2.statusId, { assigneeId: userU, title: "T2" })
    await makeTask(p2.projectId, p2.statusId, { assigneeId: userV, title: "T3" })
    const out = await withRlsContext(actor, (tx) =>
      listTasksAcrossProjects({ tx, orgId, assigneeId: userU }),
    )
    expect(out.items.map((t) => t.id).sort()).toEqual([t1, t2].sort())
    expect(
      out.items.every((t) => typeof t.projectName === "string" && t.projectName.length > 0),
    ).toBe(true)
    // Sweep substrate: totalCount tracks the matching set (unpaginated → == items).
    expect(out.totalCount).toBe(out.items.length)
    expect(out.totalCount).toBe(2)
  })

  it("6 concurrent createTask calls all succeed (parallel tool calls must not 'Failed query')", async () => {
    // The agent frequently emits several projects__create calls in ONE turn; the AI SDK runs them
    // CONCURRENTLY, each in its own withRlsContext transaction. They must all succeed — a partial
    // 'Failed query' failure (seen in the chaos feature-request-triage / beta-program / rma-triage
    // runs, where only some of N creates landed) is a product bug, not weak-model behaviour.
    const p = await makeProject("Concurrent creates")
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        makeTask(p.projectId, p.statusId, { title: `Concurrent ${i}` }),
      ),
    )
    expect(new Set(ids).size).toBe(6)
  })

  it("listProjectTasks lists a project's tasks (with status labels), scoped to that project (BL-151)", async () => {
    const p = await makeProject("BL151 Project")
    const t1 = await makeTask(p.projectId, p.statusId, { title: "BL151 Task A" })
    const t2 = await makeTask(p.projectId, p.statusId, { title: "BL151 Task B" })
    // A task in a DIFFERENT project must NOT appear in this project's list.
    const other = await makeProject("BL151 Other")
    await makeTask(other.projectId, other.statusId, { title: "Other-project task" })
    const { listProjectTasks } = await import("~/apps/projects/service/tasks")
    const out = await withRlsContext(actor, (tx) =>
      listProjectTasks({ tx, orgId, projectId: p.projectId }),
    )
    expect(out.items.map((t) => t.id).sort()).toEqual([t1, t2].sort())
    expect(
      out.items.every((t) => typeof t.statusLabel === "string" && t.statusLabel.length > 0),
      "each task carries its status label",
    ).toBe(true)
    expect(out.items.every((t) => t.projectName === "BL151 Project")).toBe(true)
  })

  it("search (searchProjectsForTool) matches TASK titles, so an agent can find a task by name (BL-108)", async () => {
    // BL-108 regression: the projects `search` tool used to match PROJECT names only; it now chains
    // searchTasksByTitle so a task is findable by its title (resolve.ts) — the precondition for any
    // "find task X → act on it" flow.
    const p = await makeProject("BL108 Project")
    const taskId = await makeTask(p.projectId, p.statusId, {
      title: "Refactor the firmware bootloader handshake",
    })
    const { searchProjectsForTool } = await import("~/apps/projects/service/resolve")
    const out = await withRlsContext(actor, (tx) =>
      searchProjectsForTool(tx as never, orgId, { query: "bootloader" }),
    )
    expect(
      (out.items as Array<{ id?: string }>).some((i) => i.id === taskId),
      "the task must be findable by a keyword in its title",
    ).toBe(true)
  })

  it("search leaves out a deleted (archived) task unless asked to include it, and marks it then", async () => {
    // A deleted deal kept showing in search as a live Won deal, so the agent
    // refused to open a new one for the same customer.
    const p = await makeProject("Archived Search Project")
    const taskId = await makeTask(p.projectId, p.statusId, { title: "Lumen Studio retired deal" })
    await withRlsContext(actor, (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${projectsRel("tasks")} SET archived_at = now()
        WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid
      `),
    )
    const { searchProjectsForTool } = await import("~/apps/projects/service/resolve")
    const plain = await withRlsContext(actor, (tx) =>
      searchProjectsForTool(tx as never, orgId, { query: "Lumen Studio retired" }),
    )
    expect((plain.items as Array<{ id?: string }>).some((i) => i.id === taskId)).toBe(false)
    const included = await withRlsContext(actor, (tx) =>
      searchProjectsForTool(tx as never, orgId, {
        query: "Lumen Studio retired",
        archived: "include",
      }),
    )
    const hit = (included.items as Array<{ id?: string; archived?: boolean }>).find(
      (i) => i.id === taskId,
    )
    expect(hit?.archived).toBe(true)
  })

  it("tasks_byAssignee carries statusLabel + statusTerminal and the terminal:false filter returns ONLY open tasks (bulk-reassign-departing-teammate-tasks)", async () => {
    // The "reassign a departing teammate's OPEN tasks, leave DONE ones untouched" sweep needs to tell
    // open from done from the cross-project list. Before this fix listTasksAcrossProjects returned every
    // task with only statusId (no terminal flag, no filter), so the agent could not honor "non-done".
    const reassignActor = ctx(userU)
    const w = await makeProject("Reassign Open vs Done")
    // The seeded project has a terminal status — find it so we can place a DONE task.
    const statuses = extractRows<{ id: string; terminal: boolean }>(
      await withRlsContext(reassignActor, (tx) =>
        tx.execute(drizzleSql`
          SELECT id, terminal FROM ${projectsRel("project_statuses")}
          WHERE project_id = ${w.projectId}::uuid AND org_id = ${orgId}::uuid
        `),
      ),
    )
    const openStatusId = statuses.find((s) => !s.terminal)!.id
    const doneStatusId = statuses.find((s) => s.terminal)!.id
    // assigneeW gets one OPEN + one DONE task in this project.
    const assigneeW = await makeUser("ReassignW")
    const openTask = await makeTask(w.projectId, openStatusId, {
      assigneeId: assigneeW,
      title: "open one",
    })
    const doneTaskId = await makeTask(w.projectId, openStatusId, {
      assigneeId: assigneeW,
      title: "done one",
    })
    // Move the second task to the terminal column.
    await withRlsContext(reassignActor, (tx) =>
      updateTask({
        tx,
        orgId,
        actor: reassignActor,
        taskId: doneTaskId,
        input: { statusId: doneStatusId },
      }),
    )

    // Default (no filter): BOTH tasks come back, each carrying statusLabel + statusTerminal so the
    // caller can discriminate.
    const all = await withRlsContext(reassignActor, (tx) =>
      listTasksAcrossProjects({ tx, orgId, assigneeId: assigneeW }),
    )
    expect(all.items.map((t) => t.id).sort()).toEqual([openTask, doneTaskId].sort())
    expect(all.items.every((t) => typeof t.statusLabel === "string")).toBe(true)
    const doneItem = all.items.find((t) => t.id === doneTaskId)!
    const openItem = all.items.find((t) => t.id === openTask)!
    expect(doneItem.statusTerminal).toBe(true)
    expect(openItem.statusTerminal).toBe(false)

    // terminal:false → ONLY the open task (the reassign predicate). The done one must be excluded.
    const openOnly = await withRlsContext(reassignActor, (tx) =>
      listTasksAcrossProjects({ tx, orgId, assigneeId: assigneeW, terminal: false }),
    )
    expect(openOnly.items.map((t) => t.id)).toEqual([openTask])
    expect(openOnly.totalCount).toBe(1)

    // terminal:true → ONLY the done task.
    const doneOnly = await withRlsContext(reassignActor, (tx) =>
      listTasksAcrossProjects({ tx, orgId, assigneeId: assigneeW, terminal: true }),
    )
    expect(doneOnly.items.map((t) => t.id)).toEqual([doneTaskId])
  })

  it("tasks_byAssignee honors due:overdue across projects", async () => {
    const p = await makeProject("Pdue")
    await makeTask(p.projectId, p.statusId, {
      assigneeId: userV,
      dueDate: "2000-01-01",
      title: "old",
    })
    await makeTask(p.projectId, p.statusId, { assigneeId: userV, title: "noDue" })
    const out = await withRlsContext(actor, (tx) =>
      listTasksAcrossProjects({ tx, orgId, assigneeId: userV, due: "overdue" }),
    )
    expect(out.items.length).toBeGreaterThan(0)
    expect(out.items.every((t) => t.dueDate && new Date(t.dueDate) < new Date())).toBe(true)
  })

  it("tasks_byAssignee respects task RLS — the query relies entirely on task RLS (no project_id predicate)", async () => {
    const p = await makeProject("Pscoped")
    const tScoped = await makeTask(p.projectId, p.statusId, { assigneeId: userU, title: "scoped" })
    // The cross-project query drops the project_id predicate, so visibility is
    // governed solely by the tasks RLS SELECT policy (org_id + projects:read
    // scope). A caller WITHOUT projects:projects:read sees nothing — the real
    // enforced boundary in this app (there is no per-project membership model).
    const noReadActor: UserContext = {
      actorType: "user",
      userId: userV,
      orgId,
      scopes: ["projects:tasks:read"], // intentionally lacks projects:projects:read
      dimensionGrants: { "*": ["*"] },
    }
    const out = await withRlsContext(noReadActor, (tx) =>
      listTasksAcrossProjects({ tx, orgId, assigneeId: userU }),
    )
    expect(out.items.find((t) => t.id === tScoped)).toBeUndefined()
  })

  it("deleteTask soft-deletes (archived_at set), cascades children, emits canonical task:deleted", async () => {
    const p = await makeProject("Pdel")
    const parent = await makeTask(p.projectId, p.statusId, { title: "parent" })
    const child = await makeTask(p.projectId, p.statusId, { parentTaskId: parent, title: "child" })
    const events: Array<{ app: string; entity: string; action: string; entityId: string }> = []
    await withRlsContext(actor, (tx) =>
      deleteTask({ tx, orgId, actor, taskId: parent, queueEvent: (e) => events.push(e) }),
    )
    expect(await archivedAt(parent)).toBeTruthy()
    expect(await archivedAt(child)).toBeTruthy()
    expect(events).toContainEqual(
      expect.objectContaining({
        app: "projects",
        entity: "task",
        action: "deleted",
        entityId: parent,
      }),
    )
  })

  it("deleteTask is idempotent — deleting an already-archived task does not error or re-emit", async () => {
    const p = await makeProject("Pidem")
    const t = await makeTask(p.projectId, p.statusId, { title: "once" })
    await withRlsContext(actor, (tx) => deleteTask({ tx, orgId, actor, taskId: t }))
    const events: unknown[] = []
    await withRlsContext(actor, (tx) =>
      deleteTask({ tx, orgId, actor, taskId: t, queueEvent: (e) => events.push(e) }),
    )
    expect(events.length).toBe(0)
  })
})
