// SPDX-License-Identifier: FSL-1.1-ALv2
//
// createTask's import-only inputs (`createdBy`, `completedAt`,
// `allowInactiveAssignee`). The projects importer replays history: the task's
// real reporter, its real resolution time, and an assignee who may have left
// the org. Live callers never set these, so every default must behave exactly
// as before (the regression guards below), and the sandbox bridge must not let
// an app smuggle them in (bridge case at the end).

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { ProjectsServiceError } from "~/apps/projects/service/statuses"
import * as tasksModule from "~/apps/projects/service/tasks"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

let orgId: string
let actor: UserContext
let reporterId: string
let leaverId: string

async function insertUser(label: string, status: "active" | "deactivated"): Promise<string> {
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid,
              ${`${label.toLowerCase()}-${Date.now()}-${Math.random()}@fabrikam.example`}, ${label},
              ${status}, 'hash', 1, 1)
      RETURNING id
    `),
  )
  return u!.id
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Import Fields Org', ${`import-fields-${Date.now()}`}) RETURNING id
    `),
  )
  orgId = org!.id
  const actorId = await insertUser("Importer", "active")
  reporterId = await insertUser("Reporter", "active")
  leaverId = await insertUser("Leaver", "deactivated")
  actor = {
    actorType: "user",
    userId: actorId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }
})

afterAll(async () => {
  await releaseTestLock()
})

async function freshProject(): Promise<{ id: string; open: string; done: string }> {
  const project = await withRlsContext(actor, (tx) =>
    createProject({ tx, orgId, actor, input: { name: `ImportFields-${crypto.randomUUID()}` } }),
  )
  return {
    id: project.id,
    open: project.statuses.find((s) => !s.terminal)!.id,
    done: project.statuses.find((s) => s.terminal)!.id,
  }
}

interface Row {
  created_by: string
  completed_at: Date | string | null
  thread_created_by: string
  participants: string[]
}

async function readTask(taskId: string): Promise<Row> {
  const [row] = extractRows<Row>(
    await db.execute(drizzleSql`
      SELECT t.created_by, t.completed_at, th.created_by AS thread_created_by,
             ARRAY(SELECT p.user_id::text FROM kernel.thread_participants p
                   WHERE p.thread_id = t.thread_id ORDER BY p.user_id) AS participants
      FROM app_projects.tasks t
      JOIN kernel.threads th ON th.id = t.thread_id
      WHERE t.id = ${taskId}::uuid
    `),
  )
  return row!
}

async function countByTitle(title: string): Promise<{ tasks: number; threads: number }> {
  const [row] = extractRows<{ tasks: number; threads: number }>(
    await db.execute(drizzleSql`
      SELECT
        (SELECT count(*)::int FROM app_projects.tasks WHERE org_id = ${orgId}::uuid AND title = ${title}) AS tasks,
        (SELECT count(*)::int FROM kernel.threads WHERE org_id = ${orgId}::uuid
           AND created_from->>'app' = 'projects'
           AND NOT EXISTS (SELECT 1 FROM app_projects.tasks t WHERE t.thread_id = kernel.threads.id)) AS threads
    `),
  )
  return row!
}

describe("createTask import-only fields", () => {
  it("createdBy override lands on the task and its thread, and enrols the override", async () => {
    const p = await freshProject()
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: p.id, statusId: p.open, title: "reported", createdBy: reporterId },
      }),
    )
    const row = await readTask(task.id)
    expect(row.created_by).toBe(reporterId)
    expect(row.thread_created_by).toBe(reporterId)
    expect(row.participants).toContain(reporterId)
    expect(row.participants).toContain(actor.userId)
  })

  it("createdBy absent: task and thread created_by stay the actor (live callers unchanged)", async () => {
    const p = await freshProject()
    const task = await withRlsContext(actor, (tx) =>
      createTask({ tx, orgId, actor, input: { projectId: p.id, statusId: p.open, title: "live" } }),
    )
    const row = await readTask(task.id)
    expect(row.created_by).toBe(actor.userId)
    expect(row.thread_created_by).toBe(actor.userId)
    expect(row.participants).toEqual([actor.userId])
    expect(row.completed_at).toBeNull()
  })

  it("completedAt on a terminal status is stored as completed_at", async () => {
    const p = await freshProject()
    const resolvedAt = "2025-03-04T05:06:07.000Z"
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: p.id, statusId: p.done, title: "resolved", completedAt: resolvedAt },
      }),
    )
    const row = await readTask(task.id)
    expect(row.completed_at).not.toBeNull()
    expect(new Date(row.completed_at!).getTime()).toBe(new Date(resolvedAt).getTime())
  })

  it("completedAt on a non-terminal status is ignored (completed_at NULL)", async () => {
    const p = await freshProject()
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: p.id,
          statusId: p.open,
          title: "reopened",
          completedAt: "2025-03-04T05:06:07.000Z",
        },
      }),
    )
    expect((await readTask(task.id)).completed_at).toBeNull()
  })

  it("invalid completedAt throws invalid_completed_at and leaves no task or thread", async () => {
    const p = await freshProject()
    const title = `bad-completed-${crypto.randomUUID()}`
    const before = await countByTitle(title)
    let caught: unknown
    try {
      await withRlsContext(actor, (tx) =>
        createTask({
          tx,
          orgId,
          actor,
          input: { projectId: p.id, statusId: p.done, title, completedAt: "not-a-date" },
        }),
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProjectsServiceError)
    expect((caught as ProjectsServiceError).code).toBe("invalid_completed_at")
    expect(await countByTitle(title)).toEqual(before)
  })

  it("createdBy of a deactivated user: authorship exact, but NOT enrolled as participant", async () => {
    // A deactivated author (placeholder or leaver) must never become a thread
    // participant: participants receive reply attention rows and digest mail.
    const p = await freshProject()
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: p.id, statusId: p.open, title: "leaver-reported", createdBy: leaverId },
      }),
    )
    const row = await readTask(task.id)
    expect(row.created_by).toBe(leaverId)
    expect(row.thread_created_by).toBe(leaverId)
    expect(row.participants).toEqual([actor.userId])
  })

  it("createdBy from another org throws created_by_not_found and leaves no task or thread", async () => {
    const p = await freshProject()
    const [other] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Other Org', ${`import-fields-other-${Date.now()}`}) RETURNING id
      `),
    )
    const [stranger] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${other!.id}::uuid,
                ${`stranger-${Date.now()}@contoso.example`}, 'Stranger', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    const title = `cross-org-author-${crypto.randomUUID()}`
    const before = await countByTitle(title)
    let caught: unknown
    try {
      await withRlsContext(actor, (tx) =>
        createTask({
          tx,
          orgId,
          actor,
          input: { projectId: p.id, statusId: p.open, title, createdBy: stranger!.id },
        }),
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProjectsServiceError)
    expect((caught as ProjectsServiceError).status).toBe(404)
    expect((caught as ProjectsServiceError).code).toBe("created_by_not_found")
    expect(await countByTitle(title)).toEqual(before)
  })

  it("allowInactiveAssignee accepts a deactivated user; without it the user is rejected", async () => {
    const p = await freshProject()
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: p.id,
          statusId: p.open,
          title: "leaver-owned",
          assigneeId: leaverId,
          allowInactiveAssignee: true,
        },
      }),
    )
    expect(task.assigneeId).toBe(leaverId)

    for (const allowInactiveAssignee of [false, undefined]) {
      let caught: unknown
      try {
        await withRlsContext(actor, (tx) =>
          createTask({
            tx,
            orgId,
            actor,
            input: {
              projectId: p.id,
              statusId: p.open,
              title: "leaver-rejected",
              assigneeId: leaverId,
              ...(allowInactiveAssignee === undefined ? {} : { allowInactiveAssignee }),
            },
          }),
        )
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ProjectsServiceError)
      expect((caught as ProjectsServiceError).code).toBe("assignee_not_found")
    }
  })

  it("the sandbox bridge strips the import-only fields from app params", async () => {
    const p = await freshProject()
    // (1) The strip itself, observed on the input the bridge forwards to
    // createTask. An ACTIVE assignee is used on purpose: the bridge's own
    // pre-resolve (resolveAssignee, active-only) cannot mask a missed strip.
    const spy = spyOn(tasksModule, "createTask")
    let forwarded: Record<string, unknown> | undefined
    try {
      const out = await withRlsContext(actor, async (tx) => {
        const bridge = createRpcBridge(
          "projects",
          actor.userId,
          orgId,
          tx,
          { name: "projects" },
          SCOPES,
        )
        return JSON.parse(
          await bridge.projects_createTask(
            JSON.stringify({
              projectId: p.id,
              title: "bridge-forwarded",
              assigneeId: reporterId,
              createdBy: reporterId,
              completedAt: "2025-03-04T05:06:07.000Z",
              allowInactiveAssignee: true,
            }),
          ),
        ) as { id?: string; error?: { message: string } }
      })
      expect(out.error).toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(1)
      forwarded = spy.mock.calls[0]![0].input as unknown as Record<string, unknown>
    } finally {
      spy.mockRestore()
    }
    expect(forwarded).toBeDefined()
    expect("createdBy" in forwarded!).toBe(false)
    expect("completedAt" in forwarded!).toBe(false)
    expect("allowInactiveAssignee" in forwarded!).toBe(false)

    // (2) End to end, a deactivated assignee is still rejected. NOTE: this is
    // gated by the bridge's own active-only pre-resolve BEFORE createTask runs,
    // so it is not proof of the strip (that is (1)); it guards the outcome.
    const rejected = await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge(
        "projects",
        actor.userId,
        orgId,
        tx,
        { name: "projects" },
        SCOPES,
      )
      return JSON.parse(
        await bridge.projects_createTask(
          JSON.stringify({
            projectId: p.id,
            title: "bridge-leaver",
            assigneeId: leaverId,
            allowInactiveAssignee: true,
          }),
        ),
      ) as { error?: { code?: string; message: string } }
    })
    expect(rejected.error?.code).toBe("assignee_not_found")

    const created = await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge(
        "projects",
        actor.userId,
        orgId,
        tx,
        { name: "projects" },
        SCOPES,
      )
      return JSON.parse(
        await bridge.projects_createTask(
          JSON.stringify({
            projectId: p.id,
            statusId: p.done,
            title: "bridge-spoof",
            createdBy: reporterId,
            completedAt: "2025-03-04T05:06:07.000Z",
          }),
        ),
      ) as { id?: string; error?: { message: string } }
    })
    expect(created.error).toBeUndefined()
    const row = await readTask(created.id!)
    expect(row.created_by).toBe(actor.userId)
    expect(row.thread_created_by).toBe(actor.userId)
    expect(row.completed_at).toBeNull()
  })
})
