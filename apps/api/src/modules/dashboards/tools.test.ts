// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's dashboard tools through the real tool core: a personal dashboard
// is a plain write; anything resulting in or touching an org dashboard parks an
// approval decided by kernel:dashboards:admin and changes nothing until then;
// preview_block returns what the chart would draw, and a refused source names
// eligible alternatives; sources lists the reads this person may chart.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { z } from "zod"
import { extractRows, type RlsClient, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { userRoles } from "~/db/schema/kernel"
import { isThreadTainted } from "~/modules/agent/scopes/taint"
import { decideApproval } from "~/modules/approvals/decide"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { toolRegistry } from "~/modules/apps/app-registries"
import { generateApprovalSummary } from "~/modules/apps/approval-summarizers"
import { executeTool } from "~/modules/apps/execute-tool"
import { createDashboard, getDashboard, listDashboards } from "~/modules/dashboards/service"
import type { EligibleSource } from "~/modules/dashboards/sources"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import { setDocument } from "~/modules/data-store/service"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "dshtools"
const READ = `${APP}:orders:read`
/** A second app, so its tool never shows among the first app's alternatives. */
const ROLES_APP = "dshroles"
const ROLES_READ = `${ROLES_APP}:roles:read`
const WRITE = "kernel:dashboards:write"
const SHARE = "kernel:dashboards:share"
const ADMIN = "kernel:dashboards:admin"

let orgId = ""
let owner = ""
let other = ""
let threadId = ""

const as = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: {},
})

const ORDERS = [
  { status: "completed", total: "12" },
  { status: "completed", total: "8" },
  { status: "refunded", total: "5" },
]

const pieBlock = (tool = `${APP}:orders_list`) => ({
  id: "status",
  type: "pie",
  title: "Orders by status",
  source: { kind: "tool", tool },
  map: { groupBy: { field: "status" }, value: "total", agg: "sum" },
})

function call(
  userId: string,
  scopes: string[],
  name: string,
  params: unknown,
  onThread = threadId,
) {
  return executeTool({
    toolName: `kernel:${name}`,
    orgId,
    actor: as(userId, scopes),
    params,
    threadId: onThread,
    origin: "in-app-agent",
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboard Tools Org" })).orgId
  owner = (await minimal.person(orgId)).id
  other = (await minimal.person(orgId)).id
  threadId = await minimal.thread(orgId, owner, { title: "Build a dashboard" })
  registerDashboardTools(orgId)
  toolRegistry.set([orgId, APP, "orders_list"], {
    appName: APP,
    name: "orders_list",
    description: "List the shop's orders",
    requiredScopes: [READ],
    readOnly: true,
    params: z.object({ status: z.string().optional() }),
    returns: { schema: { orders: "object" } },
    handler: async () => ({ orders: ORDERS }),
  })
  // Echoes the role ids the row policies see for the caller (`app.current_roles`).
  toolRegistry.set([orgId, ROLES_APP, "my_roles"], {
    appName: ROLES_APP,
    name: "my_roles",
    description: "The caller's roles as the row policies see them",
    requiredScopes: [ROLES_READ],
    readOnly: true,
    params: z.object({}),
    handler: async (_p: unknown, ctx: { db: RlsClient }) => {
      const rows = extractRows<{ r: string | null }>(
        await ctx.db.execute(drizzleSql`SELECT current_setting('app.current_roles', true) AS r`),
      )
      const value = rows[0]?.r ?? ""
      return {
        items: value
          .split(",")
          .filter((r) => r !== "" && r !== "__none__")
          .map((role) => ({ role })),
      }
    },
  })
  toolRegistry.set([orgId, APP, "orders_cancel"], {
    appName: APP,
    name: "orders_cancel",
    description: "Cancel an order",
    requiredScopes: [READ],
    writesToTable: `app_${APP}.orders`,
    params: z.object({}),
    handler: async () => ({ cancelled: true }),
  })
})

afterAll(async () => {
  await releaseTestLock()
})

describe("writes", () => {
  it("a personal dashboard saves at once", async () => {
    const res = await call(owner, [WRITE, READ], "dashboards_create", {
      title: "My orders",
      spec: { v: 1, blocks: [pieBlock()] },
    })
    expect(res.blocked).toBeUndefined()
    const id = (res.data as { id: string }).id
    expect(await getDashboard(as(owner, [WRITE]), id)).toMatchObject({ visibility: "personal" })
  })

  it("an org dashboard waits for an approval decided by kernel:dashboards:admin, and nothing exists meanwhile", async () => {
    const before = (await listDashboards(as(other, [WRITE]))).length
    const res = await call(owner, [WRITE, SHARE, READ], "dashboards_create", {
      title: "Team orders",
      visibility: "org",
      spec: { v: 1, blocks: [pieBlock()] },
    })
    expect(res.blocked?.approvalRequestId).toBeString()
    expect(res.blocked?.summary?.title).toContain("Team orders")
    expect(res.blocked?.summary?.lines.join("\n")).toContain(`from ${APP}:orders_list`)
    // The owner holds share, not admin: the card is not theirs to decide.
    expect(res.blocked?.requesterCanApprove).toBe(false)
    expect((await listDashboards(as(other, [WRITE]))).length).toBe(before)
  })

  it("the card shows a block's date tokens as written and what they are today", async () => {
    const block = {
      ...pieBlock(),
      source: { kind: "tool", tool: `${APP}:orders_list`, params: { status: "{{startOfMonth}}" } },
    }
    const res = await call(owner, [WRITE, SHARE, READ], "dashboards_create", {
      title: "Rolling orders",
      visibility: "org",
      spec: { v: 1, blocks: [block] },
    })
    // The test org's timezone is the default, UTC.
    const month = new Date().toISOString().slice(0, 7)
    expect(res.blocked?.summary?.lines.join("\n")).toContain(
      `dates {{startOfMonth}} = ${month}-01 (today, rolling)`,
    )
  })

  it("an agent's edit or delete of an org dashboard always stages, even for its owner with share", async () => {
    const shared = await createDashboard(as(owner, [WRITE, SHARE, READ]), {
      title: "Shared",
      visibility: "org",
      spec: { v: 1, blocks: [] },
    })
    const edit = await call(owner, [WRITE, SHARE, READ], "dashboards_update", {
      id: shared.id,
      spec: { v: 1, blocks: [pieBlock()] },
    })
    expect(edit.blocked?.approvalRequestId).toBeString()
    const del = await call(owner, [WRITE, SHARE], "dashboards_delete", { id: shared.id })
    expect(del.blocked?.approvalRequestId).toBeString()
    expect(await getDashboard(as(owner, [WRITE]), shared.id)).toMatchObject({ version: 1 })

    // Switching a personal one to org stages too; a personal edit does not.
    const mine = await createDashboard(as(owner, [WRITE]), {
      title: "Mine",
      visibility: "personal",
      spec: { v: 1, blocks: [] },
    })
    const toOrg = await call(owner, [WRITE, SHARE], "dashboards_update", {
      id: mine.id,
      visibility: "org",
    })
    expect(toOrg.blocked?.approvalRequestId).toBeString()
    const rename = await call(owner, [WRITE], "dashboards_update", {
      id: mine.id,
      title: "Renamed",
    })
    expect(rename.blocked).toBeUndefined()
    expect(rename.data).toMatchObject({ title: "Renamed", version: 2 })
  })

  it("a source the author cannot use is refused at save, naming the block", async () => {
    await expect(
      call(owner, [WRITE, READ], "dashboards_create", {
        title: "Bad",
        spec: { v: 1, blocks: [pieBlock(`${APP}:orders_cancel`)] },
      }),
    ).rejects.toMatchObject({
      code: "invalid_spec",
      message: expect.stringContaining("not_allowed"),
    })
  })
})

describe("preview and sources", () => {
  it("preview_block returns the mapped data and saves nothing", async () => {
    const before = (await listDashboards(as(owner, [WRITE]))).length
    const res = await call(owner, [WRITE, READ], "dashboards_preview_block", { block: pieBlock() })
    expect(res.data).toEqual({
      ok: true,
      data: {
        kind: "pie",
        labels: ["completed", "refunded"],
        series: [{ name: "total", values: [20, 5] }],
        meta: { sourceRows: 3, truncated: false, skippedRows: 0 },
      },
    })
    expect((await listDashboards(as(owner, [WRITE]))).length).toBe(before)
  })

  it("a refused preview names why and the eligible alternatives", async () => {
    const res = await call(owner, [WRITE, READ], "dashboards_preview_block", {
      block: pieBlock(`${APP}:orders_cancel`),
    })
    expect(res.data).toMatchObject({
      ok: false,
      reason: "not_allowed",
      message: expect.stringContaining("not a read"),
      alternatives: [`${APP}:orders_list`],
    })
    const invalid = await call(owner, [WRITE, READ], "dashboards_preview_block", {
      block: { ...pieBlock(), map: {} },
    })
    expect(invalid.data).toMatchObject({ ok: false, reason: "invalid_block" })
  })

  it("a store preview taints the thread as data_query does; a plain tool preview does not", async () => {
    await withRlsContext(as(owner, ["kernel:data:write"]), (tx) =>
      setDocument(tx, { orgId, app: "agent", userId: owner }, "leads", "l1", { stage: "new" }),
    )
    const toolThread = await minimal.thread(orgId, owner, { title: "Tool preview" })
    const tool = await call(
      owner,
      [WRITE, READ],
      "dashboards_preview_block",
      { block: pieBlock() },
      toolThread,
    )
    expect(tool.data).toMatchObject({ ok: true })
    expect(await isThreadTainted(toolThread, orgId)).toBe(false)

    const storeThread = await minimal.thread(orgId, owner, { title: "Store preview" })
    const store = await call(
      owner,
      [WRITE, "kernel:data:read"],
      "dashboards_preview_block",
      {
        block: {
          id: "leads",
          type: "metric",
          title: "Leads",
          source: { kind: "store", app: "agent", collection: "leads", query: {} },
          map: { agg: "count" },
        },
      },
      storeThread,
    )
    expect(store.data).toMatchObject({ ok: true })
    expect(await isThreadTainted(storeThread, orgId)).toBe(true)
  })

  it("a parked create's card says personal or org from the call's visibility", async () => {
    // A personal create parks too when the turn's taint parks it (scope-taint rule 8b).
    const card = (visibility: string) =>
      generateApprovalSummary(
        orgId,
        "kernel",
        "dashboards_create",
        { title: "Leads", visibility, spec: { v: 1, blocks: [pieBlock()] } },
        {} as never,
        "kernel:dashboards_create",
      )
    const personal = await card("personal")
    expect(personal.title).toBe('Save the personal dashboard "Leads"')
    expect(personal.lines.join("\n")).not.toContain("Everyone in the organisation")
    const org = await card("org")
    expect(org.title).toBe('Share the dashboard "Leads" with the organisation')
  })

  it("preview runs with the caller's roles, as the saved dashboard will for them", async () => {
    const [member] = await withPrivilegedDb(orgId, "dash-tools-role", (tx) =>
      tx.select({ id: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, owner)),
    )
    const res = await call(owner, [WRITE, ROLES_READ], "dashboards_preview_block", {
      block: {
        id: "roles",
        type: "table",
        title: "Roles",
        source: { kind: "tool", tool: `${ROLES_APP}:my_roles` },
        map: { columns: [{ field: "role", label: "Role" }] },
      },
    })
    expect(res).toMatchObject({ data: { ok: true, data: { kind: "table" } } })
    const rows = (res as { data: { data: { rows: { role: string }[] } } }).data.data.rows
    expect(rows.map((r) => r.role)).toContain(member?.id)
  })

  it("list and get need only kernel:dashboards:read, which every member holds", async () => {
    const shared = await createDashboard(as(owner, [WRITE, SHARE]), {
      title: "Team numbers",
      visibility: "org",
      spec: { v: 1, blocks: [] },
    })
    const listed = await call(other, ["kernel:dashboards:read"], "dashboards_list", {})
    expect(
      (listed as { data: { dashboards: { id: string }[] } }).data.dashboards.map((d) => d.id),
    ).toContain(shared.id)
    const got = await call(other, ["kernel:dashboards:read"], "dashboards_get", { id: shared.id })
    expect(got).toMatchObject({ data: { id: shared.id, canEdit: false } })
  })

  it("preview runs as the caller: without the tool's scope it is no_access", async () => {
    const res = await call(other, [WRITE], "dashboards_preview_block", { block: pieBlock() })
    expect(res.data).toMatchObject({ ok: false, reason: "no_access" })
  })

  it("sources lists the reads this person may chart, with params and result fields", async () => {
    const res = await call(owner, [WRITE, READ], "dashboards_sources", { query: "orders" })
    const sources = (res.data as { sources: EligibleSource[] }).sources
    expect(sources).toContainEqual({
      tool: `${APP}:orders_list`,
      description: "List the shop's orders",
      params: ["status"],
      outputFields: ["orders"],
    })
    expect(sources.map((s) => s.tool)).not.toContain(`${APP}:orders_cancel`)
    const none = await call(other, [WRITE], "dashboards_sources", { query: "orders" })
    expect((none.data as { sources: { tool: string }[] }).sources.map((s) => s.tool)).not.toContain(
      `${APP}:orders_list`,
    )
  })
})

describe("the approval's deciding scope", () => {
  it("is kernel:dashboards:admin: an admin's own agent card says they can decide it", async () => {
    const res = await call(owner, [WRITE, ADMIN, READ], "dashboards_create", {
      title: "Admin's",
      visibility: "org",
      spec: { v: 1, blocks: [] },
    })
    expect(res.blocked?.requesterCanApprove).toBe(true)
  })
})

describe("dashboards_edit", () => {
  const metric = (id: string, params: Record<string, unknown> = {}) => ({
    id,
    type: "metric",
    title: `Tile ${id}`,
    source: { kind: "tool", tool: `${APP}:orders_list`, params },
    map: { value: "total", agg: "sum" },
  })

  async function approve(requestId: string, approver: string) {
    const [row] =
      await sql`SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${requestId}`
    return decideApproval({
      orgId,
      requestId,
      actor: as(approver, [WRITE, ADMIN, READ, "kernel:approve"]),
      decision: "approve",
      payloadHash: approvalPayloadHash(row!.tool_name as string, row!.current_payload),
    })
  }

  it("a personal dashboard's edit applies at once, every operation together", async () => {
    const mine = await createDashboard(as(owner, [WRITE, READ]), {
      title: "Mine to edit",
      visibility: "personal",
      spec: { v: 1, blocks: [metric("a"), metric("b")] },
    })
    const res = await call(owner, [WRITE, READ], "dashboards_edit", {
      dashboardId: mine.id,
      ifVersion: mine.version,
      operations: [
        { op: "moveBlock", blockId: "b", position: 0 },
        { op: "setTimeRange", timeRange: { preset: "lastMonth" } },
      ],
    })
    expect(res.blocked).toBeUndefined()
    expect(res.data).toMatchObject({ version: 2, blocks: ["b", "a"] })
  })

  it("an org dashboard's edit is ONE approval listing every change, and nothing changes until it is approved", async () => {
    // An administrator who holds kernel:dashboards:admin, so the card reaches them.
    const approver = (await minimal.person(orgId)).id
    await minimal.grantScope(approver, ADMIN)
    // The requester's own grants: the approved edit runs as them, and re-checks every source.
    const author = (await minimal.person(orgId)).id
    for (const scope of [WRITE, SHARE, READ]) await minimal.grantScope(author, scope)
    const shared = await createDashboard(as(author, [WRITE, SHARE, READ]), {
      title: "Direction",
      visibility: "org",
      spec: { v: 1, blocks: [metric("a"), metric("b")] },
    })
    const res = await call(author, [WRITE, SHARE, READ], "dashboards_edit", {
      dashboardId: shared.id,
      ifVersion: shared.version,
      operations: [
        {
          op: "addBlock",
          block: metric("spend", { status: "{{range.from}}", until: "{{range.to}}" }),
          position: { after: "a" },
        },
        { op: "updateBlock", blockId: "b", changes: { title: "Open orders" } },
        { op: "removeBlock", blockId: "a" },
        { op: "setTitle", title: "Sales direction" },
      ],
    })
    const summary = res.blocked?.summary
    expect(res.blocked?.approvalRequestId).toBeString()
    expect(summary?.kind).toBe("dashboard_edit")
    expect(summary?.title).toBe('Change the org dashboard "Direction": 4 changes')
    expect(summary?.lines).toHaveLength(4)
    expect(summary?.lines[0]).toStartWith(
      `1. Add a metric block "Tile spend" (width 1) at position 2 of 3 (after "Tile a"), reading ${APP}:orders_list`,
    )
    expect(summary?.lines[0]).toContain("{{range.from}} = the dashboard range's start")
    expect(summary?.lines[1]).toBe('2. Change the block "Tile b": title "Tile b" → "Open orders".')
    expect(summary?.lines[2]).toStartWith('3. Remove the metric block "Tile a"')
    expect(summary?.lines[3]).toBe('4. Rename the dashboard "Direction" → "Sales direction".')
    expect(await getDashboard(as(author, [WRITE]), shared.id)).toMatchObject({ version: 1 })

    expect(res.blocked?.requesterCanApprove).toBe(false)
    const decided = await approve(res.blocked!.approvalRequestId, approver)
    expect(decided.status).toBe("approved")
    const after = await getDashboard(as(author, [WRITE]), shared.id)
    expect(after.version).toBe(2)
    expect(after.title).toBe("Sales direction")
    expect(after.spec.blocks.map((b) => b.id)).toEqual(["spend", "b"])
    expect(after.blockTimeRange).toEqual({ spend: "dashboard", b: "fixed" })
  })

  it("an edit written against an older version is refused, naming the conflict", async () => {
    const mine = await createDashboard(as(owner, [WRITE, READ]), {
      title: "Raced",
      visibility: "personal",
      spec: { v: 1, blocks: [metric("a")] },
    })
    await call(owner, [WRITE, READ], "dashboards_edit", {
      dashboardId: mine.id,
      ifVersion: 1,
      operations: [{ op: "setTitle", title: "First" }],
    })
    await expect(
      call(owner, [WRITE, READ], "dashboards_edit", {
        dashboardId: mine.id,
        ifVersion: 1,
        operations: [{ op: "setTitle", title: "Second" }],
      }),
    ).rejects.toMatchObject({ code: "version_conflict" })
  })
})
