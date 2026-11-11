// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/dashboards over HTTP: a person's remembered range (read, set, cleared; nobody
// else's), the dashboard record naming the range it opens on, and a block's data for the
// range in the query, a malformed range refused before any run.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { app } from "~/app"
import type { UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createDashboard } from "~/modules/dashboards/service"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "dshroutes"
const READ = `${APP}:orders:read`
const WRITE = "kernel:dashboards:write"

let orgId = ""
let owner = ""
let other = ""
let dashboardId = ""
let personalId = ""
const seen: unknown[] = []

const as = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: {},
})

async function req(userId: string, method: string, path: string, body?: unknown) {
  const token = await minimal.token(userId)
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as { data?: any; error?: any } }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboard Routes Org" })).orgId
  owner = (await minimal.person(orgId)).id
  other = (await minimal.person(orgId)).id
  await minimal.grantScope(owner, READ)
  await minimal.grantScope(owner, "kernel:dashboards:share")
  toolRegistry.set([orgId, APP, "orders_list"], {
    appName: APP,
    name: "orders_list",
    description: "List orders between two days",
    requiredScopes: [READ],
    readOnly: true,
    params: z.object({ since: z.string(), until: z.string() }),
    handler: async (p: unknown) => {
      seen.push(p)
      return { items: [{ total: 2 }, { total: 3 }] }
    },
  })
  const block = {
    id: "sales",
    type: "metric",
    title: "Sales",
    source: {
      kind: "tool",
      tool: `${APP}:orders_list`,
      params: { since: "{{range.from}}", until: "{{range.to}}" },
    },
    map: { value: "total" },
  }
  dashboardId = (
    await createDashboard(as(owner, [WRITE, "kernel:dashboards:share", READ]), {
      title: "Ranged",
      visibility: "org",
      spec: { v: 1, timeRange: { preset: "mtd" }, compare: "none", blocks: [block] },
    })
  ).id
  personalId = (
    await createDashboard(as(owner, [WRITE, READ]), {
      title: "Mine",
      visibility: "personal",
      spec: { v: 1, blocks: [] },
    })
  ).id
})

afterAll(async () => {
  await releaseTestLock()
})

describe("a person's remembered range", () => {
  it("is null until set, then theirs; the record opens on it; DELETE forgets it", async () => {
    const base = `/api/dashboards/${dashboardId}`
    expect((await req(owner, "GET", `${base}/viewer-state`)).body.data).toBeNull()
    const opened = await req(owner, "GET", base)
    expect(opened.body.data).toMatchObject({
      range: { timeRange: { preset: "mtd" }, compare: "none", saved: false, compareWindow: null },
      defaultRange: { timeRange: { preset: "mtd" }, compare: "none" },
      blockTimeRange: { sales: "dashboard" },
      usesTimeRange: true,
    })

    const choice = {
      timeRange: { preset: "custom", from: "2026-01-01", to: "2026-01-31" },
      compare: "lastYear",
    }
    expect((await req(owner, "PUT", `${base}/viewer-state`, choice)).body.data).toEqual(choice)
    expect((await req(owner, "GET", base)).body.data.range).toEqual({
      ...choice,
      saved: true,
      window: { from: "2026-01-01", to: "2026-01-31" },
      compareWindow: { from: "2025-01-01", to: "2025-01-31" },
    })
    // Another member sees the dashboard, not the owner's choice.
    expect((await req(other, "GET", `${base}/viewer-state`)).body.data).toBeNull()

    expect((await req(owner, "DELETE", `${base}/viewer-state`)).body.data).toEqual({
      cleared: true,
    })
    expect((await req(owner, "GET", `${base}/viewer-state`)).body.data).toBeNull()
  })

  it("refuses a malformed range, and a dashboard the person cannot see", async () => {
    const bad = await req(owner, "PUT", `/api/dashboards/${dashboardId}/viewer-state`, {
      timeRange: { preset: "custom", from: "2026-02-01" },
      compare: "none",
    })
    expect(bad.status).toBe(400)
    const hidden = await req(other, "PUT", `/api/dashboards/${personalId}/viewer-state`, {
      timeRange: { preset: "mtd" },
      compare: "none",
    })
    expect(hidden.status).toBe(404)
  })
})

describe("a block's data for a range", () => {
  it("reads the range in the query and names its window", async () => {
    seen.length = 0
    const path = `/api/dashboards/${dashboardId}/blocks/sales/data`
    const res = await req(
      owner,
      "GET",
      `${path}?from=2026-03-01&to=2026-03-10&compare=previousPeriod`,
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      kind: "metric",
      value: 5,
      previous: 5,
      window: { mode: "dashboard", preset: "custom", from: "2026-03-01", to: "2026-03-10" },
      compareWindow: { mode: "previousPeriod", from: "2026-02-19", to: "2026-02-28" },
    })
    expect(res.body.data.computedAt).toBeString()
    expect(seen).toEqual([
      { since: "2026-03-01", until: "2026-03-10" },
      { since: "2026-02-19", until: "2026-02-28" },
    ])
  })

  it("refuses a malformed range before any run", async () => {
    seen.length = 0
    const path = `/api/dashboards/${dashboardId}/blocks/sales/data`
    expect((await req(owner, "GET", `${path}?range=mtd&from=2026-03-01`)).status).toBe(400)
    expect((await req(owner, "GET", `${path}?range=custom&from=2026-03-01`)).status).toBe(400)
    expect((await req(owner, "GET", `${path}?range=lastWeek`)).status).toBe(400)
    expect((await req(owner, "GET", `${path}?compare=sometimes`)).status).toBe(400)
    expect(seen).toEqual([])
  })
})
