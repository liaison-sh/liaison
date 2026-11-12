// SPDX-License-Identifier: FSL-1.1-ALv2
//
// incidents_summary handler over the in-memory AppContext double: bounded
// reads by status, severity buckets, source health, resolved-24h window.
import { describe, expect, it } from "bun:test"
import { incidentsSummaryHandler } from "./incidents"
import { makeCtx } from "./test-ctx"

async function seed(
  ctx: ReturnType<typeof makeCtx>["ctx"],
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  for (const r of rows) await ctx.db.insert("incidents", r)
}

describe("incidentsSummaryHandler", () => {
  it("aggregates live incidents and the resolved-24h window", async () => {
    const { ctx } = makeCtx()
    const now = Date.now()
    await seed(ctx, [
      { source: "watchdog-prod", severity: "critical", title: "a", status: "open", count: 3, last_seen_at: new Date(now - 60_000).toISOString() },
      { source: "watchdog-prod", severity: "warning", title: "b", status: "acknowledged", count: 1, last_seen_at: new Date(now - 120_000).toISOString() },
      { source: "shopify-disputes", severity: "warning", title: "c", status: "open", count: 1, last_seen_at: new Date(now - 30_000).toISOString() },
      { source: "watchdog-prod", severity: "info", title: "d", status: "resolved", count: 1, resolved_at: new Date(now - 3_600_000).toISOString(), last_seen_at: new Date(now - 3_600_000).toISOString() },
      { source: "watchdog-prod", severity: "info", title: "e", status: "resolved", count: 1, resolved_at: new Date(now - 48 * 3_600_000).toISOString(), last_seen_at: new Date(now - 48 * 3_600_000).toISOString() },
    ])
    const res = await incidentsSummaryHandler({}, ctx)
    expect(res.data.open).toEqual({ critical: 1, warning: 1, info: 0, total: 2 })
    expect(res.data.acknowledged).toBe(1)
    expect(res.data.resolved24h).toBe(1)
    const prod = res.data.sources.find((s) => s.source === "watchdog-prod")
    expect(prod?.open).toBe(2)
    expect(prod?.worstSeverity).toBe("critical")
    expect(res.data.sources.map((s) => s.source)).toContain("shopify-disputes")
    // The counts as rows, the list a dashboard block charts.
    expect(res.rows).toEqual([
      { key: "critical", status: "open", value: 1 },
      { key: "warning", status: "open", value: 1 },
      { key: "info", status: "open", value: 0 },
      { key: "acknowledged", status: "acknowledged", value: 1 },
      { key: "resolved24h", status: "resolved", value: 1 },
    ])
  })

  it("returns an empty board when nothing is tracked", async () => {
    const { ctx } = makeCtx()
    const res = await incidentsSummaryHandler({}, ctx)
    expect(res.data.open.total).toBe(0)
    expect(res.data.sources).toEqual([])
  })
})

// C2 / C7: the summary is the UI's one source of truth for source profiles,
// the configured order, the detailed-monitoring link and the settings gear.
describe("incidentsSummaryHandler: profiles and config", () => {
  it("returns profiles, warnings, the ordered source list, monitoringUrl and canConfigure", async () => {
    const { ctx } = makeCtx({
      config: {
        monitoringSources: [{ source: "watchdog-prod", label: "Production", rank: 1, urgent: true }, { source: "bad", hue: -1 }],
        monitoringUrl: "https://grafana.example.com/d/1",
      },
      scopes: ["kernel:apps:admin"],
    })
    await seed(ctx, [
      { source: "shopify-disputes", severity: "warning", title: "c", status: "open", count: 1, last_seen_at: new Date().toISOString() },
      { source: "cron", severity: "info", title: "d", status: "open", count: 1, last_seen_at: new Date().toISOString() },
    ])
    const res = await incidentsSummaryHandler({}, ctx)
    expect(res.data.profiles).toEqual([{ source: "watchdog-prod", label: "Production", rank: 1, urgent: true }])
    expect(res.data.warnings.length).toBe(1)
    expect(res.data.sourceOrder).toEqual(["watchdog-prod", "cron", "shopify-disputes"])
    expect(res.data.sources.find((s) => s.source === "cron")?.profile).toBeNull()
    expect(res.data.monitoringUrl).toBe("https://grafana.example.com/d/1")
    expect(res.data.canConfigure).toBe(true)
  })

  it("hides a non-http monitoringUrl and denies configure without kernel:apps:admin", async () => {
    const { ctx } = makeCtx({ config: { monitoringUrl: "javascript:alert(1)" }, scopes: ["monitoring:incidents:read"] })
    const res = await incidentsSummaryHandler({}, ctx)
    expect(res.data.monitoringUrl).toBeNull()
    expect(res.data.canConfigure).toBe(false)
    expect(res.data.profiles).toEqual([])
    expect(res.data.sourceOrder).toEqual([])
  })

  it("grants configure through a wildcard kernel grant", async () => {
    const { ctx } = makeCtx({ scopes: ["kernel:*"] })
    expect((await incidentsSummaryHandler({}, ctx)).data.canConfigure).toBe(true)
  })
})
