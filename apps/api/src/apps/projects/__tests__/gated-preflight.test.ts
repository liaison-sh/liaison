// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A GATED CALL MUST NOT BE PARKED FOR A HUMAN WHEN THE DATA IT NEEDS IS MISSING.
//
// Every gated projects tool (delete, merge, status_delete,
// checklist_remove_item) used to validate its inputs only inside the
// post-approval handler: the approver clicked approve and got back "no project
// with that name" / "Status has tasks" / "no task with key TASK-9999", errors
// only the agent could have fixed. These tests pin the manifest `preflight`
// exports refusing at STAGING: the call fails in the agent's loop and NO write
// bridge method (and so no approval) is reached.
import { describe, expect, it } from "bun:test"
import manifest from "../app.manifest.json"

// handlers.ts is script-mode by design (see its header) — transpile + eval to
// reach the preflight exports, the same way the knowledge app's gate test does.
const handlersSource = await Bun.file(new URL("../handlers.ts", import.meta.url)).text()
const transpiled = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(
  handlersSource,
)
type Preflight = (
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<{ ok?: true; error?: { code?: string; message?: string } }>

// create, update, status_add and status_update are not gated since 2026-09-28:
// they refuse bad input directly, with the same codes (direct-write-tools.test.ts).
const {
  deleteStatusPreflight,
  deleteTaskPreflight,
  mergeTasksPreflight,
  checklistRemoveItemPreflight,
} = new Function(
  `${transpiled}\nreturn { deleteStatusPreflight, deleteTaskPreflight, mergeTasksPreflight, checklistRemoveItemPreflight };`,
)() as Record<string, Preflight>

const PROJECT_A = "11111111-1111-4111-8111-111111111111"
const STATUS_TODO = "33333333-3333-4333-8333-333333333333"
const STATUS_DONE = "44444444-4444-4444-8444-444444444444"
const TASK_A = "55555555-5555-4555-8555-555555555555"

interface BoardOptions {
  projects?: Array<{ id: string; name: string }>
  statuses?: Record<string, Array<{ id: string; label: string }>>
  taskCounts?: Record<string, number>
  tasks?: Record<string, string>
  users?: Record<string, { status: string } | null>
  /** assigneeName -> what the host resolver answers (`{ id }` or `{ error }`). */
  names?: Record<string, unknown>
  /** taskId -> checklist item ids, for projects_checklistGet. */
  checklists?: Record<string, string[]>
}

/** A fake projects bridge: read methods answer from `opts`, every WRITE method
 *  is a spy so a test can prove the handler was never reached. */
function makeCtx(opts: BoardOptions = {}) {
  const writes: string[] = []
  const spy = (name: string) => async () => {
    writes.push(name)
    return JSON.stringify({ ok: true })
  }
  const projects = opts.projects ?? [{ id: PROJECT_A, name: "Roadmap" }]
  const statuses = opts.statuses ?? {
    [PROJECT_A]: [
      { id: STATUS_TODO, label: "Todo" },
      { id: STATUS_DONE, label: "Done" },
    ],
  }
  const ctx = {
    projects_search: async () =>
      JSON.stringify({
        items: projects.map((p) => ({ type: "project", ...p })),
        nextCursor: null,
        totalCount: projects.length,
      }),
    projects_get: async (json: string) => {
      const p = JSON.parse(json) as { projectId?: string; taskId?: string }
      if (p.taskId) {
        const resolved = opts.tasks?.[p.taskId]
        if (!resolved) throw new Error(`no task with key ${JSON.stringify(p.taskId)}`)
        return JSON.stringify({ id: resolved, title: "A task" })
      }
      const project = projects.find((x) => x.id === p.projectId)
      if (!project) throw new Error("project_not_found")
      return JSON.stringify({ ...project, statuses: statuses[project.id] ?? [] })
    },
    projects_tasksByProject: async (json: string) => {
      const p = JSON.parse(json) as { statusId?: string }
      return JSON.stringify({ items: [], totalCount: opts.taskCounts?.[p.statusId ?? ""] ?? 0 })
    },
    kernel_findOne: async (_entity: string, id: string) => JSON.stringify(opts.users?.[id] ?? null),
    projects_resolveAssignee: async (json: string) => {
      const p = JSON.parse(json) as { assigneeName?: string }
      return JSON.stringify(
        opts.names?.[p.assigneeName ?? ""] ?? {
          error: { code: "assignee_not_found", message: "no user with that name", details: null },
        },
      )
    },
    projects_checklistGet: async (json: string) => {
      const p = JSON.parse(json) as { taskId: string }
      const ids = opts.checklists?.[p.taskId]
      if (!ids) return JSON.stringify({ error: { code: "not_found", message: "task not found" } })
      return JSON.stringify({ items: ids.map((id) => ({ id })) })
    },
    projects_createTask: spy("createTask"),
    projects_updateTask: spy("updateTask"),
    projects_deleteTask: spy("deleteTask"),
    projects_mergeTasks: spy("mergeTasks"),
    projects_addStatus: spy("addStatus"),
    projects_updateStatus: spy("updateStatus"),
    projects_deleteStatus: spy("deleteStatus"),
    requestApproval: spy("requestApproval"),
  }
  return { ctx, writes }
}

describe("projects gated tools refuse at staging", () => {
  it("status_delete: a column that still holds tasks is refused", async () => {
    const { ctx, writes } = makeCtx({ taskCounts: { [STATUS_TODO]: 3 } })
    const out = await deleteStatusPreflight!({ projectId: PROJECT_A, statusLabel: "Todo" }, ctx)
    expect(out.error?.code).toBe("status_in_use")
    expect(writes).toEqual([])
  })

  it("status_delete: an empty column is allowed through", async () => {
    const { ctx } = makeCtx()
    const out = await deleteStatusPreflight!({ projectId: PROJECT_A, statusLabel: "Todo" }, ctx)
    expect(out.ok).toBe(true)
  })

  it("delete: a task key that resolves to nothing is refused", async () => {
    const { ctx, writes } = makeCtx()
    const out = await deleteTaskPreflight!({ taskId: "TASK-9999" }, ctx)
    expect(out.error?.code).toBe("not_found")
    expect(writes).toEqual([])
  })

  it("merge: a task merged into itself is refused, by id and via a display key", async () => {
    const { ctx, writes } = makeCtx({ tasks: { "ERB-12": TASK_A, [TASK_A]: TASK_A } })
    const same = await mergeTasksPreflight!({ sourceId: TASK_A, targetId: TASK_A }, ctx)
    expect(same.error?.code).toBe("invalid_merge")
    const viaKey = await mergeTasksPreflight!({ sourceId: "ERB-12", targetId: TASK_A }, ctx)
    expect(viaKey.error?.code).toBe("invalid_merge")
    expect(writes).toEqual([])
  })

  it("merge: an unknown source task is refused", async () => {
    const { ctx, writes } = makeCtx({ tasks: { [TASK_A]: TASK_A } })
    const out = await mergeTasksPreflight!({ sourceId: "ERB-404", targetId: TASK_A }, ctx)
    expect(out.error?.code).toBe("not_found")
    expect(writes).toEqual([])
  })
})

describe("checklist_remove_item preflight", () => {
  const ITEM = "77777777-7777-4777-8777-777777777777"
  it("refuses an item that is not on the named task", async () => {
    const { ctx, writes } = makeCtx({ checklists: { "ERB-1": [] } })
    const out = await checklistRemoveItemPreflight!({ itemId: ITEM, taskId: "ERB-1" }, ctx)
    expect(out.error?.code).toBe("not_found")
    expect(writes).toEqual([])
  })

  it("refuses an unknown task and a non-uuid item id", async () => {
    const { ctx } = makeCtx()
    expect(
      (await checklistRemoveItemPreflight!({ itemId: ITEM, taskId: "ERB-404" }, ctx)).error?.code,
    ).toBe("not_found")
    expect((await checklistRemoveItemPreflight!({ itemId: "nope" }, ctx)).error?.code).toBe(
      "not_found",
    )
  })

  it("lets an item that is on the task through", async () => {
    const { ctx } = makeCtx({ checklists: { "ERB-1": [ITEM] } })
    expect((await checklistRemoveItemPreflight!({ itemId: ITEM, taskId: "ERB-1" }, ctx)).ok).toBe(
      true,
    )
    expect((await checklistRemoveItemPreflight!({ itemId: ITEM }, ctx)).ok).toBe(true)
  })
})

describe("projects gated tools reject a blank id before gating", () => {
  // Plain presence is enforced by the params schema, which runs BEFORE the
  // approval is created, so a blank id never reaches the gate at all.
  const tools = manifest.tools as unknown as Record<
    string,
    { params: { properties: Record<string, { minLength?: number }>; required?: string[] } }
  >
  it("delete and update require a non-empty taskId", () => {
    expect(tools.delete!.params.required).toContain("taskId")
    expect(tools.delete!.params.properties.taskId!.minLength).toBe(1)
    expect(tools.update!.params.required).toContain("taskId")
    expect(tools.update!.params.properties.taskId!.minLength).toBe(1)
  })

  it("merge requires a non-empty sourceId and targetId", () => {
    expect(tools.merge!.params.required).toEqual(["sourceId", "targetId"])
    expect(tools.merge!.params.properties.sourceId!.minLength).toBe(1)
    expect(tools.merge!.params.properties.targetId!.minLength).toBe(1)
  })
})
