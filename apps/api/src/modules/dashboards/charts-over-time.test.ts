// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step 4 on real Postgres (the cache on a fake store): a date chart that follows the range is
// zero-filled with its comparison aligned, its headline carries the comparison's figure and
// today's bucket is in progress; a layered block runs each layer as its own source (a dataset
// layer shares the dataset's run), a layer the viewer cannot read fails alone, the drill-down
// reads one layer; the approval card describes layers, curve and headline.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { type BlockCacheStore, BlockCacheTestAccess } from "~/modules/dashboards/cache"
import { describeOperations } from "~/modules/dashboards/edit"
import {
  createDashboard,
  type DashboardError,
  getBlockData,
  getBlockRows,
} from "~/modules/dashboards/service"
import type { DashboardSpec } from "~/modules/dashboards/spec"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "dshstep4"
const READ_UNITS = `${APP}:units:read`
const READ_SESSIONS = `${APP}:sessions:read`
const WRITE = "kernel:dashboards:write"
const ALL = [WRITE, READ_UNITS, READ_SESSIONS]

let orgId = ""
let owner = ""
const runs: { tool: string; params: Record<string, unknown> }[] = []

// "now" is 2026-11-12 at noon UTC; the org has no zone set (UTC).
const NOW = new Date("2026-11-12T12:00:00Z")

const as = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: {},
})

function fakeStore(): BlockCacheStore {
  const data = new Map<string, string>()
  return {
    async get(k) {
      return data.get(k) ?? null
    },
    async set(k, v) {
      data.set(k, v)
    },
    async setIfAbsent(k) {
      if (data.has(k)) return false
      data.set(k, "1")
      return true
    },
    async increment(k) {
      const n = Number(data.get(k) ?? 0) + 1
      data.set(k, String(n))
      return n
    },
  }
}

/** Rows dated inside [from, to] only, as a real tool reading a period would. */
const inWindow = <T extends { day: string }>(rows: T[], p: { from?: string; to?: string }) =>
  rows.filter((r) => (!p.from || r.day >= p.from) && (!p.to || r.day <= p.to))

const UNITS = [
  { id: "u1", day: "2026-11-03", product: "Pad", units: 2 },
  { id: "u2", day: "2026-11-03", product: "Cable", units: 1 },
  { id: "u3", day: "2026-11-12", product: "Pad", units: 4 },
  { id: "u4", day: "2026-10-05", product: "Pad", units: 3 },
]
const SESSIONS = [
  { day: "2026-11-03", sessions: 30 },
  { day: "2026-11-12", sessions: 20 },
  { day: "2026-10-03", sessions: 25 },
  { day: "2026-10-05", sessions: 35 },
]

const range = { from: "{{range.from}}", to: "{{range.to}}" }
const UNITS_SOURCE = { kind: "tool", tool: `${APP}:units_read`, params: range }
const SESSIONS_SOURCE = { kind: "tool", tool: `${APP}:sessions_read`, params: range }

const SPEC = {
  v: 1,
  timeRange: { preset: "mtd" },
  compare: "previousPeriod",
  datasets: { sessions: SESSIONS_SOURCE },
  blocks: [
    {
      id: "over-time",
      type: "line",
      title: "Sessions over time",
      dataset: "sessions",
      map: {
        groupBy: { field: "day", bucket: "day" },
        y: "sessions",
        curve: "smooth",
        headline: "total",
      },
    },
    {
      id: "blend",
      type: "combo",
      title: "Units and sessions",
      width: 3,
      layers: [
        {
          id: "units",
          label: "Units",
          as: "bar",
          source: UNITS_SOURCE,
          map: {
            groupBy: { field: "day", bucket: "day" },
            y: "units",
            series: "product",
            stacked: true,
            headline: "total",
            link: "/orders/{{id}}",
          },
        },
        {
          id: "sessions",
          label: "Sessions",
          as: "line",
          axis: "right",
          dataset: "sessions",
          map: { groupBy: { field: "day", bucket: "day" }, y: "sessions", headline: "total" },
        },
      ],
      map: {
        curve: "smooth",
        headlineCalc: [{ label: "Units per session", expr: "units / sessions" }],
      },
    },
  ],
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboards Step4 Org" })).orgId
  owner = (await minimal.person(orgId)).id
  const tool = (name: string, scope: string, rows: { day: string }[]) =>
    toolRegistry.set([orgId, APP, name], {
      appName: APP,
      name,
      description: `Read ${name}`,
      requiredScopes: [scope],
      readOnly: true,
      params: z.object({ from: z.string().optional(), to: z.string().optional() }),
      handler: async (p: unknown) => {
        runs.push({ tool: name, params: p as Record<string, unknown> })
        return { items: inWindow(rows, p as { from?: string; to?: string }) }
      },
    })
  tool("units_read", READ_UNITS, UNITS)
  tool("sessions_read", READ_SESSIONS, SESSIONS)
})

afterEach(() => BlockCacheTestAccess.setStore(null))

afterAll(async () => {
  await releaseTestLock()
})

async function dashboard() {
  return (
    await createDashboard(as(owner, ALL), { title: "Step 4", visibility: "personal", spec: SPEC })
  ).id
}

describe("a metric over time", () => {
  it("is zero-filled day by day, compared on the same days, with its headline and today in progress", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const out = await getBlockData(as(owner, ALL), id, "over-time", { now: NOW })
    if (!out.ok || !("labels" in out.data)) throw new Error(JSON.stringify(out))
    expect(out.window).toMatchObject({ mode: "dashboard", from: "2026-11-01", to: "2026-11-12" })
    expect(out.compareWindow).toMatchObject({ from: "2026-10-01", to: "2026-10-12" })
    expect(out.data.labels.length).toBe(12)
    expect(out.data.series[0]!.values[2]).toBe(30)
    expect(out.data.series[0]!.values[0]).toBe(0)
    expect(out.data.inProgressLabel).toBe("2026-11-12")
    expect(out.data.display).toEqual({ curve: "smooth" })
    expect(out.data.headline).toEqual([
      { key: "total", label: "sessions", value: 50, previous: 60 },
    ])
    expect(out.data.previous!.labels[0]).toBe("2026-10-01")
    expect(out.data.previous!.series[0]!.values.slice(0, 5)).toEqual([0, 0, 25, 0, 35])
  })
})

describe("a layered block", () => {
  it("runs each layer as its own source; the dataset layer shares the dataset's run", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const viewer = as(owner, ALL)
    runs.length = 0
    const [blend] = await Promise.all([
      getBlockData(viewer, id, "blend", { now: NOW, compare: "none" }),
      getBlockData(viewer, id, "over-time", { now: NOW, compare: "none" }),
    ])
    expect(runs.filter((r) => r.tool === "sessions_read").length).toBe(1)
    expect(runs.filter((r) => r.tool === "units_read").length).toBe(1)
    if (!blend.ok || !("labels" in blend.data)) throw new Error(JSON.stringify(blend))
    const d = blend.data
    expect(d.kind).toBe("combo")
    expect(d.series.map((s) => s.name)).toEqual(["Pad", "Cable", "Sessions"])
    expect(d.display).toMatchObject({
      lineSeries: ["Sessions"],
      rightAxis: ["Sessions"],
      stacked: true,
    })
    expect(d.headline!.map((f) => [f.key, f.value])).toEqual([
      ["units", 7],
      ["sessions", 50],
      ["Units per session", 0.14],
    ])
    expect(d.layers!.map((l) => l.id)).toEqual(["units", "sessions"])
    expect(blend.window).toMatchObject({ from: "2026-11-01", to: "2026-11-12" })
  })

  it("a layer the viewer cannot read fails alone; the comparison applies per layer", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const out = await getBlockData(as(owner, [WRITE, READ_SESSIONS]), id, "blend", {
      now: NOW,
      range: { preset: "custom", from: "2026-11-01", to: "2026-11-05" },
      compare: "previousPeriod",
    })
    if (!out.ok || !("labels" in out.data)) throw new Error(JSON.stringify(out))
    expect(out.data.layers![0]!.error?.error).toBe("no_access")
    expect(out.data.series.map((s) => s.name)).toEqual(["Sessions"])
    // 2026-10-27 .. 2026-10-31: no session then.
    expect(out.data.headline!.find((f) => f.key === "sessions")).toMatchObject({
      value: 30,
      previous: 0,
    })
    const none = await getBlockData(as(owner, [WRITE]), id, "blend", { now: NOW })
    expect(none.ok).toBe(false)
  })

  it("drills into one layer, and asks which one", async () => {
    BlockCacheTestAccess.setStore(fakeStore())
    const id = await dashboard()
    const rows = await getBlockRows(as(owner, ALL), id, "blend", {
      now: NOW,
      layer: "units",
      category: "2026-11-03",
      series: "Pad",
    })
    if (!rows.ok) throw new Error(JSON.stringify(rows))
    expect(rows.rows.map((r) => r.id)).toEqual(["u1"])
    expect(rows.links).toEqual([{ kind: "path", href: "/orders/u1" }])
    const missing = await getBlockRows(as(owner, ALL), id, "blend", { now: NOW }).catch(
      (e: DashboardError) => e,
    )
    expect((missing as DashboardError).code).toBe("INVALID_REQUEST")
  })

  it("refuses a layer source the author cannot read at save", async () => {
    const err = await createDashboard(as(owner, [WRITE, READ_SESSIONS]), {
      title: "No units",
      visibility: "personal",
      spec: SPEC,
    }).catch((e: DashboardError) => e)
    expect((err as DashboardError).problems?.join("\n")).toContain(
      "blocks.1.layers.0 (blend, layer units)",
    )
  })
})

describe("the approval card", () => {
  it("describes layers, the curve and the headline in plain words", () => {
    const lines = describeOperations(
      {
        title: "D",
        visibility: "org",
        spec: {
          v: 1,
          layout: "grid",
          blocks: [],
          datasets: SPEC.datasets,
        } as unknown as DashboardSpec,
      },
      [{ op: "addBlock", block: SPEC.blocks[1] as Record<string, unknown> }],
      { timeZone: "UTC", now: NOW },
    )
    // The block on one line, each layer on its own numbered line under it.
    expect(lines).toHaveLength(3)
    const line = lines[0]!
    expect(line).toContain(
      `blending 2 layers joined on their date bucket ("Units", "Sessions"), each on its own line below`,
    )
    expect(line).toContain(`smooth curve, headline figure "Units per session" = units / sessions`)
    expect(lines[1]).toStartWith(
      `   1.1. Layer "Units": bars, sum of units by day per day, split by product, stacked, headline: the period's total`,
    )
    expect(lines[2]).toStartWith(`   1.2. Layer "Sessions": a line on the right axis`)
    // The dataset is on the dashboard, unchanged, and not on this card: its tool, no params.
    expect(lines[2]).toContain(`reading the shared dataset 'sessions' (${APP}:sessions_read).`)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(500)
  })
})
