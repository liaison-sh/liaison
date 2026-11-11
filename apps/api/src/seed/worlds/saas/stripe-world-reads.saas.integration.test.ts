// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The software world seeded once, as a visitor org at the board date, then
// read back through the product's own reads: the pipeline rollup, the
// companies and their duplicate, the team and who is away, the desks, the
// routines and the channels.
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/saas/stripe-world-reads.saas.integration.test.ts
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { dealsRollup } from "~/apps/projects/service/deals"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { executeTool } from "~/modules/apps/execute-tool"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { seedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { type SeedDemoWorldResult, seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"

/** The software world's catalog apps, installed the way a demo box has them. */
const CATALOG_WORLD_APPS = ["invoicing", "stripe"]

const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")
// A new org every run: the namespace database outlives a run, and a re-seed adopts what it finds.
const ORG_SLUG = `saas-world-reads-${Date.now().toString(36)}`
const OWNER = {
  email: `owner@${ORG_SLUG}.example`,
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

/** The owner, as the product's reads see them. */
async function ownerActor(): Promise<UserContext> {
  return actorFor(
    seedContext({ orgId: world.orgId, now: BOARD_DATE }),
    world.org.ownerUserId as string,
  )
}

/** A kernel tool called by the owner at the board date: the reads that use today read the board's. */
async function ownerCall<T>(tool: string, params: Record<string, unknown>): Promise<T> {
  const actor = await ownerActor()
  setSystemTime(BOARD_DATE)
  try {
    const r = await executeTool<T>({
      toolName: `kernel:${tool}`,
      orgId: world.orgId,
      actor,
      params,
      origin: "human-ui",
    })
    return r.data as T
  } finally {
    setSystemTime()
  }
}

async function companyId(name: string): Promise<string> {
  const [row] = await rows(
    world.orgId,
    sql`SELECT id FROM kernel.companies WHERE org_id = ${world.orgId} AND name = ${name}`,
  )
  if (!row) throw new Error(`no company ${name}`)
  return row.id as string
}
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
    // The product's own read says the same: Élodie, away, the visitor next in line.
    const read = await ownerCall<{
      accountManager: {
        id: string
        name: string
        away: { until: string; nextInLine: { id: string } | null } | null
      } | null
    }>("companies_read", { companyId: await companyId("Maison Arlon") })
    expect(read.accountManager?.name).toBe("Élodie Renard")
    expect(read.accountManager?.away?.nextInLine?.id).toBe(world.org.ownerUserId as string)
  })

  it("the timeline of the hotel group with the past due card returns its tickets, deal and last meeting from their apps and stores nothing", async () => {
    const audit = sql`SELECT count(*)::int AS n FROM kernel.audit_log WHERE org_id = ${world.orgId}`
    const [before] = await rows(world.orgId, audit)
    const timeline = await ownerCall<{
      items: Array<{ source: string; title: string }>
      unavailable: unknown[]
    }>("company_timeline", { companyId: await companyId("Maison Arlon"), limit: 100 })
    expect(timeline.unavailable).toEqual([])
    const titles = (source: string) =>
      timeline.items.filter((i) => i.source === source).map((i) => i.title)
    expect(titles("calendar")).toEqual(["Maison Arlon, rollout review"])
    const tickets = titles("tickets").join("\n")
    expect(tickets).toContain("Export of last month's rotas")
    expect(tickets).toContain("Shift swap notifications arrive late")
    expect(titles("projects").some((t) => t.includes("Maison Arlon, 4 more hotels"))).toBe(true)
    const [after] = await rows(world.orgId, audit)
    expect(after?.n).toBe(before?.n)
  })

  it("the visitor's support and knowledge queues hold the seeded six tickets and one article to review", async () => {
    const actor = await ownerActor()
    setSystemTime(BOARD_DATE)
    try {
      const feed = await aggregateAttentionItems({ orgId: world.orgId, actor })
      expect(feed.errors ?? []).toEqual([])
      const count = (app: string) => feed.items.filter((i) => i.app === app).length
      expect(count("tickets")).toBe(6)
      expect(count("knowledge")).toBe(1)
    } finally {
      setSystemTime()
    }
  })

  it("the four follow-up rows exist as real approvals in their guard states and held or stopped rows are not counted", async () => {
    const drafts = await rows(
      world.orgId,
      sql`SELECT id, handle, status, tool_name, current_payload->'sendGuard'->>'mode' AS mode
          FROM kernel.approval_requests
          WHERE org_id = ${world.orgId} AND handle LIKE 'demo-%-followup' ORDER BY handle`,
    )
    expect(drafts.map((d) => [d.handle, d.tool_name, d.mode, d.status])).toEqual([
      ["demo-kora-followup", "mail:compose", "followup", "pending"],
      ["demo-lumen-followup", "mail:compose", "followup", "pending"],
      ["demo-sauvan-followup", "mail:compose", "followup", "pending"],
      ["demo-tilleul-followup", "mail:compose", "followup", "cancelled"],
    ])
    const idOf = (handle: string) => drafts.find((d) => d.handle === handle)?.id as string
    const actor = await ownerActor()
    setSystemTime(BOARD_DATE)
    try {
      const feed = await aggregateAttentionItems({ orgId: world.orgId, actor })
      const item = (handle: string) => feed.items.find((i) => i.entityId === idOf(handle))
      const state = (handle: string) =>
        (item(handle)?.metadata?.sendGuard as { state?: string } | undefined)?.state ?? "clear"
      // Lumen waits on the owner and counts.
      expect(item("demo-lumen-followup")?.kind).toBe("approval_pending")
      expect(state("demo-lumen-followup")).toBe("clear")
      expect(item("demo-lumen-followup")?.metadata?.uncounted).not.toBe(true)
      // Marc answered after Sauvan's was staged: stopped, shown, not counted.
      expect(state("demo-sauvan-followup")).toBe("replied")
      // Samir's out-of-office holds Kora's until the morning after the day it names.
      expect(state("demo-kora-followup")).toBe("held")
      // Hugo's opt-out withdrew Tilleul's: it is not on Home at all.
      expect(item("demo-tilleul-followup")).toBeUndefined()
    } finally {
      setSystemTime()
    }
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
