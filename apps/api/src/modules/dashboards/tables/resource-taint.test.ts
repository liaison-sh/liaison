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
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { computeEffectiveScopeForTurn } from "~/modules/agent/scopes/effective-scope"
import { withoutRoomWithheldResourceReads } from "~/modules/agent/scopes/room-resource-history"
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
  steps: (call: Caller, origins: () => unknown, frame: RunContext) => Promise<T>,
  opts: { roomPeople?: string[]; earlierReads?: string[] } = {},
): Promise<T> {
  const actor = await asHeld(userId)
  const accumulator = createTurnScopeAccumulator({ orgId })
  // What the bridge records for tables_query: its scope, which every member holds, so the scope
  // taint stays empty and only the resource origin narrows the turn.
  accumulator.recordInjected([READ_SCOPE])
  expect(accumulator.snapshot()).toEqual([])
  // What the conversation's history carries in (earlier replies' requiredScopes).
  if (opts.earlierReads) accumulator.recordInjected(opts.earlierReads)
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
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    humanTurn: true,
    effectiveScope: actor.scopes,
    turnScopeAccumulator: accumulator,
    ...(opts.roomPeople ? { roomPeople: opts.roomPeople } : {}),
  }
  return runContextStore.run(frame, () => steps(call, () => accumulator.originRows(), frame))
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

describe("the agent's answer in a conversation never carries a table someone there may not read", () => {
  it("the room floor counts the conversation's people", async () => {
    const room = await minimal.thread(orgId, editorId, {
      title: "Floor people",
      participantIds: [outsiderId],
    })
    const floor = await withSystemDb("resource-taint-floor", (tx) =>
      computeEffectiveScopeForTurn(tx as never, orgId, room, editorId, ["*"]),
    )
    expect([...(floor.roomPeople ?? [])].sort()).toEqual([editorId, outsiderId].sort())
  })

  it("a restricted table is not read where someone it is not shared with will see the answer", async () => {
    const source = await table("none")
    const { res, frame, origins } = await turn(
      editorId,
      async (call, origins, frame) => ({
        res: await call("kernel:tables_query", { tableId: source }).then(
          (r) => ({ code: undefined as string | undefined, text: JSON.stringify(r) }),
          (err: Error & { code?: string }) => ({ code: err.code, text: err.message }),
        ),
        frame,
        origins: origins(),
      }),
      { roomPeople: [editorId, outsiderId] },
    )
    expect(res.code).toBe("E_ROOM_WITHHELD_RESOURCE")
    expect(res.text).toContain("not everyone in this conversation may read it")
    expect(res.text).not.toContain("91000")
    // Withheld by the room like a floored scope: the requester's card offers a DM or Share anyway.
    expect(frame.withheld).toContain(READ_SCOPE)
    expect(origins).toEqual({})
  })

  it("is read when everyone in the conversation may read it, or the whole org sees it", async () => {
    const restricted = await table("none")
    const readers = await turn(
      editorId,
      (call) => call("kernel:tables_query", { tableId: restricted }),
      { roomPeople: [editorId, ownerId] },
    )
    expect(JSON.stringify(readers)).toContain("91000")
    const orgWide = await table("viewer")
    const anyone = await turn(
      editorId,
      (call) => call("kernel:tables_query", { tableId: orgWide }),
      { roomPeople: [editorId, outsiderId] },
    )
    expect(JSON.stringify(anyone)).toContain("91000")
  })

  it("a later turn does not replay an earlier read of it once someone who may not read it is there", async () => {
    const source = await table("none")
    const reply = {
      id: "m1",
      metadata: {
        toolCalls: [
          {
            toolName: "kernel:tables_query",
            args: { tableId: source },
            result: { rows: [{ cells: { salary: 91000 } }] },
            status: "completed",
          },
        ],
      },
    }
    const plain = { id: "m2", metadata: {} }
    const failed = {
      id: "m3",
      metadata: {
        toolCalls: [
          { toolName: "kernel:tables_query", args: { tableId: source }, status: "error" },
        ],
      },
    }
    const all = [reply, plain, failed]
    expect(
      (await withoutRoomWithheldResourceReads(orgId, all, [editorId, outsiderId])).map((m) => m.id),
    ).toEqual(["m2", "m3"])
    expect(
      (await withoutRoomWithheldResourceReads(orgId, all, [editorId, ownerId])).map((m) => m.id),
    ).toEqual(["m1", "m2", "m3"])
  })
})

describe("an agent's row write to a table after reading data some of its readers lack", () => {
  // Prod 2026-11-12: a named agent's long conversation had read shop orders turns earlier; its
  // one-cell write to an org-wide table parked (rightly) on a card that named the data store
  // (kernel.app_documents), listed every scope the turn held and was decided by a holder of an
  // app read scope instead of the table's deciders.
  const LACKED = "kernel:audit:read"
  const HELD_BY_ALL = "kernel:threads:read"

  it("parks for the table's deciders, naming the table and only the scopes some readers lack", async () => {
    const outsider = await asHeld(outsiderId)
    expect(outsider.scopes).toContain(HELD_BY_ALL)
    expect(outsider.scopes).not.toContain(LACKED)
    await minimal.grantScope(editorId, LACKED)
    const admin = (await minimal.person(orgId, { role: "admin", name: "Dashboards admin" })).id
    const target = await table("editor")
    const name = `People ${n}`
    const res = await turn(
      editorId,
      async (call, _origins, frame) => {
        expect(frame.turnScopeAccumulator?.snapshot()).toEqual([HELD_BY_ALL, LACKED].sort())
        return call("kernel:tables_rows_write", {
          tableId: target,
          ops: [{ op: "add", cells: { name: "Sam" } }],
        })
      },
      { earlierReads: [LACKED, HELD_BY_ALL] },
    )
    const requestId = res.blocked?.approvalRequestId
    expect(requestId).toBeDefined()
    const [row] = await sql<
      {
        approve_scope: string
        resource_owner_id: string | null
        notify_user_ids: string[]
        summary: { lines: string[] }
        metadata: { taintAudienceMustHold?: string[] }
      }[]
    >`SELECT approve_scope, resource_owner_id, notify_user_ids, summary, metadata
        FROM kernel.approval_requests WHERE id = ${String(requestId)}`
    // The table's decider rule (A6): an org-wide table's changes go to the dashboards admins.
    expect(row?.approve_scope).toBe("kernel:dashboards:admin")
    expect(row?.resource_owner_id).toBeNull()
    expect(row?.notify_user_ids).toContain(admin)
    // Only what some readers lack, never what every member holds.
    expect(row?.metadata.taintAudienceMustHold).toEqual([LACKED])
    const line = row?.summary.lines.at(-1) ?? ""
    expect(line).toContain(`some people who can read the table "${name}" cannot see`)
    expect(line).not.toContain("app_documents")
    // Nothing was written yet.
    expect((await listRows(await asHeld(ownerId), target)).rows).toHaveLength(1)
  })
})
