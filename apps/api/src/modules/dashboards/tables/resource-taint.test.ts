// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Resource taint (scope-taint.ts, rule 15): reading a dashboard table shared with some people only
// narrows the turn below its scope. A later write runs at once only when every one of its readers
// also reads that table; otherwise it parks for the requester alone (who read it), never refused
// silently and never shown to the org's deciders. A table the whole organisation sees narrows
// nothing.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { executeTool } from "~/modules/apps/execute-tool"
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
let outsiderId = ""

async function asHeld(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("resource-taint-perms", (tx) =>
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

const COLUMNS = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "salary", label: "Salary", type: "number" },
]

let n = 0
/** A table the owner shares with the editor (editor) only, or with the whole org. */
async function table(orgAccess: "none" | "viewer" | "editor") {
  n += 1
  const owner = await asHeld(ownerId)
  const t = await createTable(owner, { name: `People ${n}`, columns: COLUMNS })
  await setTableSharing(owner, t.id, {
    orgAccess,
    users: [{ userId: editorId, role: "editor" }],
  })
  await writeRows(owner, t.id, [{ op: "add", cells: { name: "Alex", salary: 91000 } }])
  return t.id
}

/** One agent turn of `userId`: every call in `steps` shares the turn's taint and origins. */
async function turn<T>(
  userId: string,
  steps: (call: Caller, origins: () => unknown) => Promise<T>,
): Promise<T> {
  const actor = await asHeld(userId)
  const accumulator = createTurnScopeAccumulator({ orgId })
  // What the bridge records for tables_query: its scope, which every member holds, so the scope
  // taint stays empty and only the resource origin narrows the turn.
  accumulator.recordInjected([READ_SCOPE])
  expect(accumulator.snapshot()).toEqual([])
  const runId = crypto.randomUUID()
  const threadId = await minimal.thread(orgId, userId, { title: `turn ${runId}` })
  const call: Caller = (toolName, params, opts = {}) =>
    executeTool({
      toolName,
      orgId,
      actor,
      params,
      threadId: opts.threadId ?? threadId,
      origin: "in-app-agent",
      stepBundleId: null,
    })
  return runContextStore.run(
    {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      humanTurn: true,
      effectiveScope: actor.scopes,
      turnScopeAccumulator: accumulator,
    },
    () => steps(call, () => accumulator.originRows()),
  )
}
type Caller = (
  toolName: string,
  params: Record<string, unknown>,
  opts?: { threadId?: string },
) => ReturnType<typeof executeTool>

async function ownerOf(approvalId: string | undefined) {
  const [row] = await sql<{ resource_owner_id: string | null; notify_user_ids: string[] }[]>`
    SELECT resource_owner_id, notify_user_ids FROM kernel.approval_requests
     WHERE id = ${String(approvalId)}`
  return row
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Resource Taint Org" })).orgId
  ownerId = (await minimal.person(orgId, { name: "Owner" })).id
  editorId = (await minimal.person(orgId, { name: "Editor" })).id
  outsiderId = (await minimal.person(orgId, { name: "Outsider" })).id
  registerDashboardTools(orgId)
  await registerKernelAgentTools(orgId)
})

afterAll(releaseTestLock)

describe("a restricted table's read narrows the turn's writes", () => {
  it("copying a restricted table's cells into an org-wide table parks for the requester alone", async () => {
    const source = await table("none")
    const target = await table("editor")
    const res = await turn(editorId, async (call, origins) => {
      const read = await call("kernel:tables_query", { tableId: source })
      expect(JSON.stringify(read)).toContain("91000")
      // The read filed the table itself as the turn's origin.
      expect(origins()).toEqual({ "kernel.dashboard_table": [source] })
      return call("kernel:tables_rows_write", {
        tableId: target,
        ops: [{ op: "add", cells: { name: "Alex", salary: 91000 } }],
      })
    })
    expect(res.blocked?.approvalRequestId).toBeDefined()
    const approval = await ownerOf(res.blocked?.approvalRequestId)
    expect(approval?.resource_owner_id).toBe(editorId)
    expect(approval?.notify_user_ids).toEqual([editorId])
    // Nothing reached the org-wide table.
    expect((await listRows(await asHeld(ownerId), target)).rows).toHaveLength(1)
  })

  it("an org-wide table's read lets a write into a restricted table run at once", async () => {
    const source = await table("viewer")
    const target = await table("none")
    const res = await turn(editorId, async (call) => {
      await call("kernel:tables_query", { tableId: source })
      return call("kernel:tables_rows_write", {
        tableId: target,
        ops: [{ op: "add", cells: { name: "Sam" } }],
      })
    })
    expect(res.blocked).toBeUndefined()
    expect((await listRows(await asHeld(ownerId), target)).rows).toHaveLength(2)
  })

  it("a post into a conversation with someone the table is not shared with parks", async () => {
    const source = await table("none")
    const room = await minimal.thread(orgId, editorId, {
      title: "Payroll chat",
      participantIds: [outsiderId],
    })
    const res = await turn(editorId, async (call) => {
      await call("kernel:tables_query", { tableId: source })
      return call("kernel:threads_reply", { threadId: room, content: "Alex earns 91000" })
    })
    expect(res.blocked?.approvalRequestId).toBeDefined()
    expect((await ownerOf(res.blocked?.approvalRequestId))?.resource_owner_id).toBe(editorId)
    const [posted] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
       WHERE thread_id = ${room}::uuid AND content LIKE '%91000%'`
    expect(posted?.n).toBe(0)
  })
})
