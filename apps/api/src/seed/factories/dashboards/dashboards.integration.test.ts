// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dashboards factory on the real database: the lively org's dashboard is
// written as its first version, shared with the org, listed for its owner, and
// a re-run adopts the row instead of adding one. A bad spec writes nothing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { listDashboards } from "~/modules/dashboards/service"
import { seedContext } from "~/seed/context"
import { rowsOf } from "~/seed/factories/people/actors"
import { LIVELY_DASHBOARD_SPEC, LIVELY_DASHBOARD_TITLE } from "~/seed/tiers/lively/dashboard-specs"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedDashboards } from "./dashboards"

let orgId = ""
let owner: UserContext

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  const session = await minimal.adminSession(orgId)
  owner = {
    actorType: "user",
    userId: session.userId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}, 120_000)

afterAll(async () => {
  await releaseTestLock()
})

const lively = () => ({
  key: "lively:sales-and-support",
  title: LIVELY_DASHBOARD_TITLE,
  ownerUserId: owner.userId,
  visibility: "org" as const,
  spec: LIVELY_DASHBOARD_SPEC,
})

describe("the dashboards factory", () => {
  it("writes the lively dashboard, shared with the org, with its first version", async () => {
    const ctx = seedContext({ orgId, now: new Date("2026-11-20T09:00:00Z") })
    const [id] = await seedDashboards(ctx, [lively()])
    expect(id).toBe(ctx.id("dashboard", "lively:sales-and-support"))
    const [row] = rowsOf<{ title: string; org_access: string; version: number; blocks: number }>(
      await db.execute(
        sql`SELECT title, org_access, version, jsonb_array_length(spec->'blocks') AS blocks
              FROM kernel.dashboards WHERE id = ${id}::uuid`,
      ),
    )
    expect(row).toEqual({ title: "Sales and support", org_access: "viewer", version: 1, blocks: 6 })
    const versions = rowsOf<{ n: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM kernel.dashboard_versions WHERE dashboard_id = ${id}::uuid`,
      ),
    )
    expect(versions[0]?.n).toBe(1)
    const listed = await listDashboards(owner)
    expect(listed.map((d) => d.title)).toContain("Sales and support")
  })

  it("a re-run adopts the row", async () => {
    const ctx = seedContext({ orgId, now: new Date() })
    await seedDashboards(ctx, [lively()])
    const [row] = rowsOf<{ n: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM kernel.dashboards WHERE org_id = ${orgId}::uuid`,
      ),
    )
    expect(row?.n).toBe(1)
  })

  it("refuses a spec the dashboard schema refuses, and writes nothing", async () => {
    const ctx = seedContext({ orgId, now: new Date() })
    await expect(
      seedDashboards(ctx, [{ ...lively(), key: "bad", spec: { v: 1, blocks: [{ id: "x" }] } }]),
    ).rejects.toThrow(/invalid spec/)
    const [row] = rowsOf<{ n: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM kernel.dashboards WHERE org_id = ${orgId}::uuid`,
      ),
    )
    expect(row?.n).toBe(1)
  })
})
