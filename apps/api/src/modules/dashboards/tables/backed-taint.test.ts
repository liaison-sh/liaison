// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scope taint on a dashboard table backed by a project (tables/backing.ts, scope-taint.ts rule
// 6k), judged like a direct call of the backing app's own tools, in both directions:
//   - a read of the table taints the turn exactly as the app's own read tool would (its scopes),
//     so task data read through a table cannot leave for readers lacking them;
//   - a write of read-through cells lands in the app's records, whoever the table is shared
//     with: it is judged (and parks) exactly as the app's own write tool would, here after the
//     turn read a restricted table (rule 15). A write of the table's own columns only is still
//     judged by the table's sharing.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { resolveRequiredScopes } from "~/modules/agent/scopes/required-scopes"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  createTable,
  listRows,
  READ_SCOPE,
  setTableSharing,
  writeRows,
} from "~/modules/dashboards/tables/service"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let ownerId = ""
let editorId = ""

async function asHeld(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("backed-taint-perms", (tx) =>
    loadEffectivePermissions(tx as never, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
    roles: perms.roles,
  }
}

type Caller = (toolName: string, params: Record<string, unknown>) => ReturnType<typeof executeTool>

/** One agent turn of `userId` that has read `taint` before: every call shares its accumulator. */
async function turn<T>(
  userId: string,
  taint: string[],
  steps: (call: Caller, snapshot: () => string[]) => Promise<T>,
): Promise<T> {
  const actor = await asHeld(userId)
  const accumulator = createTurnScopeAccumulator({ orgId })
  accumulator.recordInjected([READ_SCOPE, ...taint])
  const runId = crypto.randomUUID()
  const threadId = await minimal.thread(orgId, userId, { title: `turn ${runId}` })
  const call: Caller = (toolName, params) =>
    executeTool({
      toolName,
      orgId,
      actor,
      params,
      threadId,
      origin: "in-app-agent",
      stepBundleId: null,
    })
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    humanTurn: true,
    effectiveScope: actor.scopes,
    turnScopeAccumulator: accumulator,
  }
  return runContextStore.run(frame, () => steps(call, () => accumulator.snapshot()))
}

/** A project with one task, and a table backed by it shared with the editor alone. */
async function backed(): Promise<{ projectId: string; taskId: string; tableId: string }> {
  const owner = await asHeld(ownerId)
  const { projectId, taskId } = await withRlsContext(owner, async (tx) => {
    const p = await createProject({
      tx,
      orgId,
      actor: owner,
      input: { name: `taint-${crypto.randomUUID().slice(0, 8)}`, statuses: [{ label: "Todo" }] },
    })
    const t = await createTask({
      tx,
      orgId,
      actor: owner,
      input: { projectId: p.id, title: "Amp hums" },
    })
    return { projectId: p.id, taskId: t.id }
  })
  const table = await createTable(owner, {
    name: `Backed ${crypto.randomUUID().slice(0, 6)}`,
    columns: [{ key: "note", label: "Note", type: "text" }],
    backing: { app: "projects", entity: "task", parentId: projectId, fields: ["title"] },
  })
  await setTableSharing(owner, table.id, {
    orgAccess: "none",
    users: [{ userId: editorId, role: "editor" }],
  })
  return { projectId, taskId, tableId: table.id }
}

async function taskTitle(taskId: string): Promise<string | undefined> {
  const [row] = await sql<{ title: string }[]>`
    SELECT title FROM app_projects.tasks WHERE id = ${taskId}::uuid`
  return row?.title
}

/** A plain table shared with the editor alone (the owner owns it): a restricted read. */
async function restrictedTable(): Promise<string> {
  const owner = await asHeld(ownerId)
  const t = await createTable(owner, {
    name: `Payroll ${crypto.randomUUID().slice(0, 6)}`,
    columns: [{ key: "salary", label: "Salary", type: "number" }],
  })
  await setTableSharing(owner, t.id, {
    orgAccess: "none",
    users: [{ userId: editorId, role: "editor" }],
  })
  await writeRows(owner, t.id, [{ op: "add", cells: { salary: 91000 } }])
  return t.id
}

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "Backed Taint Org" })
  orgId = org.orgId
  ownerId = org.adminUserId
  await ensureAppsForOrg(orgId, {})
  editorId = (await minimal.person(orgId, { name: "Editor" })).id
  for (const scope of ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"]) {
    await minimal.grantScope(editorId, scope)
  }
  registerDashboardTools(orgId)
  await registerKernelAgentTools(orgId)
}, 60_000)

afterAll(releaseTestLock)

describe("a turn that read a restricted table, writing through a backed table", () => {
  it("parks a read-through write exactly as a direct Projects update would", async () => {
    const source = await restrictedTable()
    const { taskId, tableId } = await backed()
    // The baseline: the same turn calling Projects itself parks for the requester, since the
    // project's tasks are read by people the restricted table is not shared with.
    const direct = await turn(editorId, [], async (call) => {
      await call("kernel:tables_query", { tableId: source })
      return call("projects:update", { taskId, title: "Direct" })
    })
    expect(direct.blocked?.approvalRequestId).toBeDefined()
    expect(await taskTitle(taskId)).toBe("Amp hums")
    // The backed table is shared with exactly the restricted table's readers, yet its
    // read-through cell lands in the task: it parks the same way.
    const rows = (await listRows(await asHeld(editorId), tableId)).rows
    const res = await turn(editorId, [], async (call) => {
      await call("kernel:tables_query", { tableId: source })
      return call("kernel:tables_rows_write", {
        tableId,
        ops: [
          {
            op: "update",
            id: taskId,
            ifVersion: 0,
            ifRecordVersion: rows[0]!.recordVersion,
            cells: { title: "91000" },
          },
        ],
      })
    })
    expect(res.blocked?.approvalRequestId).toBeDefined()
    expect(await taskTitle(taskId)).toBe("Amp hums")
    // Adding a row creates a task: it parks too.
    const add = await turn(editorId, [], async (call) => {
      await call("kernel:tables_query", { tableId: source })
      return call("kernel:tables_rows_write", {
        tableId,
        ops: [{ op: "add", cells: { title: "91000" } }],
      })
    })
    expect(add.blocked?.approvalRequestId).toBeDefined()
  })

  it("an own-column write is judged by the table's sharing: its readers read the source, it runs", async () => {
    const source = await restrictedTable()
    const { taskId, tableId } = await backed()
    const res = await turn(editorId, [], async (call) => {
      await call("kernel:tables_query", { tableId: source })
      return call("kernel:tables_rows_write", {
        tableId,
        ops: [{ op: "update", id: taskId, ifVersion: 0, cells: { note: "91000" } }],
      })
    })
    expect(res.blocked).toBeUndefined()
    const rows = (await listRows(await asHeld(editorId), tableId)).rows
    expect(rows[0]!.cells.note).toBe("91000")
  })
})

describe("reading a backed table", () => {
  it("taints the turn as the app's own read tool would", async () => {
    const { tableId } = await backed()
    const readTool = toolRegistry.get([orgId, "projects", "tasks_byProject"])!
    const expected = resolveRequiredScopes(readTool)
    expect(expected.length).toBeGreaterThan(0)
    const after = await turn(editorId, [], async (call, snapshot) => {
      expect(snapshot()).toEqual([])
      const read = await call("kernel:tables_query", { tableId })
      expect(JSON.stringify(read)).toContain("Amp hums")
      return snapshot()
    })
    for (const scope of expected) expect(after).toContain(scope)
  })

  it("a plain table's read adds no app scope", async () => {
    const owner = await asHeld(ownerId)
    const plain = await createTable(owner, {
      name: `Plain ${crypto.randomUUID().slice(0, 6)}`,
      columns: [{ key: "name", label: "Name", type: "text" }],
      orgAccess: "editor",
    })
    const after = await turn(editorId, [], async (call, snapshot) => {
      await call("kernel:tables_query", { tableId: plain.id })
      return snapshot()
    })
    expect(after).toEqual([])
  })
})
