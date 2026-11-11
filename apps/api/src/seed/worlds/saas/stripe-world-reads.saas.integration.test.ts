// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The software world seeded once, as a visitor org at the board date, then
// read back through the product's own reads: the pipeline rollup, the
// companies and their duplicate, the team and who is away, the desks, the
// routines and the channels.
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/saas/stripe-world-reads.saas.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { dealsRollup } from "~/apps/projects/service/deals"
import { withPrivilegedDb } from "~/db/privileged"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { seedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { type SeedDemoWorldResult, seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"

/** The software world's catalog apps, installed the way a demo box has them. */
const CATALOG_WORLD_APPS = ["invoicing", "stripe"]

const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")
const ORG_SLUG = "saas-world-reads"
const OWNER = {
  email: "owner@saas-world-reads.example",
  name: "Visitor Owner",
  password: "SaasWorld1!Owner",
}

type Row = Record<string, unknown>
async function rows(orgId: string, query: ReturnType<typeof sql>): Promise<Row[]> {
  return withPrivilegedDb(orgId, "saas-world-test", async (tx) => {
    const r = await tx.execute(query)
    return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[]
  })
}

let world: SeedDemoWorldResult
let appsRoot: string | null = null

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  // Installed packages go to a temporary root unless the run names one.
  if (!process.env.LIAISON_APPS_DIR) {
    appsRoot = mkdtempSync(path.join(tmpdir(), "saas-world-reads-"))
    process.env.LIAISON_APPS_DIR = path.join(appsRoot, "apps")
  }
  for (const app of CATALOG_WORLD_APPS) await installFromDist(app, crypto.randomUUID())
  world = await seedDemoWorld({
    orgSlug: ORG_SLUG,
    worldId: "saas",
    variant: "visitor",
    owner: OWNER,
    baseTime: BOARD_DATE,
  })
}, 2_400_000)

afterAll(() => {
  DemoModeTestAccess.set(null)
  if (appsRoot) rmSync(appsRoot, { recursive: true, force: true })
})

describe("the software world, seeded and read back", () => {
  it("seeds every layer with no failure", () => {
    expect(world.failures).toEqual([])
  })

  it("14 active members, none external, and the account manager reads away with the visitor next in line", async () => {
    const members = await rows(
      world.orgId,
      sql`SELECT u.id, u.status, m.is_external FROM kernel.users u
          LEFT JOIN kernel.org_members m ON m.user_id = u.id AND m.org_id = u.org_id
          WHERE u.org_id = ${world.orgId}`,
    ).catch(async () =>
      rows(world.orgId, sql`SELECT id, status FROM kernel.users WHERE org_id = ${world.orgId}`),
    )
    const active = members.filter((m) => m.status === "active")
    expect(active).toHaveLength(14)
    expect(active.filter((m) => m.is_external === true)).toHaveLength(0)
    const elodie = world.org.peopleByKey.elodie?.userId
    const arlon = await rows(
      world.orgId,
      sql`SELECT owner_user_id FROM kernel.companies
          WHERE org_id = ${world.orgId} AND name = 'Maison Arlon'`,
    )
    expect(arlon[0]?.owner_user_id).toBe(elodie)
    const away = await rows(
      world.orgId,
      sql`SELECT next_in_line_id FROM kernel.away_ranges
          WHERE org_id = ${world.orgId} AND user_id = ${elodie}::uuid`,
    )
    expect(away.length).toBeGreaterThan(0)
    for (const range of away) expect(range.next_in_line_id).toBe(world.org.ownerUserId)
  })

  it("214 companies and the duplicate pair found by domain", async () => {
    const [count] = await rows(
      world.orgId,
      sql`SELECT count(*)::int AS n FROM kernel.companies WHERE org_id = ${world.orgId}`,
    )
    expect(count?.n).toBe(214)
    const kora = await rows(
      world.orgId,
      sql`SELECT domain FROM kernel.companies
          WHERE org_id = ${world.orgId} AND lower(name) LIKE 'kora%'`,
    )
    expect(kora).toHaveLength(2)
    expect(new Set(kora.map((k) => k.domain)).size).toBe(1)
  })

  it("the deals rollup reads Lead 12,300, Qualified 9,800, Demo 23,280, Proposal 23,280, open 9 at 68,660, one won and one lost this month", async () => {
    const ctx = seedContext({ orgId: world.orgId, now: BOARD_DATE })
    const owner = await actorFor(ctx, world.org.ownerUserId as string)
    const byStage = await asUser(owner, (tx) =>
      dealsRollup(tx as never, world.orgId, { groupBy: "stage" }),
    )
    const sumOf = (label: string) => {
      const g = byStage.groups.find((x) => x.label === label)
      return { count: g?.count ?? 0, eur: (g?.sumByCurrency[0]?.sum_minor ?? 0) / 100 }
    }
    expect(sumOf("Lead")).toEqual({ count: 3, eur: 12_300 })
    expect(sumOf("Qualified")).toEqual({ count: 2, eur: 9_800 })
    expect(sumOf("Demo")).toEqual({ count: 2, eur: 23_280 })
    expect(sumOf("Proposal")).toEqual({ count: 2, eur: 23_280 })
    const monthStart = new Date("2026-10-31T23:00:00.000Z").toISOString()
    const closed = await asUser(owner, (tx) =>
      dealsRollup(tx as never, world.orgId, { groupBy: "stage", closedAfter: monthStart }),
    )
    const closedOf = (label: string) => closed.groups.find((g) => g.label === label)?.count ?? 0
    expect(closedOf("Won")).toBe(1)
    expect(closedOf("Lost")).toBe(1)
    const keys = await rows(
      world.orgId,
      sql`SELECT p.key, t.number, t.title FROM app_projects.tasks t
          JOIN app_projects.projects p ON p.id = t.project_id
          WHERE t.org_id = ${world.orgId} AND p.key = 'SALES' AND t.number IN (14, 30, 31)
          ORDER BY t.number`,
    )
    expect(keys.map((k) => `${k.key}-${k.number}`)).toEqual(["SALES-14", "SALES-30", "SALES-31"])
    expect(keys[0]?.title).toBe("Maison Arlon, 4 more hotels")
  })

  it("the agents, routines and channels exist and the seeded routines do not tick from seeded events", async () => {
    for (const handle of ["@support", "@sales", "@finance"]) {
      expect(world.org.agentsByHandle[handle]).toBeDefined()
    }
    expect(world.org.agentsByHandle["@sales"]?.displayName).toBe("Sales Desk")
    const routines = await rows(
      world.orgId,
      sql`SELECT name, enabled FROM kernel.routines WHERE org_id = ${world.orgId} ORDER BY name`,
    )
    const on = routines.filter((r) => r.enabled === true).map((r) => r.name)
    expect(world.org.appsByName.stripe?.enabled).toBe(true)
    expect(on).toEqual(["Deal follow-ups", "Failed payments", "Morning brief"])
    const runs = await rows(
      world.orgId,
      sql`SELECT count(*)::int AS n FROM kernel.routine_runs WHERE org_id = ${world.orgId}`,
    ).catch(() => [{ n: 0 }])
    expect(runs[0]?.n).toBe(0)
    const channels = await rows(
      world.orgId,
      sql`SELECT title FROM kernel.threads
          WHERE org_id = ${world.orgId} AND title IN ('Pipeline', 'Product feedback', 'Support handover', 'Rota bugs')`,
    )
    expect(channels.map((c) => c.title).sort()).toEqual([
      "Pipeline",
      "Product feedback",
      "Rota bugs",
      "Support handover",
    ])
  })
})
