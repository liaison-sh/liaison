// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S25/S26 (owner ruling 2026-09-28): an agent's `create`, `update`,
// `status_add` and `status_update` run DIRECTLY, with no approval card, while
// `delete`, `merge`, `status_delete` and `checklist_remove_item` stay gated.
// Driven through the real dispatch (manifest -> gate -> sandbox handler -> rpc
// bridge -> service), as an agent.
//
// PARITY: these four used to run a stage-time preflight that refused bad input
// with a typed code before any approval existed. With the preflight gone the
// direct path must answer the same codes, and write nothing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Hermetic copy of execute-tool (a neighbouring file mock.module()s it; see
// service/assignee-name-enrichment.test.ts for the full story).
const { executeTool } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-direct-write-tools`
)) as typeof import("~/modules/apps/execute-tool")

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

let orgId: string
let userId: string
let actor: UserContext

interface Outcome {
  data?: any
  blocked?: { reason?: string; approvalRequestId?: string }
  error?: { code?: string; message?: string }
}

/** Call a projects tool as an in-app agent. A tool error comes back as `error`. */
async function run(
  tool: string,
  params: Record<string, unknown>,
  threadId?: string,
): Promise<Outcome> {
  try {
    return (await executeTool({
      toolName: `projects:${tool}`,
      orgId,
      actor: actor as ActorContext,
      origin: "in-app-agent",
      params,
      ...(threadId ? { threadId } : {}),
    })) as Outcome
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { error: { code: e.code, message: e.message } }
  }
}

async function approvalCount(toolName?: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await db.execute(drizzleSql`
      SELECT COUNT(*)::int AS n FROM kernel.approval_requests
      WHERE org_id = ${orgId}::uuid
        ${toolName ? drizzleSql`AND tool_name = ${toolName}` : drizzleSql``}
    `),
  )
  return row?.n ?? 0
}

async function taskCount(): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT COUNT(*)::int AS n FROM app_projects.tasks WHERE org_id = ${orgId}::uuid`,
    ),
  )
  return row?.n ?? 0
}

async function statusCount(projectId: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT COUNT(*)::int AS n FROM app_projects.project_statuses WHERE project_id = ${projectId}::uuid`,
    ),
  )
  return row?.n ?? 0
}

interface Board {
  id: string
  key: string
  statuses: Array<{ id: string; label: string; terminal: boolean }>
}

async function makeBoard(name = `direct-${randomUUID().slice(0, 8)}`): Promise<Board> {
  // createProject is ungated: it always ran directly.
  const out = await run("createProject", { name })
  expect(out.error).toBeUndefined()
  return out.data as Board
}

async function addUser(name: string, status = "active"): Promise<string> {
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`direct-${randomUUID().slice(0, 8)}@test.com`},
              ${name}, ${status}, 'hash', 1, 1)
      RETURNING id
    `),
  )
  return u!.id
}

/** A refusal: the expected code, no approval parked, nothing written. */
async function expectRefused(
  tool: string,
  params: Record<string, unknown>,
  code: string,
  unchanged: () => Promise<number> = taskCount,
): Promise<void> {
  const approvalsBefore = await approvalCount()
  const before = await unchanged()
  const out = await run(tool, params)
  expect(out.blocked, `${tool} ${JSON.stringify(params)} parked`).toBeUndefined()
  expect(out.error?.code, `${tool} ${JSON.stringify(params)}`).toBe(code)
  expect(await approvalCount()).toBe(approvalsBefore)
  expect(await unchanged()).toBe(before)
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Direct Write Tools Org', ${`direct-tools-${Date.now()}-${Math.random()}`})
      RETURNING id
    `),
  )
  orgId = org!.id
  userId = await addUser("Tool Tester")
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
  await ensureAppsForOrg(orgId, {})
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("S25: create / update / status_add / status_update run directly for an agent", () => {
  it("update returns the updated task and parks no approval", async () => {
    const board = await makeBoard()
    const created = await run("create", { projectId: board.id, title: "before" })
    const taskId = (created.data as { id: string }).id
    const before = await approvalCount()
    const out = await run("update", { taskId, title: "after", priority: "high" })
    expect(out.blocked).toBeUndefined()
    expect(out.error).toBeUndefined()
    expect(out.data.id).toBe(taskId)
    expect(out.data.title).toBe("after")
    expect(out.data.priority).toBe("high")
    expect(await approvalCount()).toBe(before)
    expect(await approvalCount("projects:update")).toBe(0)
  })

  it("create returns the task and parks no approval", async () => {
    const board = await makeBoard()
    const before = await approvalCount()
    const out = await run("create", { projectId: board.id, title: "filed directly" })
    expect(out.blocked).toBeUndefined()
    expect(out.error).toBeUndefined()
    expect(typeof out.data.id).toBe("string")
    expect(out.data.title).toBe("filed directly")
    expect(await approvalCount()).toBe(before)
    expect(await approvalCount("projects:create")).toBe(0)
  })

  it("status_add and status_update apply at once and park no approval", async () => {
    const board = await makeBoard()
    const before = await approvalCount()
    const added = await run("status_add", { projectId: board.id, label: "QA" })
    expect(added.blocked).toBeUndefined()
    expect(added.error).toBeUndefined()
    expect(added.data.label).toBe("QA")
    const renamed = await run("status_update", {
      projectId: board.id,
      statusLabel: "QA",
      label: "Review",
    })
    expect(renamed.blocked).toBeUndefined()
    expect(renamed.error).toBeUndefined()
    expect(renamed.data.id).toBe(added.data.id)
    expect(renamed.data.label).toBe("Review")
    expect(await approvalCount()).toBe(before)
  })

  it("delete, merge, status_delete and checklist_remove_item still park an approval", async () => {
    const board = await makeBoard()
    const a = (await run("create", { projectId: board.id, title: "a" })).data.id as string
    const b = (await run("create", { projectId: board.id, title: "b" })).data.id as string
    const extra = await run("status_add", { projectId: board.id, label: "Spare" })
    const items = await run("checklist_add_items", { taskId: a, items: [{ title: "one" }] })
    const itemId = (items.data as { items: { id: string }[] }).items[0]!.id
    const calls: Array<[string, Record<string, unknown>]> = [
      ["delete", { taskId: b }],
      ["merge", { sourceId: b, targetId: a }],
      ["status_delete", { projectId: board.id, statusId: extra.data.id }],
      ["checklist_remove_item", { taskId: a, itemId }],
    ]
    for (const [tool, params] of calls) {
      const before = await approvalCount(`projects:${tool}`)
      const out = await run(tool, params)
      expect(out.error, tool).toBeUndefined()
      expect(out.blocked?.reason, tool).toBe("gated")
      expect(await approvalCount(`projects:${tool}`), tool).toBe(before + 1)
    }
  })
})

describe("S26: the direct path answers the codes the removed preflights gave", () => {
  it("create: project_required, project_ambiguous, not_found, no_statuses", async () => {
    await expectRefused(
      "create",
      { projectName: `nope-${randomUUID()}`, title: "x" },
      "project_required",
    )
    const dup = `dup-${randomUUID().slice(0, 8)}`
    await makeBoard(dup)
    await makeBoard(dup)
    await expectRefused("create", { projectName: dup, title: "x" }, "project_ambiguous")
    await expectRefused("create", { projectId: randomUUID(), title: "x" }, "not_found")
    const bare = await makeBoard()
    await db.execute(
      drizzleSql`DELETE FROM app_projects.project_statuses WHERE project_id = ${bare.id}::uuid`,
    )
    await expectRefused("create", { projectId: bare.id, title: "x" }, "no_statuses")
  })

  it("create: a subtask named only by its parent lands in the parent's project, with several boards active", async () => {
    // A live agent asked to break a task into subtasks sent `parentTaskId` alone. With more
    // than one active project that came back `project_ambiguous` on every call, although
    // the parent already names the project.
    const board = await makeBoard()
    await makeBoard()
    const parent = (await run("create", { projectId: board.id, title: "parent" })).data as {
      id: string
      key: string
    }
    for (const parentTaskId of [parent.id, parent.key]) {
      const out = await run("create", { title: `sub via ${parentTaskId}`, parentTaskId })
      expect(out.error, parentTaskId).toBeUndefined()
      expect(out.data.projectId, parentTaskId).toBe(board.id)
      expect(out.data.parentTaskId, parentTaskId).toBe(parent.id)
    }
  })

  it("create: project_ambiguous with no project and no parent says how to fix the call (walk D26)", async () => {
    // A live agent sent neither parentTaskId nor projectId four times and got
    // "multiple active projects" back each time, with nothing telling it what to send.
    const names = [`amb-a-${randomUUID().slice(0, 6)}`, `amb-b-${randomUUID().slice(0, 6)}`]
    const boards = [await makeBoard(names[0]), await makeBoard(names[1])]
    const out = await run("create", { title: "x" })
    expect(out.error?.code).toBe("project_ambiguous")
    const message = out.error?.message ?? ""
    expect(message).toContain("parentTaskId")
    expect(message).toContain("projectId")
    // The candidates are named in the message itself, by name and id.
    boards.forEach((board, i) => {
      expect(message).toContain(board.id)
      expect(message).toContain(names[i]!)
    })
  })

  it("create: in a task's discussion, project_ambiguous names that task as the parent to pass", async () => {
    // Observed live: in a task's discussion an agent asked to break the task into
    // subtasks sent neither parentTaskId nor projectId. The refusal now names the
    // task the conversation is about, so the first retry is right. It still files
    // nothing: the call asked for no parent.
    const board = await makeBoard()
    await makeBoard()
    const parent = (await run("create", { projectId: board.id, title: "Launch plan" })).data as {
      id: string
      key: string
    }
    const [thread] = extractRows<{ thread_id: string }>(
      await db.execute(
        drizzleSql`SELECT thread_id::text AS thread_id FROM app_projects.tasks WHERE id = ${parent.id}::uuid`,
      ),
    )
    const before = await taskCount()
    const out = await run("create", { title: "Draft the copy" }, thread!.thread_id)
    expect(out.error?.code).toBe("project_ambiguous")
    const message = out.error?.message ?? ""
    expect(message).toContain(`parentTaskId "${parent.key}"`)
    expect(message).toContain(parent.id)
    expect(message).toContain("Launch plan")
    expect(await taskCount()).toBe(before)
    // The retry the message asks for lands under that task.
    const retry = await run(
      "create",
      { title: "Draft the copy", parentTaskId: parent.key },
      thread!.thread_id,
    )
    expect(retry.error).toBeUndefined()
    expect(retry.data.parentTaskId).toBe(parent.id)
  })

  it("context: a turn in a task's discussion names that task, its key and its project", async () => {
    const boardName = `ctx-${randomUUID().slice(0, 6)}`
    const board = await makeBoard(boardName)
    await makeBoard()
    const task = (await run("create", { projectId: board.id, title: "Website relaunch" })).data as {
      id: string
      key: string
    }
    const [thread] = extractRows<{ thread_id: string }>(
      await db.execute(
        drizzleSql`SELECT thread_id::text AS thread_id FROM app_projects.tasks WHERE id = ${task.id}::uuid`,
      ),
    )
    const { assembleContext } = await import("~/modules/agent/context/context")
    const result = await assembleContext({ threadId: thread!.thread_id, orgId, actor })
    const text = result.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n")
    expect(text).toContain(
      `The task this discussion is about: ${task.key} "Website relaunch" (id: ${task.id})`,
    )
    expect(text).toContain(`in project "${boardName}" (id: ${board.id})`)
    expect(text).toContain(`parentTaskId "${task.key}"`)
  })

  it("create: parent_not_found for an unknown parent, by key or by id", async () => {
    const board = await makeBoard()
    await expectRefused(
      "create",
      { projectId: board.id, title: "sub", parentTaskId: `${board.key}-9999` },
      "parent_not_found",
    )
    await expectRefused(
      "create",
      { projectId: board.id, title: "sub", parentTaskId: randomUUID() },
      "parent_not_found",
    )
  })

  it("create: assignee_not_found / assignee_ambiguous, by id and by name", async () => {
    const board = await makeBoard()
    const gone = await addUser("Gone Person", "deactivated")
    await expectRefused(
      "create",
      { projectId: board.id, title: "x", assigneeId: gone },
      "assignee_not_found",
    )
    await expectRefused(
      "create",
      { projectId: board.id, title: "x", assigneeId: randomUUID() },
      "assignee_not_found",
    )
    await expectRefused(
      "create",
      { projectId: board.id, title: "x", assigneeName: "Nobody Here" },
      "assignee_not_found",
    )
    const first = `Twin${randomUUID().slice(0, 6)}`
    await addUser(`${first} One`)
    await addUser(`${first} Two`)
    await expectRefused(
      "create",
      { projectId: board.id, title: "x", assigneeName: first },
      "assignee_ambiguous",
    )
  })

  it("update: not_found for an unknown task, assignee_not_found for an unknown assignee", async () => {
    const board = await makeBoard()
    await expectRefused("update", { taskId: `${board.key}-9999`, title: "x" }, "not_found")
    await expectRefused("update", { taskId: randomUUID(), title: "x" }, "not_found")
    const taskId = (await run("create", { projectId: board.id, title: "keep" })).data.id as string
    // `update` declares no assigneeName (the schema refuses it as invalid_params,
    // before and after this change); an unknown assignee id is the refusal here.
    await expectRefused("update", { taskId, assigneeId: randomUUID() }, "assignee_not_found")
  })

  it("update: a refused edit leaves no part of itself behind (reparent + bad priority)", async () => {
    const board = await makeBoard()
    const parent = (await run("create", { projectId: board.id, title: "parent" })).data.id as string
    const child = (await run("create", { projectId: board.id, title: "child" })).data.id as string
    // The tool schema does not expose parentTaskId; the bridge method (also the
    // approved-call path) does, and it reparents BEFORE it edits.
    const raw: string = await withRlsContext(actor, (tx) =>
      createRpcBridge(
        "projects",
        userId,
        orgId,
        tx,
        { name: "projects" },
        SCOPES,
      ).projects_updateTask(
        JSON.stringify({ taskId: child, parentTaskId: parent, priority: "medium" }),
      ),
    )
    expect((JSON.parse(raw) as { error?: { code?: string } }).error?.code).toBe("invalid_priority")
    const [row] = extractRows<{ parent_task_id: string | null }>(
      await db.execute(
        drizzleSql`SELECT parent_task_id FROM app_projects.tasks WHERE id = ${child}::uuid`,
      ),
    )
    expect(row!.parent_task_id).toBeNull()
  })

  it("status_add: not_found / project_required / project_ambiguous", async () => {
    const board = await makeBoard()
    const statuses = () => statusCount(board.id)
    await expectRefused(
      "status_add",
      { projectId: randomUUID(), label: "QA" },
      "not_found",
      statuses,
    )
    await expectRefused(
      "status_add",
      { projectName: `nope-${randomUUID()}`, label: "QA" },
      "project_required",
      statuses,
    )
    const dup = `dup-${randomUUID().slice(0, 8)}`
    await makeBoard(dup)
    await makeBoard(dup)
    await expectRefused(
      "status_add",
      { projectName: dup, label: "QA" },
      "project_ambiguous",
      statuses,
    )
  })

  it("status_update: not_found for an unknown project, status_* for an unresolvable column", async () => {
    const board = await makeBoard()
    const statuses = () => statusCount(board.id)
    await expectRefused(
      "status_update",
      { projectId: randomUUID(), statusLabel: "Todo", label: "x" },
      "not_found",
      statuses,
    )
    await expectRefused(
      "status_update",
      { projectId: board.id, statusLabel: "No Such Column", label: "x" },
      "status_not_found",
      statuses,
    )
    await expectRefused(
      "status_update",
      { projectId: board.id, statusId: randomUUID(), label: "x" },
      "status_not_found",
      statuses,
    )
    await expectRefused(
      "status_update",
      { projectId: board.id, label: "x" },
      "status_required",
      statuses,
    )
    await db.execute(drizzleSql`
      UPDATE app_projects.project_statuses SET label = 'Twin'
       WHERE id IN (${board.statuses[0]!.id}::uuid, ${board.statuses[1]!.id}::uuid)`)
    await expectRefused(
      "status_update",
      { projectId: board.id, statusLabel: "twin", label: "x" },
      "status_ambiguous",
      statuses,
    )
  })
})
