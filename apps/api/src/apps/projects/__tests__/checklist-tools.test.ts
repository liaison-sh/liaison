// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Spec S13, D13-D16: the checklist agent tools as an agent meets them, through
// the real dispatch (manifest -> preflight -> gate -> sandbox handler -> rpc
// bridge -> service). The checklist never blocks a status change; an agent
// that puts a task with an incomplete checklist into a terminal status reads
// `checklistWarning` in the tool result.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { createTask } from "~/apps/projects/service/tasks"
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
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-checklist-tools`
)) as typeof import("~/modules/apps/execute-tool")

// handlers.ts is script-mode by design: transpile + eval to call a handler the
// way the sandbox does, with an rpc bridge as its ctx.
const handlersSource = await Bun.file(new URL("../handlers.ts", import.meta.url)).text()
const transpiled = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(
  handlersSource,
)
const handlers = new Function(`${transpiled}\nreturn { updateTask };`)() as {
  updateTask: (params: Record<string, unknown>, ctx: unknown) => Promise<unknown>
}

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

interface Board {
  projectId: string
  openStatusId: string
  doneStatusId: string
}

type Origin = "mcp" | "in-app-agent" | "human-ui"

/** executeTool answers a tool error by throwing an Error that carries the code. */
async function run(
  tool: string,
  params: Record<string, unknown>,
  origin: Origin = "mcp",
): Promise<{ data?: any; error?: { code?: string; message?: string } }> {
  try {
    const out = (await executeTool({
      toolName: `projects:${tool}`,
      orgId,
      actor: actor as ActorContext,
      origin,
      params,
    })) as { data?: unknown; error?: { code?: string } }
    return out
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { error: { code: e.code, message: e.message } }
  }
}

async function approvalCount(toolName: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await db.execute(drizzleSql`
      SELECT COUNT(*)::int AS n FROM kernel.approval_requests
      WHERE org_id = ${orgId}::uuid AND tool_name = ${toolName}
    `),
  )
  return row?.n ?? 0
}

async function taskStatus(taskId: string): Promise<string> {
  const [row] = extractRows<{ status_id: string }>(
    await db.execute(
      drizzleSql`SELECT status_id FROM app_projects.tasks WHERE id = ${taskId}::uuid`,
    ),
  )
  return row!.status_id
}

async function makeBoard(): Promise<Board> {
  const out = await run("createProject", {
    name: `cl-tools-${randomUUID().slice(0, 8)}`,
    validationLevels: [{ name: "AI" }, { name: "Dev" }, { name: "Beta" }],
  })
  expect(out.error).toBeUndefined()
  const project = out.data as {
    id: string
    statuses: { id: string; terminal: boolean }[]
    validationLevels: { name: string }[]
  }
  expect(project.validationLevels.map((l) => l.name)).toEqual(["AI", "Dev", "Beta"])
  return {
    projectId: project.id,
    openStatusId: project.statuses.find((s) => !s.terminal)!.id,
    doneStatusId: project.statuses.find((s) => s.terminal)!.id,
  }
}

async function makeTask(board: Board, title: string, release?: string): Promise<string> {
  const task = await withRlsContext(actor, (tx) =>
    createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId: board.projectId,
        statusId: board.openStatusId,
        title,
        ...(release ? { release } : {}),
      },
    }),
  )
  return task.id
}

async function addItems(taskId: string, titles: string[]): Promise<string[]> {
  const out = await run("checklist_add_items", {
    taskId,
    items: titles.map((title) => ({ title })),
  })
  expect(out.error).toBeUndefined()
  return (out.data as { items: { id: string }[] }).items.map((i) => i.id)
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Checklist Tools Org', ${`cl-tools-${Date.now()}-${Math.random()}`})
      RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`cl-tools-${Date.now()}@test.com`}, 'Tool Tester', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user!.id
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
  await ensureAppsForOrg(orgId, {})
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("checklist agent tools: Done is never refused, the agent reads a warning", () => {
  it("an agent move to Done with an incomplete checklist succeeds and carries checklistWarning", async () => {
    const board = await makeBoard()
    const taskId = await makeTask(board, "move me")
    const [proven, pending] = await addItems(taskId, ["proven", "pending"])
    const set = await run("checklist_set_validation", {
      entries: ["AI", "Dev", "Beta"].map((level) => ({ itemId: proven, level, state: "success" })),
    })
    expect(set.error).toBeUndefined()
    const out = await run("move", { taskId, statusId: board.doneStatusId })
    expect(out.error).toBeUndefined()
    expect(await taskStatus(taskId)).toBe(board.doneStatusId)
    expect(out.data.checklistWarning.message).toContain("not proven")
    expect(out.data.checklistWarning.status.total).toBe(2)
    expect(out.data.checklistWarning.status.blocking).toEqual([
      { itemId: pending, title: "pending", levels: ["AI", "Dev", "Beta"] },
    ])
  })

  it("no warning when the checklist is complete, has no items, or the caller is human", async () => {
    const board = await makeBoard()
    const complete = await makeTask(board, "complete")
    const [itemId] = await addItems(complete, ["done"])
    await run("checklist_set_validation", {
      entries: ["AI", "Dev", "Beta"].map((level) => ({ itemId, level, state: "na" })),
    })
    const a = await run("move", { taskId: complete, statusId: board.doneStatusId })
    expect(a.error).toBeUndefined()
    expect(a.data.checklistWarning).toBeUndefined()
    const bare = await makeTask(board, "bare")
    const b = await run("move", { taskId: bare, statusId: board.doneStatusId })
    expect(b.data.checklistWarning).toBeUndefined()
    const human = await makeTask(board, "human")
    await addItems(human, ["pending"])
    const c = await run("move", { taskId: human, statusId: board.doneStatusId }, "human-ui")
    expect(c.error).toBeUndefined()
    expect(await taskStatus(human)).toBe(board.doneStatusId)
    expect(c.data.checklistWarning).toBeUndefined()
  })

  it("an agent update to Done on a checklist task applies at once and carries the warning", async () => {
    // `update` is not gated since 2026-09-28: no approval, the result is the task.
    const board = await makeBoard()
    const taskId = await makeTask(board, "ship the fix")
    const [pending] = await addItems(taskId, ["repro gone"])
    const before = await approvalCount("projects:update")
    const out = await run("update", { taskId, statusLabel: "done" })
    expect(out.error).toBeUndefined()
    expect(await approvalCount("projects:update")).toBe(before)
    expect(await taskStatus(taskId)).toBe(board.doneStatusId)
    expect(
      out.data.checklistWarning.status.blocking.map((b: { itemId: string }) => b.itemId),
    ).toEqual([pending])
  })

  it("the approved update runs as the agent: Done lands and the result carries the warning", async () => {
    // What runs after an approval: the handler with a bridge that keeps the
    // originating surface (mcp, or none: both are agents).
    const board = await makeBoard()
    for (const origin of ["mcp", undefined] as const) {
      const taskId = await makeTask(board, `approved ${origin ?? "no origin"}`)
      const [pending] = await addItems(taskId, ["pending"])
      const out = (await withRlsContext(actor, (tx) => {
        const bridge = createRpcBridge(
          "projects",
          userId,
          orgId,
          tx,
          { name: "projects" },
          SCOPES,
          "user",
          undefined,
          origin ? { origin } : undefined,
        )
        return handlers.updateTask({ taskId, statusId: board.doneStatusId }, bridge)
      })) as {
        statusId?: string
        checklistWarning?: { status: { blocking: { itemId: string }[] } }
      }
      expect(out.statusId).toBe(board.doneStatusId)
      expect(out.checklistWarning?.status.blocking.map((b) => b.itemId)).toEqual([pending!])
      expect(await taskStatus(taskId)).toBe(board.doneStatusId)
    }
  })

  it("an agent task created in Done cannot then receive checklist items", async () => {
    const board = await makeBoard()
    const created = await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: { projectId: board.projectId, statusId: board.doneStatusId, title: "born done" },
      }),
    )
    const out = await run("checklist_add_items", {
      taskId: created.id,
      items: [{ title: "late item" }],
    })
    expect(out.error?.code).toBe("checklist_task_terminal")
  })
})

describe("checklist agent tools: reads and validations", () => {
  it("checklist_set_validation sets two levels in one batch call; get carries the status", async () => {
    const board = await makeBoard()
    const taskId = await makeTask(board, "batch")
    const [itemId] = await addItems(taskId, ["works on device"])
    const out = await run("checklist_set_validation", {
      entries: [
        { itemId, level: "AI", state: "success" },
        {
          itemId,
          level: "dev",
          state: "fail",
          note: "crashes on boot",
          source: "https://example.com/qa/42",
        },
      ],
    })
    expect(out.error).toBeUndefined()
    const view = await run("checklist_get", { taskId })
    const levels = view.data.levels as { id: string; name: string }[]
    const byName = Object.fromEntries(levels.map((l) => [l.name, l.id]))
    const item = (view.data.items as { validations: Record<string, any> }[])[0]!
    expect(item.validations[byName.AI!]?.state).toBe("success")
    expect(item.validations[byName.AI!]?.via).toBe("agent")
    expect(item.validations[byName.Dev!]?.state).toBe("fail")
    expect(item.validations[byName.Dev!]?.source).toBe("https://example.com/qa/42")

    const got = await run("get", { taskId })
    expect(got.data.checklist.total).toBe(1)
    expect(got.data.checklist.failing).toBe(1)
  })

  it("an agent sets any level without a source (D15); a fail without a note is refused", async () => {
    const board = await makeBoard()
    const taskId = await makeTask(board, "trusted")
    const [itemId] = await addItems(taskId, ["x"])
    const beta = await run("checklist_set_validation", { itemId, level: "Beta", state: "success" })
    expect(beta.error).toBeUndefined()
    const dev = await run("checklist_set_validation", { itemId, level: "Dev", state: "na" })
    expect(dev.error).toBeUndefined()
    const noNote = await run("checklist_set_validation", { itemId, level: "AI", state: "fail" })
    expect(noNote.error?.code).toBe("checklist_fail_note_required")
    const view = await run("checklist_get", { taskId })
    const byName = Object.fromEntries(
      (view.data.levels as { id: string; name: string }[]).map((l) => [l.name, l.id]),
    )
    const v = view.data.items[0].validations
    expect(v[byName.Beta!]).toMatchObject({ state: "success", via: "agent", source: null })
    expect(v[byName.Dev!]?.state).toBe("na")
    expect(v[byName.AI!]).toBeUndefined()
  })

  it("a refused batch writes nothing, even its valid entries", async () => {
    const board = await makeBoard()
    const taskId = await makeTask(board, "atomic")
    const [itemId] = await addItems(taskId, ["x"])
    const out = await run("checklist_set_validation", {
      entries: [
        { itemId, level: "AI", state: "success" },
        { itemId, level: "Beta", state: "fail" },
      ],
    })
    expect(out.error?.code).toBe("checklist_fail_note_required")
    const view = await run("checklist_get", { taskId })
    expect(view.data.items[0].validations).toEqual({})
  })

  it("checklist_update_item edits the title and reorders", async () => {
    const board = await makeBoard()
    const taskId = await makeTask(board, "edit")
    const [a, b] = await addItems(taskId, ["first", "second"])
    const out = await run("checklist_update_item", {
      itemId: b,
      title: "second, renamed",
      beforeItemId: a,
    })
    expect(out.error).toBeUndefined()
    const view = await run("checklist_get", { taskId })
    expect((view.data.items as { title: string }[]).map((i) => i.title)).toEqual([
      "second, renamed",
      "first",
    ])
  })

  it("checklist_remove_item from an agent is staged for approval, the item stays", async () => {
    const board = await makeBoard()
    const taskId = await makeTask(board, "remove")
    const [itemId] = await addItems(taskId, ["keep me for now"])
    const before = await approvalCount("projects:checklist_remove_item")
    const out = await run("checklist_remove_item", { itemId, taskId })
    expect(out.error).toBeUndefined()
    expect(await approvalCount("projects:checklist_remove_item")).toBe(before + 1)
    const view = await run("checklist_get", { taskId })
    expect(view.data.items).toHaveLength(1)
  })

  it("tasks_byProject filters by effective release, and create/update carry release", async () => {
    const board = await makeBoard()
    const parent = await makeTask(board, "release parent", "2.1")
    await withRlsContext(actor, (tx) =>
      createTask({
        tx,
        orgId,
        actor,
        input: {
          projectId: board.projectId,
          statusId: board.openStatusId,
          title: "inherits",
          parentTaskId: parent,
        },
      }),
    )
    await makeTask(board, "other release", "3.0")
    await makeTask(board, "no release")
    const listed = await run("tasks_byProject", { projectId: board.projectId, release: "2.1" })
    expect((listed.data.items as { title: string }[]).map((t) => t.title).sort()).toEqual([
      "inherits",
      "release parent",
    ])
    const none = await run("tasks_byProject", { projectId: board.projectId, release: "__none__" })
    expect((none.data.items as { title: string }[]).map((t) => t.title)).toEqual(["no release"])

    // update (as a human-ui call, which executes past the gate) sets release.
    const updated = await withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge(
        "projects",
        userId,
        orgId,
        tx,
        { name: "projects" },
        SCOPES,
        "user",
        undefined,
        { origin: "human-ui" },
      )
      const created = JSON.parse(
        await bridge.projects_createTask(
          JSON.stringify({ projectId: board.projectId, title: "via tool", release: " 4.0 " }),
        ),
      ) as { id: string; release: string | null }
      expect(created.release).toBe("4.0")
      return JSON.parse(
        await bridge.projects_updateTask(JSON.stringify({ taskId: created.id, release: "4.1" })),
      ) as { release: string | null }
    })
    expect(updated.release).toBe("4.1")

    const byAssignee = await run("tasks_byAssignee", { assigneeId: userId, release: "3.0" })
    expect(byAssignee.error).toBeUndefined()
  })
})

describe("checklist agent tools: cross-project moves and project options", () => {
  it("an agent round trip through another project keeps every state, mapped by name (D11, D15)", async () => {
    const board = await makeBoard()
    const other = await run("createProject", {
      name: `cl-other-${randomUUID().slice(0, 8)}`,
      validationLevels: [{ name: "beta" }, { name: "AI" }, { name: "Dev" }],
    })
    expect(other.error).toBeUndefined()
    const taskId = await makeTask(board, "round trip")
    const [itemId] = await addItems(taskId, ["works on device"])
    const set = await run("checklist_set_validation", {
      entries: ["AI", "Dev", "Beta"].map((level) => ({ itemId, level, state: "success" })),
    })
    expect(set.error).toBeUndefined()
    const statesByName = async (): Promise<Record<string, string>> => {
      const view = await run("checklist_get", { taskId })
      const levels = view.data.levels as { id: string; name: string }[]
      const item = (view.data.items as { validations: Record<string, { state: string }> }[])[0]!
      return Object.fromEntries(
        levels.map((l) => [l.name.toLowerCase(), item.validations[l.id]?.state ?? "not_done"]),
      )
    }
    const all = { ai: "success", dev: "success", beta: "success" }
    expect((await run("move", { taskId, projectId: other.data.id })).error).toBeUndefined()
    expect(await statesByName()).toEqual(all)
    expect((await run("move", { taskId, projectId: board.projectId })).error).toBeUndefined()
    expect(await statesByName()).toEqual(all)
  })

  it("createProject: checklistOnCards defaults to true and can be created off", async () => {
    const on = await run("createProject", { name: `cl-on-${randomUUID().slice(0, 8)}` })
    expect(on.data.checklistOnCards).toBe(true)
    const off = await run("createProject", {
      name: `cl-off-${randomUUID().slice(0, 8)}`,
      checklistOnCards: false,
    })
    expect(off.error).toBeUndefined()
    expect(off.data.checklistOnCards).toBe(false)
  })
})
