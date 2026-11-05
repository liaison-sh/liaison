// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task labels as an agent meets them, through the real dispatch
// (manifest -> sandbox handler -> rpc bridge -> service): the taxonomy tools,
// `labels` on create/update/get/search/tasks_byProject, the completion window,
// the bulk setLabels action, typed refusals (never `tool_error`) carrying the
// valid values in the MESSAGE (details never reach an agent), and the
// settings tree round trip through the bridge.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { runBulkDispatch } from "~/modules/apps/bulk-dispatch"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Hermetic copy of execute-tool (a neighbouring file mock.module()s it; see
// service/assignee-name-enrichment.test.ts for the full story).
const { executeTool, executeToolCore } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-labels-tools`
)) as typeof import("~/modules/apps/execute-tool")

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:labels:admin",
  "kernel:threads:write",
  "kernel:threads:read",
]

let orgId: string
let userId: string
let actor: UserContext
let member: UserContext

type Result = { data?: any; error?: { code?: string; message?: string; status?: number } }

/** executeTool answers a tool error by throwing an Error that carries status and code. */
async function run(tool: string, params: Record<string, unknown>, as = actor): Promise<Result> {
  try {
    return (await executeTool({
      toolName: `projects:${tool}`,
      orgId,
      actor: as as ActorContext,
      origin: "mcp",
      params,
    })) as Result
  } catch (err) {
    const e = err as { code?: string; message?: string; status?: number }
    return { error: { code: e.code, message: e.message, status: e.status } }
  }
}

async function ok(tool: string, params: Record<string, unknown>): Promise<any> {
  const out = await run(tool, params)
  expect(out.error).toBeUndefined()
  return out.data
}

interface Board {
  projectId: string
  openStatusId: string
  doneStatusId: string
}

async function makeBoard(): Promise<Board> {
  const project = await ok("createProject", { name: `labels-tools-${randomUUID().slice(0, 8)}` })
  return {
    projectId: project.id,
    openStatusId: project.statuses.find((s: { terminal: boolean }) => !s.terminal).id,
    doneStatusId: project.statuses.find((s: { terminal: boolean }) => s.terminal).id,
  }
}

async function makeTask(board: Board, title: string, parentTaskId?: string): Promise<string> {
  const task = await withRlsContext(actor, (tx) =>
    createTask({
      tx,
      orgId,
      actor,
      input: { projectId: board.projectId, statusId: board.openStatusId, title, parentTaskId },
    }),
  )
  return task.id
}

async function taskRow(id: string) {
  const [r] = extractRows<{ title: string; parent_task_id: string | null }>(
    await db.execute(
      drizzleSql`SELECT title, parent_task_id FROM app_projects.tasks WHERE id = ${id}::uuid`,
    ),
  )
  return r!
}

async function ownLabelCount(taskId: string): Promise<number> {
  const [r] = extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT count(*)::int AS n FROM app_projects.task_labels WHERE task_id = ${taskId}::uuid`,
    ),
  )
  return r!.n
}

let nature: { id: string; values: Record<string, string> }

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Labels Tools Org', ${`labels-tools-${Date.now()}-${Math.random()}`})
      RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`labels-tools-${Date.now()}@test.com`}, 'Label Tools', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user!.id
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
  member = { ...actor, scopes: SCOPES.filter((s) => s !== "projects:labels:admin") }
  await ensureAppsForOrg(orgId, {})
  const group = await ok("labels.create", { name: "Nature" })
  const values: Record<string, string> = {}
  for (const v of ["bug", "evolution", "maintenance", "support"]) {
    values[v] = (await ok("labels.create", { name: v, parentId: group.id })).id
  }
  nature = { id: group.id, values }
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("labels taxonomy tools", () => {
  it("create, rename, archive, restore and list round trip; member is refused", async () => {
    const g = await ok("labels.create", { name: "Domain" })
    const v = await ok("labels.create", { name: "enrichment", parentId: g.id })
    expect(v.parentId).toBe(g.id)
    expect((await ok("labels.update", { id: v.id, name: "Enrichment" })).name).toBe("Enrichment")
    await ok("labels.archive", { id: v.id })
    const live = await ok("labels.list", {})
    const domain = live.groups.find((x: { id: string }) => x.id === g.id)
    expect(domain.values).toEqual([])
    await ok("labels.archive", { id: v.id, archived: false })
    const after = await ok("labels.list", { includeArchived: true })
    expect(
      after.groups.find((x: { id: string }) => x.id === g.id).values.map((x: any) => x.name),
    ).toEqual(["Enrichment"])
  })

  it("every taxonomy write refuses a caller without projects:labels:admin", async () => {
    const forbidden = { code: "forbidden", status: 403 }
    const created = await run("labels.create", { name: "Team" }, member)
    expect(created.data).toBeUndefined()
    expect(created.error).toMatchObject(forbidden)
    const renamed = await run("labels.update", { id: nature.values.bug!, name: "Bug" }, member)
    expect(renamed.error).toMatchObject(forbidden)
    const archived = await run("labels.archive", { id: nature.values.bug! }, member)
    expect(archived.error).toMatchObject(forbidden)
    const reordered = await withRlsContext(member, async (tx) => {
      const scopes = member.scopes ?? []
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, scopes)
      const tree = JSON.parse(await bridge.projects_labelsTree("{}"))
      return JSON.parse(
        await bridge.projects_labelsReorder(
          JSON.stringify({ baseVersion: tree.version, nodes: [] }),
        ),
      )
    })
    expect(reordered.error).toMatchObject(forbidden)
    const list = await ok("labels.list", {})
    const group = list.groups.find((g: { id: string }) => g.id === nature.id)
    expect(group.values.map((v: { name: string }) => v.name)).toContain("bug")
  })

  it("keeps the typed envelope on taxonomy refusals", async () => {
    const dup = await run("labels.create", { name: "bug", parentId: nature.id })
    expect(dup.error).toMatchObject({ code: "name_exists", status: 400 })
    const other = await ok("labels.create", { name: `Other ${randomUUID().slice(0, 6)}` })
    const move = await run("labels.update", { id: nature.values.bug!, parentId: other.id })
    expect(move.error?.code).toBe("invalid_params")
  })
})

describe("the probe read path through tasks_byProject", () => {
  it("forwards the completion window: after inclusive, before exclusive, garbage refused", async () => {
    const board = await makeBoard()
    const done = await makeTask(board, "done")
    await ok("update", { taskId: done, labels: { Nature: "bug" }, statusId: board.doneStatusId })
    // Pin the completion instant so the bounds can be hit exactly.
    const at = "2026-10-05T10:00:00.000Z"
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET completed_at = ${at}::timestamptz WHERE id = ${done}::uuid`,
    )
    const count = async (window: Record<string, string>) =>
      (
        await ok("tasks_byProject", {
          projectId: board.projectId,
          terminal: true,
          labels: { Nature: "bug" },
          countOnly: true,
          ...window,
        })
      ).totalCount
    expect(await count({})).toBe(1)
    expect(await count({ completedAfter: at })).toBe(1)
    expect(await count({ completedAfter: "2026-10-05T10:00:00.001Z" })).toBe(0)
    expect(await count({ completedBefore: at })).toBe(0)
    expect(await count({ completedBefore: "2026-10-05T10:00:00.001Z" })).toBe(1)
    expect(
      await count({
        completedAfter: "2026-10-05T00:00:00Z",
        completedBefore: "2026-10-12T00:00:00Z",
      }),
    ).toBe(1)
    expect(
      await count({
        completedAfter: "2026-10-12T00:00:00Z",
        completedBefore: "2026-10-19T00:00:00Z",
      }),
    ).toBe(0)
    const bad = await run("tasks_byProject", {
      projectId: board.projectId,
      completedAfter: "last tuesday",
      countOnly: true,
    })
    expect(bad.error).toMatchObject({ code: "invalid_params", status: 400 })
    expect(bad.error?.message).toContain("completedAfter")
  })
})

describe("labels on task tools", () => {
  it("create takes labels; an archived value is a typed label_archived listing the live values", async () => {
    const board = await makeBoard()
    const created = await ok("create", {
      projectId: board.projectId,
      title: "born labelled",
      labels: { nature: "EVOLUTION" },
    })
    expect(created.labels).toEqual([
      expect.objectContaining({ groupId: nature.id, valueId: nature.values.evolution }),
    ])
    expect(await ownLabelCount(created.id)).toBe(1)

    const old = await ok("labels.create", {
      name: `old-${randomUUID().slice(0, 6)}`,
      parentId: nature.id,
    })
    await ok("labels.archive", { id: old.id })
    const refused = await run("create", {
      projectId: board.projectId,
      title: "never created",
      labels: { Nature: old.id },
    })
    expect(refused.error).toMatchObject({ code: "label_archived", status: 409 })
    expect(refused.error?.message).toContain("Valid values: bug, evolution, maintenance, support")
    const listed = await ok("tasks_byProject", { projectId: board.projectId })
    expect(listed.items.map((t: { title: string }) => t.title)).toEqual(["born labelled"])
  })

  it("tasks_byAssignee carries each task's labels", async () => {
    const board = await makeBoard()
    const taskId = await makeTask(board, "mine")
    await ok("update", { taskId, assigneeId: userId, labels: { Nature: "maintenance" } })
    const mine = await ok("tasks_byAssignee", { assigneeId: userId })
    const row = mine.items.find((t: { id: string }) => t.id === taskId)
    expect(row.labels).toEqual([
      expect.objectContaining({
        groupId: nature.id,
        valueId: nature.values.maintenance,
        valueName: "maintenance",
        inherited: false,
      }),
    ])
  })

  it("update sets a label; an invalid value is a typed label_not_found listing the valid values", async () => {
    const board = await makeBoard()
    const taskId = await makeTask(board, "label me")
    const out = await ok("update", { taskId, labels: { Nature: "bug" } })
    expect(out.labels).toEqual([
      expect.objectContaining({ groupId: nature.id, valueId: nature.values.bug, inherited: false }),
    ])
    const bad = await run("update", { taskId, title: "changed", labels: { Nature: "nope" } })
    expect(bad.error?.code).toBe("label_not_found")
    expect(bad.error?.message).toContain("Valid values: bug, evolution, maintenance, support")
    expect((await taskRow(taskId)).title).toBe("label me")
  })

  it("tasks_byProject filters by labels and counts a completion window", async () => {
    const board = await makeBoard()
    const a = await makeTask(board, "a")
    const b = await makeTask(board, "b")
    await ok("update", { taskId: a, labels: { Nature: "bug" }, statusId: board.doneStatusId })
    await ok("update", { taskId: b, labels: { Nature: "evolution" } })
    const listed = await ok("tasks_byProject", {
      projectId: board.projectId,
      labels: { Nature: "bug" },
    })
    expect(listed.items.map((t: { id: string }) => t.id)).toEqual([a])
    expect(listed.items[0].labels[0].valueName).toBe("bug")
    const now = Date.now()
    const counted = await ok("tasks_byProject", {
      projectId: board.projectId,
      terminal: true,
      labels: { Nature: "bug" },
      completedAfter: new Date(now - 3_600_000).toISOString(),
      completedBefore: new Date(now + 3_600_000).toISOString(),
      countOnly: true,
    })
    expect(counted.totalCount).toBe(1)
    const unknown = await run("tasks_byProject", {
      projectId: board.projectId,
      labels: { Nature: "nope" },
    })
    expect(unknown.error?.code).toBe("label_not_found")
    expect(unknown.error?.message).toContain("Valid values: bug, evolution, maintenance, support")
  })

  it("get and search carry labels", async () => {
    const board = await makeBoard()
    const title = `findable-${randomUUID().slice(0, 8)}`
    const taskId = await makeTask(board, title)
    await ok("update", { taskId, labels: { Nature: "support" } })
    const got = await ok("get", { taskId })
    expect(got.labels.map((l: { valueName: string }) => l.valueName)).toEqual(["support"])
    const found = await ok("search", { query: title })
    const hit = found.items.find(
      (i: { type: string; id: string }) => i.type === "task" && i.id === taskId,
    )
    expect(hit.labels.map((l: { valueName: string }) => l.valueName)).toEqual(["support"])
  })

  it("bulk setLabels sets every item; an invalid value fails every item and changes nothing", async () => {
    const board = await makeBoard()
    const ids = [await makeTask(board, "b1"), await makeTask(board, "b2")]
    const deps = { dispatch: executeToolCore, ensureOriginThread: async () => undefined }
    const res = await runBulkDispatch(
      {
        app: "projects",
        action: "setLabels",
        ids,
        params: { labels: { Nature: "bug" } },
        idempotencyKey: randomUUID(),
        actor,
        origin: "mcp",
      },
      deps,
    )
    expect(res.succeeded).toBe(2)
    for (const id of ids) {
      expect((await ok("get", { taskId: id })).labels[0].valueId).toBe(nature.values.bug)
    }
    const fresh = [await makeTask(board, "c1"), await makeTask(board, "c2")]
    const bad = await runBulkDispatch(
      {
        app: "projects",
        action: "setLabels",
        ids: fresh,
        params: { labels: { Nature: "nope" } },
        idempotencyKey: randomUUID(),
        actor,
        origin: "mcp",
      },
      deps,
    )
    expect(bad.failed).toBe(fresh.length)
    for (const [i, id] of fresh.entries()) {
      expect(bad.errors[i]).toMatchObject({ id, code: "label_not_found" })
      expect(await ownLabelCount(id)).toBe(0)
    }
  }, 30_000)

  it("a refused label rolls back a re-parent done in the same bridge update", async () => {
    // The `update` tool schema does not take parentTaskId (agents re-parent
    // with `move`), but the bridge method does: it moves first, then edits, in
    // one savepoint, so a label refusal must undo the move too.
    const board = await makeBoard()
    const parent = await makeTask(board, "parent")
    const taskId = await makeTask(board, "child-to-be")
    const out = await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, SCOPES)
      return JSON.parse(
        await bridge.projects_updateTask(
          JSON.stringify({ taskId, parentTaskId: parent, labels: { Nature: "nope" } }),
        ),
      )
    })
    expect(out.error?.code).toBe("label_not_found")
    expect(out.error?.message).toContain("Valid values: bug, evolution, maintenance, support")
    expect((await taskRow(taskId)).parent_task_id).toBeNull()
  })
})

describe("labels settings tree through the bridge", () => {
  it("round-trips the version and answers typed envelopes", async () => {
    await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge("projects", userId, orgId, tx, { name: "projects" }, SCOPES)
      const tree = JSON.parse(await bridge.projects_labelsTree("{}"))
      expect(Array.isArray(tree.rows)).toBe(true)
      expect(typeof tree.version).toBe("string")
      const first = JSON.parse(
        await bridge.projects_labelsReorder(
          JSON.stringify({
            baseVersion: tree.version,
            nodes: [
              {
                tempId: "g",
                parentId: null,
                name: `Team ${randomUUID().slice(0, 6)}`,
                sortOrder: 9,
              },
            ],
          }),
        ),
      )
      expect(first.error).toBeUndefined()
      expect(first.version).not.toBe(tree.version)
      const second = JSON.parse(
        await bridge.projects_labelsReorder(
          JSON.stringify({
            baseVersion: first.version,
            nodes: [
              {
                tempId: "h",
                parentId: null,
                name: `Squad ${randomUUID().slice(0, 6)}`,
                sortOrder: 10,
              },
            ],
          }),
        ),
      )
      expect(second.error).toBeUndefined()
      const stale = JSON.parse(
        await bridge.projects_labelsReorder(
          JSON.stringify({ baseVersion: tree.version, nodes: [] }),
        ),
      )
      expect(stale.error).toMatchObject({ code: "conflict", status: 409 })
      const dup = JSON.parse(
        await bridge.projects_labelsReorder(
          JSON.stringify({
            baseVersion: second.version,
            nodes: [
              { tempId: "x", parentId: nature.id, name: "twin", sortOrder: 20 },
              { tempId: "y", parentId: nature.id, name: "Twin", sortOrder: 21 },
            ],
          }),
        ),
      )
      expect(dup.error).toMatchObject({ code: "name_exists", status: 400 })
    })
  })
})
