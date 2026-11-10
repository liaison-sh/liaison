// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DashboardSummary } from "./dashboards-client"
import {
  dashboardRevision,
  dashboardsList,
  dashboardsLoaded,
  handleDashboardEvent,
  loadDashboards,
  rememberDashboard,
  resetDashboardsStore,
} from "./dashboards-store"

describe("rememberDashboard", () => {
  beforeEach(() => resetDashboardsStore())

  it("adds a dashboard the list does not have yet (one the agent just made), once", () => {
    const d = { id: "d1", title: "Orders", visibility: "personal" as const, ownerUserId: "u1" }
    rememberDashboard({ ...d, spec: { v: 1, blocks: [] }, version: 1 } as never)
    expect(dashboardsList()).toEqual([d])

    rememberDashboard({ ...d, title: "Orders by day" })
    expect(dashboardsList().map((r) => r.title)).toEqual(["Orders by day"])
  })

  it("keeps personal dashboards before the org's", () => {
    rememberDashboard({ id: "o", title: "A", visibility: "org", ownerUserId: null })
    rememberDashboard({ id: "p", title: "B", visibility: "personal", ownerUserId: "u1" })
    expect(dashboardsList().map((r) => r.id)).toEqual(["p", "o"])
  })
})

const row = (id: string, title: string, visibility: "personal" | "org" = "org") =>
  ({ id, title, visibility, ownerUserId: "someone" }) satisfies DashboardSummary

/** An api whose `/dashboards` answers what `rows` holds at the time of the read. */
function server(initial: DashboardSummary[]) {
  const state = { rows: initial }
  const get = vi.fn(async (path: string) => {
    if (path === "/dashboards") return state.rows
    throw new Error(`unexpected ${path}`)
  })
  return { api: { get } as never, state, get }
}

describe("live updates (kernel:dashboard events)", () => {
  beforeEach(() => resetDashboardsStore())

  it("a dashboard shared with the org elsewhere appears without a reload", async () => {
    const { api, state } = server([])
    await loadDashboards(api)
    expect(dashboardsLoaded()).toBe(true)
    expect(dashboardsList()).toEqual([])

    state.rows = [row("d1", "Team sales")]
    await handleDashboardEvent(api, "updated", {
      dashboardId: "d1",
      visibility: "org",
      previousVisibility: "personal",
    })
    expect(dashboardsList().map((d) => d.title)).toEqual(["Team sales"])
  })

  it("a created one is listed and a renamed one shows its new title", async () => {
    const { api, state } = server([row("d1", "Sales")])
    await loadDashboards(api)
    state.rows = [row("d1", "Sales by day"), row("d2", "Stock")]
    await handleDashboardEvent(api, "created", { dashboardId: "d2", visibility: "org" })
    expect(dashboardsList().map((d) => d.title)).toEqual(["Sales by day", "Stock"])
  })

  it("a deleted one leaves the list at once, and an open tab of it reads it again", async () => {
    const { api, state } = server([row("d1", "Sales"), row("d2", "Stock")])
    await loadDashboards(api)
    const before = dashboardRevision("d1")
    state.rows = [row("d2", "Stock")]
    const done = handleDashboardEvent(api, "deleted", { dashboardId: "d1", visibility: "org" })
    // Gone before the list read answers.
    expect(dashboardsList().map((d) => d.id)).toEqual(["d2"])
    expect(dashboardRevision("d1")).toBe(before + 1)
    await done
    expect(dashboardsList().map((d) => d.id)).toEqual(["d2"])
  })

  it("an update makes an open tab read its spec again", async () => {
    const { api } = server([row("d1", "Sales")])
    await loadDashboards(api)
    const before = dashboardRevision("d1")
    await handleDashboardEvent(api, "updated", { dashboardId: "d1", visibility: "org", version: 3 })
    expect(dashboardRevision("d1")).toBe(before + 1)
  })

  it("an event during a running read reads once more, so the later change is not missed", async () => {
    const { api, state, get } = server([row("d1", "Sales")])
    const first = loadDashboards(api)
    state.rows = [row("d1", "Sales"), row("d2", "Stock")]
    await handleDashboardEvent(api, "created", { dashboardId: "d2", visibility: "org" })
    await first
    expect(get).toHaveBeenCalledTimes(2)
    expect(dashboardsList().map((d) => d.id)).toEqual(["d1", "d2"])
  })
})
