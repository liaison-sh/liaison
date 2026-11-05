// SPDX-License-Identifier: FSL-1.1-ALv2
// Spec D13, D14, D11: the checklist never blocks a status change, for humans or
// agents, on any path (updateTask, moveTask in project, cross project and
// subtree, bulk setStatus, column terminal flip, status migration). An agent
// (bridge origin other than human-ui) that puts a task with an incomplete
// checklist into a terminal status gets `checklistWarning` in the result.
// Items are inserted directly.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { moveTask } from "~/apps/projects/service/move-task"
import { migrateStatusTasks, updateStatus } from "~/apps/projects/service/statuses"
import { createTask, updateTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { runBulkDispatch } from "~/modules/apps/bulk-dispatch"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Hermetic copy of execute-tool (a neighbouring file mock.module()s it; see
// assignee-name-enrichment.test.ts for the full story).
const { executeToolCore } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-checklist-guard`
)) as typeof import("~/modules/apps/execute-tool")

let orgId: string
let userId: string
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

interface Env {
  projectId: string
  openStatusId: string
  doneStatusId: string
  levels: { id: string; name: string }[]
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Checklist Guard Org', ${`checklist-guard-${Date.now()}-${Math.random()}`})
      RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`guard-${Date.now()}@test.com`}, 'Guard Tester', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user!.id
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
})

afterAll(async () => {
  await releaseTestLock()
})

async function makeProject(
  levelNames: string[],
  statuses?: { label: string; terminal?: boolean }[],
): Promise<Env> {
  const p = await withRlsContext(actor, (tx) =>
    createProject({
      tx,
      orgId,
      actor,
      input: { name: `guard-${randomUUID().slice(0, 8)}`, ...(statuses ? { statuses } : {}) },
    }),
  )
  const levels = levelNames.map((name) => ({ id: randomUUID(), name }))
  await db.execute(drizzleSql`
    UPDATE app_projects.projects SET validation_levels = ${JSON.stringify(levels)}::jsonb
    WHERE id = ${p.id}::uuid
  `)
  return {
    projectId: p.id,
    openStatusId: (p.statuses.find((s) => !s.terminal) ?? p.statuses[0]!).id,
    doneStatusId: p.statuses.find((s) => s.terminal)!.id,
    levels,
  }
}

async function makeTask(
  env: Env,
  title: string,
  opts: { parentTaskId?: string; statusId?: string } = {},
): Promise<string> {
  const t = await withRlsContext(actor, (tx) =>
    createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId: env.projectId,
        statusId: opts.statusId ?? env.openStatusId,
        title,
        ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}),
      },
    }),
  )
  return t.id
}

type State = "success" | "fail" | "na" | "not_done"

async function addItem(
  taskId: string,
  title: string,
  states: Record<string, State> = {},
  checked = false,
  via: "human" | "agent" = "human",
): Promise<string> {
  const validations: Record<string, unknown> = {}
  for (const [levelId, state] of Object.entries(states)) {
    validations[levelId] = {
      state,
      by: userId,
      via,
      source: null,
      at: "2026-09-25T00:00:00Z",
    }
  }
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_projects.task_checklist_items (org_id, task_id, title, checked, validations, created_by)
      VALUES (${orgId}::uuid, ${taskId}::uuid, ${title}, ${checked}, ${JSON.stringify(validations)}::jsonb, ${userId}::uuid)
      RETURNING id
    `),
  )
  return row!.id
}

/** Every level of `env` in success. */
function allSuccess(env: Env): Record<string, State> {
  return Object.fromEntries(env.levels.map((l) => [l.id, "success" as State]))
}

async function taskRow(taskId: string) {
  const [row] = extractRows<{
    project_id: string
    status_id: string
    position: number
    completed_at: string | null
    updated_at: string
  }>(
    await db.execute(drizzleSql`
      SELECT project_id, status_id, position, completed_at, updated_at::text AS updated_at
      FROM app_projects.tasks WHERE id = ${taskId}::uuid
    `),
  )
  return row!
}

async function statusTerminal(statusId: string): Promise<boolean> {
  const [row] = extractRows<{ terminal: boolean }>(
    await db.execute(drizzleSql`
      SELECT terminal FROM app_projects.project_statuses WHERE id = ${statusId}::uuid
    `),
  )
  return row!.terminal
}

describe("checklist never blocks: updateTask and moveTask", () => {
  it("a human moves an incomplete checklist task to Done with updateTask", async () => {
    const env = await makeProject(["AI", "Dev"])
    const taskId = await makeTask(env, "incomplete")
    await addItem(taskId, "ok item", allSuccess(env))
    await addItem(taskId, "bad item", { [env.levels[0]!.id]: "fail" })
    const out = await withRlsContext(actor, (tx) =>
      updateTask({ tx, orgId, actor, taskId, input: { statusId: env.doneStatusId } }),
    )
    expect(out.statusId).toBe(env.doneStatusId)
    expect(out.completedAt).toBeTruthy()
  })

  it("plain mode: an unchecked item does not block Done", async () => {
    const env = await makeProject([])
    const taskId = await makeTask(env, "plain")
    await addItem(taskId, "unchecked", {}, false)
    const out = await withRlsContext(actor, (tx) =>
      updateTask({ tx, orgId, actor, taskId, input: { statusId: env.doneStatusId } }),
    )
    expect(out.statusId).toBe(env.doneStatusId)
  })

  it("an in-project move to Done succeeds with an incomplete checklist", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "move incomplete")
    await addItem(taskId, "pending")
    await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId, statusId: env.doneStatusId }),
    )
    expect((await taskRow(taskId)).status_id).toBe(env.doneStatusId)
  })

  it("a cross-project move into a terminal column succeeds, subtree included", async () => {
    const src = await makeProject(["AI"])
    // Only a terminal column: every open node of the subtree falls back to it.
    const dest = await makeProject(["AI"], [{ label: "Shipped", terminal: true }])
    const parentId = await makeTask(src, "root incomplete")
    const childId = await makeTask(src, "child incomplete", { parentTaskId: parentId })
    await addItem(parentId, "root pending")
    await addItem(childId, "child pending")
    await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId: parentId, targetProjectId: dest.projectId }),
    )
    for (const id of [parentId, childId]) {
      const row = await taskRow(id)
      expect(row.project_id).toBe(dest.projectId)
      expect(row.status_id).toBe(dest.doneStatusId)
    }
  })

  it("maps validations by level name, case-insensitively, dropping unmatched keys (D11)", async () => {
    const src = await makeProject(["AI", "Dev"])
    const dest = await makeProject(["ai", "Beta"])
    const taskId = await makeTask(src, "xmove mapping")
    const itemId = await addItem(taskId, "mapped", {
      [src.levels[0]!.id]: "success",
      [src.levels[1]!.id]: "fail",
    })
    await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId, targetProjectId: dest.projectId }),
    )
    const [row] = extractRows<{ validations: Record<string, { state: string }> }>(
      await db.execute(drizzleSql`
        SELECT validations FROM app_projects.task_checklist_items WHERE id = ${itemId}::uuid
      `),
    )
    expect(Object.keys(row!.validations)).toEqual([dest.levels[0]!.id])
    expect(row!.validations[dest.levels[0]!.id]!.state).toBe("success")
    expect((await taskRow(taskId)).project_id).toBe(dest.projectId)
  })
})

describe("checklist never blocks: columns", () => {
  it("flipping a column to terminal succeeds while it holds an incomplete checklist task", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "in column")
    await addItem(taskId, "pending")
    const out = await withRlsContext(actor, (tx) =>
      updateStatus({
        tx,
        orgId,
        projectId: env.projectId,
        statusId: env.openStatusId,
        actor,
        patch: { terminal: true },
      }),
    )
    expect(out.terminal).toBe(true)
    expect(await statusTerminal(env.openStatusId)).toBe(true)
    expect((await taskRow(taskId)).status_id).toBe(env.openStatusId)
  })

  it("flipping a column terminal stamps completed_at on its tasks; flipping it back clears it", async () => {
    const env = await makeProject([])
    const a = await makeTask(env, "flip a")
    const b = await makeTask(env, "flip b")
    const flip = (terminal: boolean) =>
      withRlsContext(actor, (tx) =>
        updateStatus({
          tx,
          orgId,
          projectId: env.projectId,
          statusId: env.openStatusId,
          actor,
          patch: { terminal },
        }),
      )
    expect((await taskRow(a)).completed_at).toBeNull()
    await flip(true)
    const stampedA = (await taskRow(a)).completed_at
    expect(stampedA).toBeTruthy()
    expect((await taskRow(b)).completed_at).toBeTruthy()
    // A terminal patch that does not change the value leaves the stamp alone.
    await flip(true)
    expect((await taskRow(a)).completed_at).toBe(stampedA)
    await flip(false)
    expect((await taskRow(a)).completed_at).toBeNull()
    expect((await taskRow(b)).completed_at).toBeNull()
  })

  it("a status migration into a terminal column moves every task, incomplete ones included", async () => {
    const env = await makeProject(["AI"])
    const completeId = await makeTask(env, "complete")
    await addItem(completeId, "done", allSuccess(env))
    const incompleteId = await makeTask(env, "incomplete")
    await addItem(incompleteId, "pending")
    const bareId = await makeTask(env, "no items")
    const out = await withRlsContext(actor, (tx) =>
      migrateStatusTasks({
        tx,
        orgId,
        projectId: env.projectId,
        sourceStatusId: env.openStatusId,
        targetStatusId: env.doneStatusId,
        actor,
      }),
    )
    expect(out.movedCount).toBe(3)
    for (const id of [completeId, incompleteId, bareId]) {
      expect((await taskRow(id)).status_id).toBe(env.doneStatusId)
    }
  })
})

describe("checklist never blocks: bulk setStatus", () => {
  it("moves all 10 tasks, 3 of them with an incomplete checklist", async () => {
    await ensureAppsForOrg(orgId, {})
    const env = await makeProject(["AI"])
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const id = await makeTask(env, `bulk ${i}`)
      ids.push(id)
      if (i % 3 === 0) await addItem(id, `pending ${i}`)
      else if (i % 2 === 0) await addItem(id, `done ${i}`, allSuccess(env))
    }
    const res = await runBulkDispatch(
      {
        app: "projects",
        action: "setStatus",
        ids,
        params: { statusId: env.doneStatusId },
        idempotencyKey: randomUUID(),
        actor,
        origin: "human-ui",
      },
      { dispatch: executeToolCore, ensureOriginThread: async () => undefined },
    )
    expect(res.failed).toBe(0)
    expect(res.succeeded).toBe(10)
    for (const id of ids) expect((await taskRow(id)).status_id).toBe(env.doneStatusId)
  }, 30_000)
})

describe("checklistWarning on an agent's bulk move", () => {
  it("only the task entering terminal with an incomplete checklist carries the warning", async () => {
    await ensureAppsForOrg(orgId, {})
    const env = await makeProject(["AI"])
    const incomplete = await makeTask(env, "bulk agent incomplete")
    const pending = await addItem(incomplete, "pending")
    const complete = await makeTask(env, "bulk agent complete")
    await addItem(complete, "done", allSuccess(env))
    const bare = await makeTask(env, "bulk agent bare")
    const res = await runBulkDispatch(
      {
        app: "projects",
        action: "move",
        ids: [incomplete, complete, bare],
        params: { statusId: env.doneStatusId },
        idempotencyKey: randomUUID(),
        actor,
        origin: "mcp",
      },
      { dispatch: executeToolCore, ensureOriginThread: async () => undefined },
    )
    expect(res.failed).toBe(0)
    expect(res.succeeded).toBe(3)
    const byId = new Map(res.items.map((i) => [i.id, i]))
    const warning = byId.get(incomplete)!.checklistWarning as {
      message: string
      status: { blocking: unknown[] }
    }
    expect(typeof warning.message).toBe("string")
    expect(warning.status.blocking).toEqual([{ itemId: pending, title: "pending", levels: ["AI"] }])
    expect(byId.get(complete)!.checklistWarning).toBeUndefined()
    expect(byId.get(bare)!.checklistWarning).toBeUndefined()
    for (const id of [incomplete, complete, bare]) {
      expect((await taskRow(id)).status_id).toBe(env.doneStatusId)
    }
  }, 30_000)
})

describe("checklistWarning on an agent's terminal move (D14)", () => {
  type Origin = "mcp" | "human-ui" | "in-app-agent"
  function bridgeFor(tx: unknown, origin?: Origin) {
    return createRpcBridge(
      "projects",
      userId,
      orgId,
      tx as never,
      { name: "projects" },
      SCOPES,
      "user",
      undefined,
      origin ? { origin } : undefined,
    )
  }
  async function bridgeUpdate(taskId: string, statusId: string, origin?: Origin) {
    return withRlsContext(actor, async (tx) =>
      JSON.parse(
        await bridgeFor(tx, origin).projects_updateTask(JSON.stringify({ taskId, statusId })),
      ),
    )
  }
  async function bridgeMove(taskId: string, statusId: string, origin?: Origin) {
    return withRlsContext(actor, async (tx) =>
      JSON.parse(
        await bridgeFor(tx, origin).projects_moveTask(JSON.stringify({ taskId, statusId })),
      ),
    )
  }

  it("an mcp agent's update to Done succeeds and carries the blocking items", async () => {
    const env = await makeProject(["AI", "Dev"])
    const taskId = await makeTask(env, "agent done")
    await addItem(taskId, "proven", allSuccess(env))
    const bad = await addItem(taskId, "not proven", { [env.levels[0]!.id]: "success" })
    const out = await bridgeUpdate(taskId, env.doneStatusId, "mcp")
    expect((await taskRow(taskId)).status_id).toBe(env.doneStatusId)
    expect(out.statusId).toBe(env.doneStatusId)
    expect(typeof out.checklistWarning.message).toBe("string")
    expect(out.checklistWarning.status.total).toBe(2)
    expect(out.checklistWarning.status.complete).toBe(1)
    expect(out.checklistWarning.status.blocking).toEqual([
      { itemId: bad, title: "not proven", levels: ["Dev"] },
    ])
  })

  it("an in-app agent's move to Done carries the warning; a missing origin counts as an agent", async () => {
    const env = await makeProject([])
    const moved = await makeTask(env, "agent move")
    const unchecked = await addItem(moved, "unchecked")
    const out = await bridgeMove(moved, env.doneStatusId, "in-app-agent")
    expect((await taskRow(moved)).status_id).toBe(env.doneStatusId)
    expect(out.checklistWarning.status.blocking).toEqual([
      { itemId: unchecked, title: "unchecked", levels: [] },
    ])
    const noOrigin = await makeTask(env, "no origin")
    await addItem(noOrigin, "unchecked")
    expect((await bridgeUpdate(noOrigin, env.doneStatusId)).checklistWarning).toBeDefined()
  })

  it("no warning when the checklist is complete, when there are no items, or for a human", async () => {
    const env = await makeProject(["AI"])
    const complete = await makeTask(env, "complete")
    await addItem(complete, "done", allSuccess(env))
    expect((await bridgeUpdate(complete, env.doneStatusId, "mcp")).checklistWarning).toBeUndefined()
    const bare = await makeTask(env, "bare")
    expect((await bridgeMove(bare, env.doneStatusId, "mcp")).checklistWarning).toBeUndefined()
    const human = await makeTask(env, "human")
    await addItem(human, "pending")
    const out = await bridgeUpdate(human, env.doneStatusId, "human-ui")
    expect((await taskRow(human)).status_id).toBe(env.doneStatusId)
    expect(out.checklistWarning).toBeUndefined()
  })

  it("no warning for a status change that does not enter terminal", async () => {
    const env = await makeProject(
      ["AI"],
      [{ label: "Todo" }, { label: "Review" }, { label: "Done", terminal: true }],
    )
    const taskId = await makeTask(env, "to review")
    await addItem(taskId, "pending")
    const [review] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id FROM app_projects.project_statuses
        WHERE project_id = ${env.projectId}::uuid AND label = 'Review'
      `),
    )
    const out = await bridgeMove(taskId, review!.id, "mcp")
    expect((await taskRow(taskId)).status_id).toBe(review!.id)
    expect(out.checklistWarning).toBeUndefined()
  })

  it("an agent's cross-project move keeps agent-written states mapped by name", async () => {
    const src = await makeProject(["AI", "Beta"])
    const dest = await makeProject(["AI", "Beta"])
    const taskId = await makeTask(src, "agent xmove")
    const itemId = await addItem(taskId, "agent-proven", allSuccess(src), false, "agent")
    await withRlsContext(actor, async (tx) =>
      bridgeFor(tx, "mcp").projects_moveTask(JSON.stringify({ taskId, projectId: dest.projectId })),
    )
    const [row] = extractRows<{ validations: Record<string, { state: string; via: string }> }>(
      await db.execute(drizzleSql`
        SELECT validations FROM app_projects.task_checklist_items WHERE id = ${itemId}::uuid
      `),
    )
    expect(Object.keys(row!.validations).sort()).toEqual(dest.levels.map((l) => l.id).sort())
    for (const l of dest.levels) expect(row!.validations[l.id]!.via).toBe("agent")
  })
})
