// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"
import { dashboardsList, rememberDashboard, resetDashboardsStore } from "./dashboards-store"

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
