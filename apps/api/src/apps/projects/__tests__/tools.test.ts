// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  createProject,
  listProjects,
  loadProjectDetail,
} from "~/apps/projects/service/create-project"
import { moveTask } from "~/apps/projects/service/move-task"
import { resolveAssignee, resolveProjectId } from "~/apps/projects/service/resolve"
import { createTask, deleteTask, getTask, listTasks } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let marieId: string
let alex1Id: string
let alex2Id: string
let actor: UserContext

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-tools-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Tools Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const insertUser = async (name: string): Promise<string> => {
    const [u] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid,
                ${`${name.toLowerCase()}-${Date.now()}-${Math.random()}@test.com`}, ${name},
                'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    return u!.id
  }
  userId = await insertUser("Owner")
  marieId = await insertUser("Marie")
  alex1Id = await insertUser("Alex")
  alex2Id = await insertUser("Alex")
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

describe("projects.tools", () => {
  it("projects.tools.resolve-assignee-marie", async () => {
    const id = await withRlsContext(actor, async (tx) =>
      resolveAssignee(tx, orgId, { assigneeName: "Marie" }),
    )
    expect(id).toBe(marieId)
  })

  it("projects.tools.resolve-assignee-id-requires-active-org-user", async () => {
    const direct = await withRlsContext(actor, async (tx) =>
      resolveAssignee(tx, orgId, { assigneeId: marieId }),
    )
    expect(direct).toBe(marieId)

    const [otherOrg] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Tools Other Org', ${`tools-other-${Date.now()}`})
        RETURNING id
      `),
    )
    const [foreignUser] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${otherOrg!.id}::uuid,
                ${`foreign-${Date.now()}@test.com`}, 'Foreign', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    await expect(
      withRlsContext(actor, async (tx) =>
        resolveAssignee(tx, orgId, { assigneeId: foreignUser!.id }),
      ),
    ).rejects.toMatchObject({ code: "assignee_not_found" })

    const [inactiveUser] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid,
                ${`inactive-${Date.now()}@test.com`}, 'Inactive', 'deactivated', 'hash', 1, 1)
        RETURNING id
      `),
    )
    await expect(
      withRlsContext(actor, async (tx) =>
        resolveAssignee(tx, orgId, { assigneeId: inactiveUser!.id }),
      ),
    ).rejects.toMatchObject({ code: "assignee_not_found" })
  })

  it("projects.tools.resolve-assignee-not-found", async () => {
    await expect(
      withRlsContext(actor, async (tx) => resolveAssignee(tx, orgId, { assigneeName: "Nobody" })),
    ).rejects.toMatchObject({ code: "assignee_not_found" })
  })

  it("projects.tools.resolve-assignee-ambiguous", async () => {
    await expect(
      withRlsContext(actor, async (tx) => resolveAssignee(tx, orgId, { assigneeName: "Alex" })),
    ).rejects.toMatchObject({ code: "assignee_ambiguous" })
    expect(alex1Id).not.toBe(alex2Id) // both inserted
  })

  it("projects.tools.resolve-assignee-partial-first-name", async () => {
    // BL-183: an agent that extracts a FIRST name from prose ("Marco") must resolve it to the
    // full-name user "Marco Fulfillment" — there is no exact match for "Marco" alone.
    const [marco] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`marco-${Date.now()}@test.com`},
                'Marco Fulfillment', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    const id = await withRlsContext(actor, async (tx) =>
      resolveAssignee(tx, orgId, { assigneeName: "Marco" }),
    )
    expect(id).toBe(marco!.id)
  })

  it("projects.tools.approve-create-assigning-full-name-to-single-word-account", async () => {
    // Prod 2026-09-22: a gated projects:create carried assigneeName "Jordan Bellamy" while the
    // account read just "Jordan". On approve the handler threw "no user with that name", the request
    // stayed pending, and the approver (Jordan himself) could only get it through by renaming
    // himself. Replay that approval's execution path: the approver runs projects_createTask.
    const [maxime] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`maxime-${Date.now()}@test.com`},
                'Jordan', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    const maximeId = maxime!.id
    const approver: UserContext = { ...actor, userId: maximeId }
    const project = await withRlsContext(approver, async (tx) =>
      createProject({ tx, orgId, actor: approver, input: { name: `Recette-${Date.now()}` } }),
    )
    const created = await withRlsContext(approver, async (tx) => {
      const bridge = createRpcBridge("projects", maximeId, orgId, tx, { name: "projects" }, SCOPES)
      return JSON.parse(
        await bridge.projects_createTask(
          JSON.stringify({
            projectId: project.id,
            title: "D5 · Vocabulaire",
            priority: "low",
            assigneeName: "Jordan Bellamy",
          }),
        ),
      ) as { id?: string; assigneeId?: string | null }
    })
    expect(created.assigneeId).toBe(maximeId)

    // Every word of the stored name must be in the given one: no near-miss match.
    await expect(
      withRlsContext(actor, async (tx) =>
        resolveAssignee(tx, orgId, { assigneeName: "Jordana Bellamy" }),
      ),
    ).rejects.toMatchObject({ code: "assignee_not_found" })

    // The read the staging preflight uses answers the same resolution, without throwing.
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, SCOPES)
      const hit = JSON.parse(
        await bridge.projects_resolveAssignee(JSON.stringify({ assigneeName: "Jordan Bellamy" })),
      ) as { id?: string }
      expect(hit.id).toBe(maximeId)
      const miss = JSON.parse(
        await bridge.projects_resolveAssignee(JSON.stringify({ assigneeName: "Nobody Here" })),
      ) as { error?: { code?: string } }
      expect(miss.error?.code).toBe("assignee_not_found")
    })
  })

  it("projects.tools.resolve-assignee-partial-ambiguous", async () => {
    // A partial word matching MORE than one user is ambiguous — surface candidates, never guess.
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`ines-${Date.now()}@test.com`}, 'Ines Generalist', 'active', 'hash', 1, 1),
             (gen_random_uuid(), ${orgId}::uuid, ${`raph-${Date.now()}@test.com`}, 'Raphael Generalist', 'active', 'hash', 1, 1)
    `)
    await expect(
      withRlsContext(actor, async (tx) =>
        resolveAssignee(tx, orgId, { assigneeName: "Generalist" }),
      ),
    ).rejects.toMatchObject({ code: "assignee_ambiguous" })
  })

  it("projects.tools.resolve-project-single-active", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `Solo-${Date.now()}` } }),
    )
    const resolved = await withRlsContext(actor, async (tx) =>
      resolveProjectId(tx, orgId, { projectName: project.name }),
    )
    expect(resolved).toBe(project.id)
  })

  it("projects.tools.move-emits-event", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `Move-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const t1 = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "t1" },
      }),
    )
    const t2 = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "t2" },
      }),
    )
    await withRlsContext(actor, async (tx) =>
      moveTask({ tx, orgId, actor, taskId: t1.id, parentTaskId: t2.id }),
    )
    const events = extractRows<{ entity_id: string }>(
      await db.execute(drizzleSql`
        SELECT payload->>'entityId' AS entity_id FROM kernel.pending_events
        WHERE org_id = ${orgId}::uuid
          AND payload->>'entity' = 'task'
          AND payload->>'action' = 'moved'
      `),
    )
    expect(events.find((e) => e.entity_id === t1.id)).toBeTruthy()
  })

  it("projects.tools.get-task-requires-task-read-scope", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `GetScope-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const task = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "secret task" },
      }),
    )

    await withRlsContext(actor, async (tx) => {
      const withoutTaskRead = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
      ])
      const denied = JSON.parse(
        await withoutTaskRead.projects_get(JSON.stringify({ taskId: task.id })),
      ) as { error?: { code: string } }
      expect(denied.error?.code).toBe("forbidden")

      const withTaskRead = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
      ])
      const allowed = JSON.parse(
        await withTaskRead.projects_get(JSON.stringify({ taskId: task.id })),
      ) as { id?: string }
      expect(allowed.id).toBe(task.id)
    })
  })

  it("projects.tools.comment-writes-and-reads-a-task-discussion", async () => {
    // There was no comment verb on a task at all, and its thread was
    // unreachable: kernel threads are participant-gated, so the threadId a task
    // listing hands out answered "not a participant" for a thread whose id the
    // caller could plainly see.
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `Comment-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const task = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "needs a note" },
      }),
    )

    // Comment as MARIE, who did not create the task and is therefore NOT yet a
    // participant of its thread. That is the whole reported case: a colleague
    // reading someone else's task. The creator was always a participant, so
    // testing as the creator proves nothing.
    const marieActor = {
      actorType: "user" as const,
      userId: marieId,
      orgId,
      scopes: SCOPES,
      dimensionGrants: { "*": ["*"] },
    }

    // Before any task read, Marie cannot reach the thread at all.
    const threadId = await withRlsContext(actor, async (tx) => {
      const { getTask } = await import("~/apps/projects/service/tasks")
      return (await getTask({ tx, orgId, taskId: task.id })).threadId
    })
    await withRlsContext(marieActor, async (tx) => {
      const { listMessages } = await import("~/modules/threads/message")
      const cold = await listMessages(tx, { orgId, userId: marieId, threadId, limit: 10 })
      expect(cold).toBeNull()
    })

    await withRlsContext(marieActor, async (tx) => {
      const bridge = createRpcBridge("projects", marieId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
        "projects:tasks:write",
      ])
      const posted = JSON.parse(
        await bridge.projects_addComment(
          JSON.stringify({ taskId: task.id, body: "the aggregator redirect is the cause" }),
        ),
      ) as { taskId?: string; threadId?: string; messageId?: string | null }
      expect(posted.taskId).toBe(task.id)
      expect(posted.threadId).toBe(threadId)

      const read = JSON.parse(
        await bridge.projects_listComments(JSON.stringify({ taskId: task.id })),
      ) as { threadId?: string; messages?: Array<{ content?: string }> }
      expect(read.threadId).toBe(threadId)
      const bodies = (read.messages ?? []).map((m) => m.content)
      expect(bodies).toContain("the aggregator redirect is the cause")
    })
  })

  it("projects.tools.comment-resolves-a-display-key-and-refuses-without-write", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `CommentKey-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const task = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "by key" },
      }),
    )
    const detail = await withRlsContext(actor, async (tx) => {
      const { getTask } = await import("~/apps/projects/service/tasks")
      return getTask({ tx, orgId, taskId: task.id })
    })

    await withRlsContext(actor, async (tx) => {
      // Read scope alone must not be able to write a comment.
      const readOnly = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
      ])
      const refused = JSON.parse(
        await readOnly.projects_addComment(
          JSON.stringify({ taskId: detail.key, body: "should not land" }),
        ),
      ) as { error?: { code?: string } }
      expect(refused.error?.code).toBe("forbidden")

      // With write, the DISPLAY KEY resolves like every other task tool.
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
        "projects:tasks:write",
      ])
      const posted = JSON.parse(
        await bridge.projects_addComment(
          JSON.stringify({ taskId: detail.key, body: "resolved by key" }),
        ),
      ) as { taskId?: string }
      expect(posted.taskId).toBe(task.id)
    })
  })

  it("projects.tools.get-by-id-resolves-a-project (BL-108 param drift)", async () => {
    // The agent tool declares a single `id` ("project or task id"); the RPC must resolve it instead
    // of 422'ing invalid_params (it only accepted projectId/taskId before).
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `GetById-${Date.now()}` } }),
    )
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
      ])
      const got = JSON.parse(await bridge.projects_get(JSON.stringify({ id: project.id }))) as {
        id?: string
        statuses?: unknown[]
      }
      expect(got.id).toBe(project.id)
      expect(Array.isArray(got.statuses)).toBe(true) // statuses returned so the agent can find Done
    })
  })

  it("projects.tools.search-matches-task-titles (BL-108)", async () => {
    // projects:search promised "project/task titles" but matched project names only → a task was
    // unfindable by name. It must now surface matching tasks.
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `TaskSearchProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const title = `Gen 1 QA hold ${Date.now()}`
    const task = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title },
      }),
    )
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
      ])
      const result = JSON.parse(
        await bridge.projects_search(JSON.stringify({ query: "Gen 1 QA hold" })),
      ) as { items: Array<{ type?: string; id?: string; projectId?: string }> }
      const hit = result.items.find((i) => i.type === "task" && i.id === task.id)
      expect(hit).toBeTruthy()
      expect(hit?.projectId).toBe(project.id)
    })
  })

  it("search finds a task by its key", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `KeySearchProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const task = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "Findable by key" },
      }),
    )
    const displayKey = `${project.key}-${task.number}`
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
      ])
      const result = JSON.parse(
        await bridge.projects_search(JSON.stringify({ query: displayKey })),
      ) as { items: Array<{ type?: string; id?: string; key?: string }> }
      const hit = result.items.find((i) => i.type === "task" && i.id === task.id)
      expect(hit).toBeTruthy()
      expect(hit?.key).toBe(displayKey)
    })
  })

  it("tasks_byProject due=due_soon excludes terminal and beyond-7-days tasks", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `DueBucketProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const doneStatus = project.statuses.find((s) => s.terminal)!
    const addDays = (days: number): string => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() + days)
      return d.toISOString().slice(0, 10)
    }
    const titleDueSoon = `due-soon-in-3-${Date.now()}`
    const titleLater = `later-in-30-${Date.now()}`
    const titleDoneButDueSoon = `done-but-due-soon-${Date.now()}`
    await withRlsContext(actor, async (tx) => {
      await createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: project.id,
          statusId: openStatus.id,
          title: titleDueSoon,
          dueDate: addDays(3),
        },
      })
      await createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: project.id,
          statusId: openStatus.id,
          title: titleLater,
          dueDate: addDays(30),
        },
      })
      await createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: project.id,
          statusId: doneStatus.id,
          title: titleDoneButDueSoon,
          dueDate: addDays(3),
        },
      })
    })
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
      ])
      const result = JSON.parse(
        await bridge.projects_tasksByProject(
          JSON.stringify({ projectId: project.id, due: "due_soon" }),
        ),
      ) as { items: Array<{ title: string }> }
      const titles = result.items.map((i) => i.title)
      expect(titles).toContain(titleDueSoon)
      expect(titles).not.toContain(titleLater)
      expect(titles).not.toContain(titleDoneButDueSoon)
    })
  })

  it("tasks_byProject due=this_week still works as an alias for due_soon", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `DueAliasProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const addDays = (days: number): string => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() + days)
      return d.toISOString().slice(0, 10)
    }
    const titleDueSoon = `alias-due-soon-${Date.now()}`
    await withRlsContext(actor, async (tx) => {
      await createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: project.id,
          statusId: openStatus.id,
          title: titleDueSoon,
          dueDate: addDays(3),
        },
      })
    })
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
      ])
      const result = JSON.parse(
        await bridge.projects_tasksByProject(
          JSON.stringify({ projectId: project.id, due: "this_week" }),
        ),
      ) as { items: Array<{ title: string }> }
      expect(result.items.map((i) => i.title)).toContain(titleDueSoon)
    })
  })

  it("list rows carry the display key", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `ListKeyProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const title = `List key check ${Date.now()}`
    const task = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title, assigneeId: userId },
      }),
    )
    const expectedKey = `${project.key}-${task.number}`

    // The main per-project list (also the HTTP list route's implementation).
    await withRlsContext(actor, async (tx) => {
      const { items } = await listTasks({ tx, orgId, projectId: project.id })
      const row = items.find((i) => i.id === task.id)
      expect(row?.key).toBe(expectedKey)
      expect(row?.number).toBe(task.number)
    })

    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, [
        "projects:projects:read",
        "projects:tasks:read",
      ])

      // tasks_byProject
      const byProject = JSON.parse(
        await bridge.projects_tasksByProject(JSON.stringify({ projectId: project.id })),
      ) as { items: Array<{ id?: string; key?: string; number?: number }> }
      const byProjectRow = byProject.items.find((i) => i.id === task.id)
      expect(byProjectRow?.key).toBe(expectedKey)
      expect(byProjectRow?.number).toBe(task.number)

      // tasks_byAssignee
      const byAssignee = JSON.parse(
        await bridge.projects_tasksByAssignee(JSON.stringify({ assigneeId: userId })),
      ) as { items: Array<{ id?: string; key?: string; number?: number }> }
      const byAssigneeRow = byAssignee.items.find((i) => i.id === task.id)
      expect(byAssigneeRow?.key).toBe(expectedKey)
      expect(byAssigneeRow?.number).toBe(task.number)

      // search
      const search = JSON.parse(await bridge.projects_search(JSON.stringify({ query: title }))) as {
        items: Array<{ type?: string; id?: string; key?: string }>
      }
      const searchHit = search.items.find((i) => i.type === "task" && i.id === task.id)
      expect(searchHit?.key).toBe(expectedKey)
    })
  })

  it("createTask accepts a task key for parentTaskId", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `ParentKeyProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const parent = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "parent" },
      }),
    )
    const parentKey = `${project.key}-${parent.number}`
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, SCOPES)
      const raw = await bridge.projects_createTask(
        JSON.stringify({ projectId: project.id, title: "child", parentTaskId: parentKey }),
      )
      const result = JSON.parse(raw) as { error?: { message: string }; parentTaskId?: string }
      expect(result.error).toBeUndefined()
      expect(result.parentTaskId).toBe(parent.id)
    })
  })

  it("createTask accepts task keys for beforeTaskId and afterTaskId", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `PositionKeyProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const anchor = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "anchor" },
      }),
    )
    const anchorKey = `${project.key}-${anchor.number}`
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, SCOPES)
      const raw = await bridge.projects_createTask(
        JSON.stringify({
          projectId: project.id,
          title: "after-anchor",
          afterTaskId: anchorKey,
        }),
      )
      const result = JSON.parse(raw) as { error?: { message: string } }
      expect(result.error).toBeUndefined()
    })
  })

  it("moveTask accepts task keys for beforeTaskId and afterTaskId", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `MoveKeyProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const anchor = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "move-anchor" },
      }),
    )
    const mover = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "mover" },
      }),
    )
    const anchorKey = `${project.key}-${anchor.number}`
    const moverKey = `${project.key}-${mover.number}`
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, SCOPES)
      const raw = await bridge.projects_moveTask(
        JSON.stringify({ taskId: moverKey, afterTaskId: anchorKey }),
      )
      const result = JSON.parse(raw) as { error?: { message: string } }
      expect(result.error).toBeUndefined()
    })
  })

  it("mergeTasks accepts task keys for sourceId and targetId", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `MergeKeyProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const source = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "merge-source" },
      }),
    )
    const target = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "merge-target" },
      }),
    )
    const sourceKey = `${project.key}-${source.number}`
    const targetKey = `${project.key}-${target.number}`
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, SCOPES)
      const raw = await bridge.projects_mergeTasks(
        JSON.stringify({ sourceId: sourceKey, targetId: targetKey }),
      )
      const result = JSON.parse(raw) as {
        error?: { message: string }
        merged?: boolean
        sourceId?: string
        targetId?: string
      }
      expect(result.error).toBeUndefined()
      expect(result.merged).toBe(true)
      expect(result.sourceId).toBe(source.id)
      expect(result.targetId).toBe(target.id)
    })
  })

  it("project task counts exclude archived tasks", async () => {
    const project = await withRlsContext(actor, async (tx) =>
      createProject({ tx, orgId, actor, input: { name: `ArchivedCountProj-${Date.now()}` } }),
    )
    const openStatus = project.statuses.find((s) => !s.terminal)!
    const keep = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "keep" },
      }),
    )
    const removed = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: project.id, statusId: openStatus.id, title: "removed" },
      }),
    )
    const child = await withRlsContext(actor, async (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: project.id,
          statusId: openStatus.id,
          title: "child",
          parentTaskId: keep.id,
        },
      }),
    )
    await withRlsContext(actor, async (tx) => deleteTask({ tx, orgId, actor, taskId: removed.id }))

    const list = await withRlsContext(actor, async (tx) => listProjects({ tx, orgId }))
    const summary = list.items.find((p) => p.id === project.id)!
    expect(summary.taskCount).toBe(2) // keep + child, not the archived one

    const projectDetail = await withRlsContext(actor, async (tx) =>
      loadProjectDetail(tx, orgId, project.id),
    )
    expect(projectDetail.taskCount).toBe(2)

    const detail = await withRlsContext(actor, async (tx) =>
      getTask({ tx, orgId, taskId: keep.id }),
    )
    expect(detail.childCount).toBe(1)

    await withRlsContext(actor, async (tx) => deleteTask({ tx, orgId, actor, taskId: child.id }))
    const detailAfterChildRemoved = await withRlsContext(actor, async (tx) =>
      getTask({ tx, orgId, taskId: keep.id }),
    )
    expect(detailAfterChildRemoved.childCount).toBe(0)
  })
})
