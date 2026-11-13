// SPDX-License-Identifier: FSL-1.1-ALv2
// projects:task created / updated / moved events carry the full task row as the
// detail loader returns it AFTER the write, so a live client can merge it
// without a refetch: the resolved statusId (even from a statusLabel input), the
// display key, number, position, completedAt. Before, `updated` echoed the raw
// input (a statusLabel and no statusId, no key) and `created` / `moved` carried
// a handful of ids, so open boards rendered stale or keyless rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { createLabel } from "~/apps/projects/service/labels"
import { moveTask } from "~/apps/projects/service/move-task"
import { migrateStatusTasks } from "~/apps/projects/service/statuses"
import { createTask, updateTask } from "~/apps/projects/service/tasks"
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
  "projects:labels:admin",
]

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-evt-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Event Payload Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`evt-${Date.now()}@test.com`}, 'Event Tester', 'active', 'hash', 1, 1)
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

async function makeProject(name: string) {
  return withRlsContext(actor, async (tx) => {
    const r = await createProject({ tx, orgId, actor, input: { name } })
    const byLabel = (label: string) => r.statuses.find((s) => s.label === label)!.id
    return {
      projectId: r.id,
      key: r.key,
      todo: byLabel("todo"),
      inProgress: byLabel("in_progress"),
      done: byLabel("done"),
    }
  })
}

type Payload = Record<string, unknown>

async function lastTaskEvent(taskId: string, action: string): Promise<Payload> {
  const rows = extractRows<{ data: Payload }>(
    await db.execute(drizzleSql`
      SELECT payload->'data' AS data FROM kernel.pending_events
      WHERE payload->>'entityId' = ${taskId} AND payload->>'entity' = 'task'
        AND payload->>'action' = ${action}
      ORDER BY seq DESC
      LIMIT 1
    `),
  )
  expect(rows.length).toBe(1)
  return rows[0]!.data
}

async function makeTask(projectId: string, statusId: string, title: string) {
  return withRlsContext(actor, (tx) =>
    createTask({ tx, orgId, actor, input: { projectId, statusId, title } }),
  )
}

describe("projects:task event payloads carry the full row", () => {
  it("created carries the key, number and position", async () => {
    const p = await makeProject("evt-create")
    const task = await makeTask(p.projectId, p.todo, "first")
    const data = await lastTaskEvent(task.id, "created")
    expect(data.key).toBe(`${p.key}-${task.number}`)
    expect(data.number).toBe(task.number)
    expect(data.position).toBe(task.position)
    expect(data.statusId).toBe(p.todo)
    expect(data.projectId).toBe(p.projectId)
    expect(data.updatedAt).toBe(task.updatedAt)
  })

  it("updated with a statusLabel carries the resolved statusId, key and completedAt", async () => {
    const p = await makeProject("evt-update")
    const task = await makeTask(p.projectId, p.todo, "label me")
    await withRlsContext(actor, (tx) =>
      updateTask({ tx, orgId, actor, taskId: task.id, input: { statusLabel: "done" } }),
    )
    const data = await lastTaskEvent(task.id, "updated")
    expect(data.statusId).toBe(p.done)
    expect(data.key).toBe(`${p.key}-${task.number}`)
    expect(data.number).toBe(task.number)
    expect(typeof data.completedAt).toBe("string")
    expect(data.priority).toBe("normal")
    expect(data.projectId).toBe(p.projectId)
    // What changed, in the input vocabulary: the resolved status, with the one it left.
    expect(data.changedFields).toEqual(["statusId"])
    expect(data.fromStatusId).toBe(p.todo)
    expect(data.toStatusId).toBe(p.done)
  })

  it("a same-project move carries the full row after the write", async () => {
    const p = await makeProject("evt-move")
    const task = await makeTask(p.projectId, p.todo, "move me")
    const moved = await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId: task.id, statusId: p.done }),
    )
    const data = await lastTaskEvent(task.id, "moved")
    expect(data.statusId).toBe(p.done)
    expect(data.position).toBe(moved.position)
    expect(data.key).toBe(`${p.key}-${task.number}`)
    expect(data.title).toBe("move me")
    expect(data.completedAt).toBe(moved.completedAt)
    expect(typeof data.completedAt).toBe("string")
    expect(data.fromProjectId).toBeUndefined()
  })

  it("a cross-project move carries the new key and fromProjectId", async () => {
    const src = await makeProject("evt-xsrc")
    const dest = await makeProject("evt-xdest")
    const task = await makeTask(src.projectId, src.todo, "travel")
    const moved = await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId: task.id, targetProjectId: dest.projectId }),
    )
    const data = await lastTaskEvent(task.id, "moved")
    expect(data.projectId).toBe(dest.projectId)
    expect(data.fromProjectId).toBe(src.projectId)
    expect(data.key).toBe(`${dest.key}-${moved.number}`)
    expect(data.title).toBe("travel")
  })

  it("a bulk status migration emits one full row per moved task", async () => {
    const p = await makeProject("evt-migrate")
    const a = await makeTask(p.projectId, p.inProgress, "a")
    const b = await makeTask(p.projectId, p.inProgress, "b")
    await withRlsContext(actor, (tx) =>
      migrateStatusTasks({
        tx,
        orgId,
        projectId: p.projectId,
        sourceStatusId: p.inProgress,
        targetStatusId: p.done,
        actor,
      }),
    )
    for (const t of [a, b]) {
      const data = await lastTaskEvent(t.id, "moved")
      expect(data.statusId).toBe(p.done)
      expect(data.key).toBe(`${p.key}-${t.number}`)
      expect(data.title).toBe(t.title)
      expect(typeof data.completedAt).toBe("string")
    }
  })
})

describe("projects:task event payloads carry labels", () => {
  async function seedNature() {
    return withRlsContext(actor, async (tx) => {
      const g = await createLabel({ tx, orgId, actor, input: { name: `Nature ${Date.now()}` } })
      const bug = await createLabel({ tx, orgId, actor, input: { name: "bug", parentId: g.id } })
      const evo = await createLabel({
        tx,
        orgId,
        actor,
        input: { name: "evolution", parentId: g.id },
      })
      return { g, bug, evo }
    })
  }

  it("updated carries the labels and lists them in changedFields; a labels-only update moves updatedAt", async () => {
    const n = await seedNature()
    const p = await makeProject("evt-labels")
    const task = await makeTask(p.projectId, p.todo, "labelled")
    await withRlsContext(actor, (tx) =>
      updateTask({ tx, orgId, actor, taskId: task.id, input: { labels: { [n.g.id]: "bug" } } }),
    )
    const first = await lastTaskEvent(task.id, "updated")
    expect(first.changedFields).toEqual(["labels"])
    expect(first.labels).toEqual([
      expect.objectContaining({ groupId: n.g.id, valueId: n.bug.id, inherited: false }),
    ])
    const start = Date.now()
    while (Date.now() === start) await Bun.sleep(1)
    await withRlsContext(actor, (tx) =>
      updateTask({
        tx,
        orgId,
        actor,
        taskId: task.id,
        input: { labels: { [n.g.id]: "evolution" } },
      }),
    )
    const second = await lastTaskEvent(task.id, "updated")
    expect(new Date(second.updatedAt as string).getTime()).toBeGreaterThan(
      new Date(first.updatedAt as string).getTime(),
    )
    expect((second.labels as Array<{ valueId: string }>)[0]!.valueId).toBe(n.evo.id)
  })

  it("created carries the labels it was created with", async () => {
    const n = await seedNature()
    const p = await makeProject("evt-labels-create")
    const task = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: p.projectId,
          statusId: p.todo,
          title: "born labelled",
          labels: { [n.g.id]: "bug" },
        },
      }),
    )
    const data = await lastTaskEvent(task.id, "created")
    expect(data.labels).toEqual([expect.objectContaining({ groupId: n.g.id, valueId: n.bug.id })])
  })
})
