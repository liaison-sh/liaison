// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's dashboard tools through the real tool core: a personal dashboard
// is a plain write; anything resulting in or touching an org dashboard parks an
// approval decided by kernel:dashboards:admin and changes nothing until then;
// preview_block returns what the chart would draw, and a refused source names
// eligible alternatives; sources lists the reads this person may chart.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { createDashboard, getDashboard, listDashboards } from "~/modules/dashboards/service"
import type { EligibleSource } from "~/modules/dashboards/sources"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "dshtools"
const READ = `${APP}:orders:read`
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

function call(userId: string, scopes: string[], name: string, params: unknown) {
  return executeTool({
    toolName: `kernel:${name}`,
    orgId,
    actor: as(userId, scopes),
    params,
    threadId,
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
