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
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { isThreadTainted } from "~/modules/agent/scopes/taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
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
    expect(res.blocked?.summary?.lines.join("\n")).toContain(`reading ${APP}:orders_list`)
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
    expect(res.blocked?.summary?.lines.join("\n")).toContain(`{{startOfMonth}} = ${month}-01 today`)
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

  it("preview_block reads a dataset and applies filter values to the rows", async () => {
    const res = await call(owner, [WRITE, READ], "dashboards_preview_block", {
      block: {
        id: "by-status",
        type: "metric",
        title: "Completed",
        dataset: "orders",
        map: {
          value: "total",
          where: [{ field: "status", op: "eq", value: { filter: "status" } }],
        },
      },
      datasets: { orders: { kind: "tool", tool: `${APP}:orders_list` } },
      filters: [
        { id: "status", label: "Status", type: "select", options: ["completed", "refunded"] },
      ],
      filterValues: { status: ["refunded"] },
    })
    expect(res.data).toMatchObject({ ok: true, data: { kind: "metric", value: 5 } })
    const missing = await call(owner, [WRITE, READ], "dashboards_preview_block", {
      block: { id: "x", type: "metric", title: "X", dataset: "nope", map: { agg: "count" } },
    })
    expect(missing.data).toMatchObject({ ok: false, reason: "invalid_block" })
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

  it("a new org dashboard's card lists its datasets, filters and notes in full", async () => {
    const text = `${"Harmless intro. ".repeat(20)}[Renew your access](https://phish.example/x)`
    const card = await generateApprovalSummary(
      orgId,
      "kernel",
      "dashboards_create",
      {
        title: "Leads",
        visibility: "org",
        spec: {
          v: 1,
          datasets: { orders: { kind: "tool", tool: `${APP}:orders_list` } },
          filters: [{ id: "market", label: "Market", type: "select", options: ["FR", "DE"] }],
          blocks: [pieBlock(), { id: "n", type: "text", title: "Notes", text }],
        },
      },
      {} as never,
      "kernel:dashboards_create",
    )
    const all = card.lines.join("\n")
    expect(all).toContain("Add the shared dataset 'orders'")
    expect(all).toContain('Add the filter "Market"')
    expect(all).toContain("Links in the note: https://phish.example/x")
    expect(all.replace(/\n\s+Note text \(\d\/\d\): /g, "")).toContain("[Renew your access]")
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

describe("a turn narrowed below the person's own scopes", () => {
  const SCOPED_APP = "dshnarrow"
  const SALES_READ = `${SCOPED_APP}:sales:read`
  let salesReads = 0

  /** A shared room's turn: the effective scope holds the dashboards read, not the sales read. */
  const narrowedTurn = (): RunContext => {
    const runId = crypto.randomUUID()
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      effectiveScope: ["kernel:dashboards:read"],
      turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
    }
  }

  async function salesDashboard(): Promise<string> {
    toolRegistry.set([orgId, SCOPED_APP, "sales_list"], {
      appName: SCOPED_APP,
      name: "sales_list",
      description: "List the sales",
      requiredScopes: [SALES_READ],
      readOnly: true,
      params: z.object({}),
      returns: { schema: { sales: "object" } },
      handler: async () => {
        salesReads += 1
        return { sales: [{ region: "north", amount: "4242" }] }
      },
    })
    const created = await createDashboard(as(owner, [WRITE, SALES_READ]), {
      title: "Sales by region",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "sales",
            type: "pie",
            title: "Sales by region",
            source: { kind: "tool", tool: `${SCOPED_APP}:sales_list` },
            map: { groupBy: { field: "region" }, value: "amount", agg: "sum" },
          },
        ],
      },
    })
    return created.id
  }

  const FULL = ["kernel:dashboards:read", WRITE, SALES_READ]

  it("a snapshot computes its figures with the turn's scopes, not the person's own", async () => {
    const id = await salesDashboard()
    salesReads = 0
    const res = await runContextStore.run(narrowedTurn(), () =>
      call(owner, FULL, "dashboards_snapshot", { dashboardId: id }),
    )
    expect(salesReads).toBe(0)
    expect(JSON.stringify(res)).not.toContain("4242")
    const block = (res as { data: { blocks: { id: string; error?: string }[] } }).data.blocks[0]
    expect(block).toMatchObject({ id: "sales", error: "no_access" })

    // The same person outside a narrowed turn reads their figures.
    const own = await call(owner, FULL, "dashboards_snapshot", { dashboardId: id })
    expect(JSON.stringify(own)).toContain("4242")
  })

  it("a PDF computes its figures with the turn's scopes, not the person's own", async () => {
    const id = await salesDashboard()
    salesReads = 0
    // A conversation of its own: nothing read earlier in this file taints it.
    const room = await minimal.thread(orgId, owner, { title: "Sales PDF" })
    const res = await runContextStore.run(narrowedTurn(), () =>
      call(owner, FULL, "dashboards_pdf", { dashboardId: id }, room),
    )
    expect(res).toMatchObject({ data: { fileId: expect.any(String) } })
    expect(salesReads).toBe(0)
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
    const requestId = res.blocked?.approvalRequestId
    if (!requestId) throw new Error("the edit did not park an approval")
    const decided = await approve(requestId, approver)
    expect(decided.status).toBe("approved")
    const after = await getDashboard(as(author, [WRITE]), shared.id)
    expect(after.version).toBe(2)
    expect(after.title).toBe("Sales direction")
    expect(after.spec.blocks.map((b) => b.id)).toEqual(["spend", "b"])
    expect(after.blockTimeRange).toEqual({ spend: "dashboard", b: "fixed" })
  })

  it("an org edit that cannot apply is refused before any approval is staged", async () => {
    const author = (await minimal.person(orgId)).id
    for (const scope of [WRITE, SHARE, READ]) await minimal.grantScope(author, scope)
    const shared = await createDashboard(as(author, [WRITE, SHARE, READ]), {
      title: "Checked first",
      visibility: "org",
      spec: { v: 1, blocks: [metric("a")] },
    })
    const pending = async () =>
      Number(
        (
          await sql`SELECT count(*)::int AS n FROM kernel.approval_requests
            WHERE org_id = ${orgId} AND tool_name = 'kernel:dashboards_edit'
              AND current_payload->>'dashboardId' = ${shared.id}`
        )[0]!.n,
      )
    const edit = (ifVersion: number, operations: unknown[]) =>
      call(author, [WRITE, SHARE, READ], "dashboards_edit", {
        dashboardId: shared.id,
        ifVersion,
        operations,
      })
    await expect(
      edit(1, [{ op: "updateBlock", blockId: "nope", changes: { title: "x" } }]),
    ).rejects.toMatchObject({
      code: "invalid_spec",
      message: expect.stringContaining("no block 'nope'"),
    })
    await expect(edit(1, [{ op: "addBlock", block: metric("a") }])).rejects.toMatchObject({
      code: "invalid_spec",
      message: expect.stringContaining("already on the dashboard"),
    })
    await expect(
      edit(1, [{ op: "addBlock", block: { ...metric("m"), map: { columns: "bad" } } }]),
    ).rejects.toMatchObject({ code: "invalid_spec" })
    await expect(
      edit(1, [
        {
          op: "addBlock",
          block: { ...metric("r"), source: { kind: "tool", tool: `${ROLES_APP}:my_roles` } },
        },
      ]),
    ).rejects.toMatchObject({ code: "invalid_spec", message: expect.stringContaining("no_access") })
    await expect(edit(7, [{ op: "setTitle", title: "Late" }])).rejects.toMatchObject({
      code: "version_conflict",
    })
    expect(await pending()).toBe(0)
    // The same request, valid, stages its one card.
    const ok = await edit(1, [{ op: "setTitle", title: "Fine" }])
    expect(ok.blocked?.approvalRequestId).toBeString()
    expect(await pending()).toBe(1)
  })

  it("more changes than one card lists are refused, saying to split and wait", async () => {
    const mine = await createDashboard(as(owner, [WRITE, READ]), {
      title: "Many",
      visibility: "personal",
      spec: { v: 1, blocks: [metric("a")] },
    })
    const operations = Array.from({ length: 51 }, (_, i) => ({ op: "setTitle", title: `T${i}` }))
    await expect(
      call(owner, [WRITE, READ], "dashboards_edit", {
        dashboardId: mine.id,
        ifVersion: 1,
        operations,
      }),
    ).rejects.toMatchObject({
      code: "too_many_changes",
      message: expect.stringContaining("send the rest only once that approval is decided"),
    })
  })

  it("a whole-spec update of an org dashboard lists every change on its card", async () => {
    const author = (await minimal.person(orgId)).id
    for (const scope of [WRITE, SHARE, READ]) await minimal.grantScope(author, scope)
    const shared = await createDashboard(as(author, [WRITE, SHARE, READ]), {
      title: "Rebuilt",
      visibility: "org",
      spec: { v: 1, blocks: [metric("a"), metric("b"), metric("c")] },
    })
    const res = await call(author, [WRITE, SHARE, READ], "dashboards_update", {
      id: shared.id,
      ifVersion: 1,
      spec: {
        v: 1,
        timeRange: { preset: "lastMonth" },
        blocks: [metric("c"), { ...metric("a"), map: { value: "total", agg: "avg" } }],
      },
    })
    const summary = res.blocked?.summary
    expect(summary?.kind).toBe("dashboard_update")
    expect(summary?.title).toBe('Change the org dashboard "Rebuilt": 4 changes')
    expect(summary?.lines[0]).toStartWith(
      "1. Default time range: the dashboard opens on last month",
    )
    expect(summary?.lines[1]).toStartWith('2. Remove the metric block "Tile b"')
    expect(summary?.lines[2]).toBe('3. Change the block "Tile a": now shows avg of total.')
    expect(summary?.lines[3]).toStartWith(
      '4. Move the block "Tile c" from position 2 to position 1 of 2',
    )
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
