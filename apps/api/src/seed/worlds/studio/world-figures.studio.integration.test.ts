// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's figures, read through the projects app's own tools on a
// freshly seeded workspace at the board date, as the people who would ask: the
// lead for budgets, capacity, the dated sheet and the reconcile card, finance
// for margin. Nothing here computes a figure: each one is what a tool answers
// on what the seed wrote through the product's writers.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEMO_WORLD_NEEDS } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { computeAttentionItems } from "~/apps/projects/attention"
import { budgetGet, marginGet, reconcilePropose } from "~/apps/projects/handlers"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { MONTH_CLOSE_KIND } from "~/apps/projects/service/home-lines"
import { awaitTimeRowWrites } from "~/apps/projects/service/time-rows"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { isFeatureOffForTool } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { seedContext } from "~/seed/context"
import { actorFor, rowsOf } from "~/seed/factories/people/actors"
import { seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import {
  activeAppNames,
  installFromDist,
  uninstallAppsSince,
} from "../../../../test-support/seed/install-dist-apps"
import { STUDIO_PAST_SIGN_ON_HOURS } from "./knowledge"
import { STUDIO_COST_RATES, STUDIO_DATED_LINES, studioPlan } from "./plan"

const DB_URL = process.env.DATABASE_URL ?? ""
/** The board date: Monday 9 November 2026, 09:30 in Paris. */
const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")

let orgId = ""
let people: Record<string, { userId: string } | undefined> = {}
const actors = new Map<string, UserContext>()

async function actor(key: string): Promise<UserContext> {
  const known = actors.get(key)
  if (known) return known
  const userId = people[key]?.userId
  if (!userId) throw new Error(`no person ${key}`)
  const a = await actorFor(seedContext({ orgId, now: BOARD_DATE, log: () => {} }), userId)
  actors.set(key, a)
  return a
}

/** One projects tool through the app bridge, as `who`, from a person's own chat. */
async function call<T = Record<string, any>>(who: string, method: string, input: unknown) {
  const a = await actor(who)
  const out = await withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui", now: BOARD_DATE } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
  await awaitTimeRowWrites()
  return out
}

/** The apps active before the world seed: the ones it adds are removed after the file. */
let appsBeforeSeed = new Set<string>()

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "studio-figures-")),
      "apps",
    )
  }
  await installFromDist("invoicing", crypto.randomUUID())
  // What the world seed installs from the catalog (its needs name the agreements app).
  appsBeforeSeed = await activeAppNames()
  const slug = `studio-fig-${crypto.randomUUID().slice(0, 8)}`
  const result = await seedDemoWorld({
    orgSlug: slug,
    variant: "visitor",
    locale: "en",
    owner: { email: `owner@${slug}.example`, name: "Studio Owner", password: "StudioOwner1!Seed" },
    worldId: "studio",
    needs: [...DEMO_WORLD_NEEDS.studio],
    baseTime: BOARD_DATE,
  })
  expect(result.failures).toEqual([])
  orgId = result.orgId
  people = Object.fromEntries(
    await withPrivilegedDb(orgId, "studio-figures:people", async (tx) =>
      rowsOf<{ email: string; id: string }>(
        await tx.execute(
          sql`SELECT email, id::text AS id FROM kernel.users WHERE org_id = ${orgId}::uuid`,
        ),
      ).map((r) => [r.email.split("@")[0] ?? "", { userId: r.id }]),
    ),
  )
}, 900_000)

afterAll(async () => {
  await uninstallAppsSince(appsBeforeSeed)
  DemoModeTestAccess.set(null)
})

describe("the services world's figures at the board date", () => {
  it("five projects use time, the internal one does not, the pipeline cannot, and the org is in use", async () => {
    const all = await withPrivilegedDb(orgId, "studio-figures:switch", async (tx) =>
      rowsOf<{ key: string; id: string; kind: string; on: boolean; archived: boolean }>(
        await tx.execute(
          sql`SELECT key, id::text AS id, kind, time_budgets_on AS on,
                     archived_at IS NOT NULL AS archived
                FROM app_projects.projects
              WHERE org_id = ${orgId}::uuid ORDER BY key`,
        ),
      ),
    )
    // The closed past projects used time while they ran; the rest are the active ones.
    expect(all.filter((r) => r.archived).map((r) => [r.key, r.on])).toEqual([
      ["BRUME", true],
      ["OSIER", true],
    ])
    const rows = all.filter((r) => !r.archived)
    expect(rows.filter((r) => r.on).map((r) => r.key)).toEqual([
      "ALPINE",
      "MARLIN",
      "RHONE",
      "SOREL",
      "VERD",
    ])
    expect(rows.find((r) => r.key === "STUDIO")?.on).toBe(false)
    expect(rows.find((r) => r.key === "SALES")?.kind).toBe("pipeline")
    const feature = await withPrivilegedDb(orgId, "studio-figures:feature", async (tx) =>
      rowsOf<{ enabled: boolean }>(
        await tx.execute(
          sql`SELECT enabled FROM kernel.org_app_features
              WHERE org_id = ${orgId}::uuid AND app_name = 'projects' AND feature = 'time_budgets'`,
        ),
      ),
    )
    expect(feature).toEqual([{ enabled: true }])
    expect(isFeatureOffForTool(orgId, { appName: "projects", feature: "time_budgets" })).toBe(false)
    const salesId = (rows as Array<{ key: string; id?: string }>).find((r) => r.key === "SALES")?.id
    const refused = await call("bastien", "projects_updateProject", {
      projectId: salesId,
      timeBudgets: true,
    })
    expect(JSON.stringify(refused)).toContain("planning_off")
  })

  it("the two past projects are closed, their sign-on taking 52 h and 68 h, 60 h on average, costed at the person's rate", async () => {
    const plan = studioPlan(BOARD_DATE)
    const closed = await withPrivilegedDb(orgId, "studio-figures:closed", async (tx) =>
      rowsOf<{ key: string; id: string; archived_at: string | Date | null; open: number }>(
        await tx.execute(
          sql`SELECT p.key, p.id::text AS id, p.archived_at,
                     (SELECT count(*)::int FROM app_projects.tasks t
                       WHERE t.project_id = p.id AND t.completed_at IS NULL) AS open
                FROM app_projects.projects p
               WHERE p.org_id = ${orgId}::uuid AND p.key IN ('BRUME', 'OSIER') ORDER BY p.key`,
        ),
      ),
    )
    expect(closed.map((r) => r.key)).toEqual(["BRUME", "OSIER"])
    const figures: Array<[string, number, number]> = []
    for (const row of closed) {
      const spec = plan.projects.find((p) => p.key === row.key)
      // Closed on the plan's day, before the board date, with nothing left open.
      expect(new Date(row.archived_at as string).getTime()).toBe(spec?.closedAt?.getTime() ?? 0)
      expect(row.open).toBe(0)
      const signOn = spec?.tasks.find((t) => /single sign-on/i.test(t.title))
      const who = signOn?.assignee as keyof typeof STUDIO_COST_RATES
      // Margin, read as finance by the project's id: an archived project has no name to look
      // up by. Every hour is the sign-on's, at its person's rate; no invoice is linked to it.
      const out = await handler("anais", marginGet, { projectId: row.id })
      const hours = STUDIO_PAST_SIGN_ON_HOURS[row.key.toLowerCase() as "brume" | "osier"]
      const cost = (hours * STUDIO_COST_RATES[who]) / 100
      expect([out.takenMinutes / 60, out.cost, out.invoiced, out.margin]).toEqual([
        hours,
        cost,
        0,
        -cost,
      ])
      expect(out.how).toContain("No issued invoice is linked to the project yet.")
      figures.push([row.key, out.takenMinutes / 60, out.margin])
    }
    // Hugo at 50 an hour on the first, Yanis at 50 on the second.
    expect(figures).toEqual([
      ["BRUME", 52, -2600],
      ["OSIER", 68, -3400],
    ])
    expect((figures[0]![1] + figures[1]![1]) / 2).toBe(60)
  })

  it("the fixed-price project reads 420, 346, 74 left, its coverage and its milestone figures", async () => {
    const out = await call("bastien", "projects_budgetGet", {
      projectName: "Partner portal rebuild",
    })
    expect(out.totals).toEqual([
      { k: "Planned", text: "420 h" },
      { k: "Real", text: "346 h" },
      { k: "Left", text: "74 h" },
      { k: "Price", text: "€64,000.00" },
    ])
    expect(out.partial).toBe(true)
    expect(out.coverage.withEntries).toBe(41)
    // 50 rows: 4 milestones with children and 46 leaves, 43 of them started or closed.
    expect(out.coverage.total).toBe(43)
    // The project used time and budgets from its start: no note says otherwise.
    expect(out.offUntil).toBeUndefined()
    const milestones = Object.fromEntries(
      out.milestones.map((m: any) => [m.name, [m.plannedMinutes / 60, m.realMinutes / 60]]),
    )
    expect(milestones).toEqual({
      Discovery: [52, 48],
      Design: [78, 81],
      Beta: [200, 189],
      Launch: [90, 28],
    })
    // In plan order, whichever column each milestone sits in.
    expect(out.milestones.map((m: any) => m.name)).toEqual([
      "Discovery",
      "Design",
      "Beta",
      "Launch",
    ])
  })

  it("a task closed before the seed day was last changed when it closed, not on the seed day", async () => {
    const rows = await withPrivilegedDb(orgId, "studio-figures:closed-at", async (tx) =>
      rowsOf<{ closed: number; at_close: number; created_after: number }>(
        await tx.execute(
          sql`SELECT count(*)::int AS closed,
                     count(*) FILTER (WHERE updated_at = completed_at)::int AS at_close,
                     count(*) FILTER (WHERE created_at > completed_at)::int AS created_after
                FROM app_projects.tasks
               WHERE org_id = ${orgId}::uuid AND completed_at IS NOT NULL`,
        ),
      ),
    )
    expect(rows[0]?.closed).toBeGreaterThan(0)
    expect(rows[0]?.at_close).toBe(rows[0]?.closed)
    expect(rows[0]?.created_after).toBe(0)
  })

  it("the retainer's budget counts this month's tasks as its dated sheet does", async () => {
    const budget = await call("bastien", "projects_budgetGet", {
      projectName: "Publishing retainer",
    })
    const sheet = await call("bastien", "projects_timesheetGet", {
      projectName: "Publishing retainer",
      month: BOARD_DATE.toISOString().slice(0, 7),
    })
    expect(sheet.coverage.total).toBeGreaterThan(0)
    expect(budget.coverage).toEqual(sheet.coverage)
  })

  it("next week's capacity reads 350 and 336 with the people and hours of the plan, in name order", async () => {
    const plan = studioPlan(BOARD_DATE)
    const out = await call("bastien", "projects_capacityGet", { week: isoWeek(plan.nextWeek.from) })
    expect(out.availableMinutes / 60).toBe(350)
    expect(out.plannedMinutes / 60).toBe(336)
    expect(out.people.map((p: any) => [p.name.split(" ")[0], p.plannedMinutes / 60])).toEqual([
      ["Bastien", 28],
      ["Clara", 35],
      ["Emma", 36],
      ["Hugo", 36],
      ["Lina", 35],
      ["Mathis", 15],
      ["Nadia", 44],
      ["Paul", 37],
      ["Sofia", 34],
      ["Yanis", 36],
    ])
    for (const person of out.people) {
      const sum = person.tasks.reduce((n: number, t: any) => n + t.minutes, 0)
      expect(sum).toBe(person.plannedMinutes)
    }
  })

  it("the dated sheet of last month reads fourteen lines and 46 hours on six tasks", async () => {
    const out = await call("bastien", "projects_timesheetGet", {
      projectName: "Publishing retainer",
      month: lastMonth(BOARD_DATE),
    })
    expect(out.lines).toHaveLength(STUDIO_DATED_LINES.length)
    expect(out.lines.reduce((n: number, l: any) => n + l.minutes, 0)).toBe(46 * 60)
    expect([...new Set(out.lines.map((l: any) => l.taskKey))].sort()).toEqual([
      "SOREL-16",
      "SOREL-17",
      "SOREL-18",
      "SOREL-19",
      "SOREL-20",
      "SOREL-21",
    ])
    // The board's ordinal weekdays: the k-th weekday of the month, per line.
    const plan = studioPlan(BOARD_DATE)
    const planned = plan.taskTime
      .filter((r) => r.project === "SOREL" && r.workDate.startsWith(lastMonth(BOARD_DATE)))
      .map((r) => [r.workDate, r.task, r.minutes])
      .sort()
    expect(out.lines.map((l: any) => [l.date, l.taskKey, l.minutes]).sort()).toEqual(planned)
  })

  it("reconcile on last month gives the card of the board", async () => {
    const month = lastMonth(BOARD_DATE)
    const facts = await call("bastien", "projects_reconcileFacts", { project: "ALPINE", month })
    expect(facts.coverage).toEqual({ withEntries: 9, total: 11 })
    expect(facts.terms).toEqual({ rate: 930, currency: "EUR", unit: "day" })
    const id = (key: string) => facts.tasks.find((t: any) => t.key === key)?.id as string
    const card = await call("bastien", "projects_reconcilePropose", {
      project: "ALPINE",
      month,
      lines: [
        {
          name: "Data export",
          taskIds: ["ALPINE-11", "ALPINE-13", "ALPINE-14", "ALPINE-15"].map(id),
          proofs: [],
        },
        {
          name: "Monitoring",
          taskIds: ["ALPINE-6", "ALPINE-7", "ALPINE-16", "ALPINE-17"].map(id),
          proofs: [],
        },
        {
          name: "Staging outage",
          reason: "our_mistake",
          taskIds: [id("ALPINE-8")],
          proofs: [],
        },
        {
          name: "Extra report",
          reason: "client_asked",
          taskIds: [id("ALPINE-18")],
          proofs: [],
        },
        {
          name: "Rights database export",
          reason: "other_client",
          otherProjectKey: "SOREL",
          taskIds: [id("ALPINE-19")],
          proofs: [],
        },
      ],
    })
    expect(card.error).toBeUndefined()
    expect(card.lines.map((l: any) => [l.name, l.planned, l.real, l.bill, l.amount])).toEqual([
      ["Data export", "3 d", "3.5 d", "3 d", 2790],
      ["Monitoring", "4 d", "4 d", "4 d", 3720],
      ["Staging outage", null, "0.5 d", "0 d", 0],
      ["Extra report", null, null, "0 d", 0],
      ["Rights database export", null, null, "0 d", 0],
    ])
    expect(card.totals).toEqual({
      billMinutes: 7 * 7 * 60,
      bill: "7 d",
      amountExclVat: 6510,
      currency: "EUR",
    })
    expect(card.coverageText).toBe("Real time entered on 9 of 11 tasks")
    expect(card.fit).toBe("over")
  })

  it("however the lines group last month's tasks, the card bills the plan, and billing more reads over", async () => {
    const month = lastMonth(BOARD_DATE)
    const facts = await call("bastien", "projects_reconcileFacts", { project: "ALPINE", month })
    const id = (key: string) => facts.tasks.find((t: any) => t.key === key)?.id as string
    const line = (name: string, keys: string[]) => ({ name, taskIds: keys.map(id), proofs: [] })
    const groupings = {
      // The review and scheduling tasks carry no plan, put on a line of their own.
      split: [
        line("Export format review and export scheduling", ["ALPINE-11", "ALPINE-13"]),
        line("Stock export", ["ALPINE-14"]),
        line("Supplier export", ["ALPINE-15"]),
        line("Monitoring", ["ALPINE-6", "ALPINE-7", "ALPINE-16", "ALPINE-17"]),
        line("Staging outage fix", ["ALPINE-8"]),
        line("Extra stock report", ["ALPINE-18"]),
        line("Rights database export", ["ALPINE-19"]),
      ],
      // Metrics, and review and scheduling, as lines with no plan of their own.
      metrics: [
        line("Metrics", ["ALPINE-6", "ALPINE-7"]),
        line("Format review and scheduling", ["ALPINE-11", "ALPINE-13"]),
        line("Exports", ["ALPINE-14", "ALPINE-15"]),
        line("Alerts and dashboards", ["ALPINE-16", "ALPINE-17"]),
        line("Staging outage fix", ["ALPINE-8"]),
        line("Extra stock report", ["ALPINE-18"]),
      ],
      // The board's lines, with the outage fix as one more line.
      board: [
        line("Data export", ["ALPINE-11", "ALPINE-13", "ALPINE-14", "ALPINE-15"]),
        line("Monitoring", ["ALPINE-6", "ALPINE-7", "ALPINE-16", "ALPINE-17"]),
        line("Staging outage fix", ["ALPINE-8"]),
        line("Extra report", ["ALPINE-18"]),
        line("Rights database export", ["ALPINE-19"]),
      ],
    }
    for (const [name, lines] of Object.entries(groupings)) {
      const card = await call("bastien", "projects_reconcilePropose", {
        project: "ALPINE",
        month,
        lines,
      })
      expect(card.error).toBeUndefined()
      // In the plan only where a task carries planned time; the rest bills 0 by default.
      for (const l of card.lines.filter((l: any) => l.kind !== "other")) {
        expect([name, l.name, l.kind]).toEqual([
          name,
          l.name,
          l.plannedMinutes > 0 ? "planned" : "unplanned",
        ])
        if (l.kind === "unplanned") expect([name, l.name, l.billMinutes]).toEqual([name, l.name, 0])
      }
      expect([name, card.totals.bill, card.totals.amountExclVat]).toEqual([name, "7 d", 6510])
      if (name === "board") {
        expect(card.lines.map((l: any) => [l.name, l.planned, l.real, l.bill, l.amount])).toEqual([
          ["Data export", "3 d", "3.5 d", "3 d", 2790],
          ["Monitoring", "4 d", "4 d", "4 d", 3720],
          ["Staging outage fix", null, "0.5 d", "0 d", 0],
          ["Extra report", null, null, "0 d", 0],
          ["Rights database export", null, null, "0 d", 0],
        ])
        continue
      }
      expect([name, card.fit]).toEqual([name, "fits"])
      // The person bills a line not in the plan: the card bills above the plan and says so.
      const extra = card.lines.find((l: any) => l.kind === "unplanned" && l.realMinutes > 0)
      const billed = await call("bastien", "projects_reconcileLineUpdate", {
        reconciliationId: card.reconciliationId,
        revision: card.revision,
        lineId: extra.lineId,
        bill: "1 d",
      })
      expect(billed.error).toBeUndefined()
      expect([name, billed.totals.bill, billed.fit]).toEqual([name, "8 d", "over"])
    }
  })

  it("margin's cost is each hour taken at its person's rate, read as finance", async () => {
    const cost = async (projectName: string, month?: string) => {
      const a = await actor("anais")
      return withRlsContext(a, async (tx) => {
        const bridge = createRpcBridge(
          "projects",
          a.userId,
          orgId,
          tx,
          projectsAppManifest as never,
          a.scopes,
          "user",
          undefined,
          { origin: "human-ui" } as never,
        )
        return (await marginGet(
          { projectName, ...(month ? { month } : {}) },
          bridge as never,
        )) as any
      })
    }
    const month = lastMonth(BOARD_DATE)
    const marlin = await cost("Partner portal rebuild")
    const sorel = await cost("Publishing retainer", month)
    const alpine = await cost("Stock and supplier data", month)
    expect([marlin.cost, marlin.takenMinutes / 60]).toEqual([19694, 346])
    expect([sorel.cost, sorel.takenMinutes / 60]).toEqual([2533, 46])
    expect([alpine.cost, alpine.takenMinutes / 60]).toEqual([2912, 56])
    // A member without the margin scope is refused.
    const refused = await call("bastien", "projects_marginCost", {
      projectName: "Publishing retainer",
    })
    expect(JSON.stringify(refused)).toMatch(/not_allowed|scope|margin/)
  })
})

function lastMonth(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

function isoWeek(civil: string): string {
  const [y, m, d] = civil.split("-").map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/** A projects handler (the tool as the agent calls it), as `who`, through the app bridge. */
async function handler<T = Record<string, any>>(
  who: string,
  fn: (params: unknown, ctx: never) => Promise<unknown>,
  params: unknown,
): Promise<T> {
  const a = await actor(who)
  return withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      projectsAppManifest as never,
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui", now: BOARD_DATE } as never,
    )
    return (await fn(params, bridge as never)) as T
  })
}

describe("the services world's money at the board date", () => {
  it("the fixed-price portal reads invoiced 44,800 of 64,000, 19,200 left to invoice", async () => {
    const out = await handler("anais", budgetGet, { projectName: "Partner portal rebuild" })
    expect([out.money?.price, out.money?.invoiced, out.money?.leftToInvoice]).toEqual([
      64_000, 44_800, 19_200,
    ])
  })

  it("margin reads the portal 25,106 and the retainer last month 2,687, and the day-rate project says nothing is invoiced yet", async () => {
    const month = lastMonth(BOARD_DATE)
    const portal = await handler("anais", marginGet, { projectName: "Partner portal rebuild" })
    const retainer = await handler("anais", marginGet, {
      projectName: "Publishing retainer",
      month,
    })
    const daily = await handler("anais", marginGet, {
      projectName: "Stock and supplier data",
      month,
    })
    expect([portal.invoiced, portal.invoiced - portal.cost]).toEqual([44_800, 25_106])
    expect([retainer.invoiced, retainer.invoiced - retainer.cost]).toEqual([5_220, 2_687])
    expect(daily.invoiced).toBe(0)
    expect(JSON.stringify(daily)).toMatch(/No issued invoice bills [A-Z][a-z]+ \d{4} yet/)
  })

  it("invoice numbers run from 0001 with no gap to the last seeded one, and dates never decrease", async () => {
    const rows = await withPrivilegedDb(orgId, "studio-figures:numbers", async (tx) =>
      rowsOf<{ number: string | null; n: number | null; issued: string | null; status: string }>(
        await tx.execute(
          sql`SELECT number, number_int AS n, issued_at::text AS issued, status
                FROM app_invoicing.documents
               WHERE org_id = ${orgId}::uuid AND type = 'invoice'
               ORDER BY number_int NULLS LAST`,
        ),
      ),
    )
    const issued = rows.filter((r) => r.status !== "draft")
    expect(issued.map((r) => r.n)).toEqual(Array.from({ length: 513 }, (_, i) => i + 1))
    expect(issued[0]?.number).toBe("F-2026-0001")
    // The upkeep schedule's run on the 1st, after last month's retainer invoice (0512).
    expect(issued.at(-1)?.number).toBe("F-2026-0513")
    for (let i = 1; i < issued.length; i++) {
      expect([issued[i]?.n, (issued[i]?.issued ?? "") >= (issued[i - 1]?.issued ?? "")]).toEqual([
        issued[i]?.n,
        true,
      ])
    }
    // No draft waits at the board date: the Beta milestone's task is still in progress.
    expect(rows.filter((r) => r.status === "draft")).toEqual([])
    const seq = await withPrivilegedDb(orgId, "studio-figures:sequence", async (tx) =>
      rowsOf<{ value: number }>(
        await tx.execute(
          sql`SELECT value FROM kernel.app_sequences
               WHERE org_id = ${orgId}::uuid AND app_id = 'invoicing' AND key LIKE '%:invoice:2026'`,
        ),
      ),
    )
    expect(seq.map((r) => Number(r.value))).toEqual([513])
  })

  it("the retainer's schedule is 4,500 for 40 h, 120 an hour above, and last month's invoice is 6,264.00 with its claims billed", async () => {
    const out = await withPrivilegedDb(orgId, "studio-figures:retainer", async (tx) => {
      const schedule = rowsOf<Record<string, any>>(
        await tx.execute(sql`
          SELECT s.id::text AS id, s.lines, s.retainer_minutes, s.retainer_overage_rate_minor::int AS rate,
                 s.retainer_rollover, s.covers
            FROM app_invoicing.recurring_schedules s
            JOIN app_projects.projects p ON p.id = s.retainer_project_id
           WHERE s.org_id = ${orgId}::uuid AND p.key = 'SOREL'`),
      )
      const invoice = rowsOf<Record<string, any>>(
        await tx.execute(sql`
          SELECT number, grand_total_minor::int AS total, subtotal_minor::int AS excl, external_ref
            FROM app_invoicing.documents
           WHERE org_id = ${orgId}::uuid AND number = 'F-2026-0512'`),
      )
      const claims = rowsOf<{ state: string; period_key: string; n: number }>(
        await tx.execute(sql`
          SELECT c.state, c.period_key, count(*)::int AS n
            FROM app_projects.billing_claims c
            JOIN app_projects.reconciliations r ON r.id = c.reconciliation_id
           WHERE c.org_id = ${orgId}::uuid AND r.document_ref = ${invoice[0]?.external_ref ?? ""}
           GROUP BY c.state, c.period_key`),
      )
      return { schedule: schedule[0], invoice: invoice[0], claims }
    })
    expect(out.schedule?.lines?.[0]?.unit_price_minor).toBe(450_000)
    expect([
      out.schedule?.retainer_minutes,
      out.schedule?.rate,
      out.schedule?.retainer_rollover,
      out.schedule?.covers,
    ]).toEqual([2_400, 12_000, "none", "period_ended"])
    expect([out.invoice?.excl, out.invoice?.total]).toEqual([522_000, 626_400])
    expect(out.invoice?.external_ref).toBe(`retainer:${out.schedule?.id}:${lastMonth(BOARD_DATE)}`)
    expect(out.claims.map((c) => [c.state, c.period_key])).toEqual([
      ["billed", lastMonth(BOARD_DATE)],
    ])
  })

  it("Home at the board date asks the biller nothing of money", async () => {
    const a = await actor("anais")
    const items = await withRlsContext(a, async (tx) => [
      ...(await computeApprovalAttentionItems(tx, orgId, a.userId, [], BOARD_DATE)),
      ...(await computeAttentionItems(tx, orgId, a.userId, [], BOARD_DATE)),
    ])
    const money = items
      .filter(
        (i) =>
          (i.kind as string) === MONTH_CLOSE_KIND ||
          (i.kind === "approval_pending" &&
            String(i.metadata?.toolName ?? "").startsWith("invoicing:")),
      )
      .map((i) =>
        (i.kind as string) === MONTH_CLOSE_KIND
          ? `month line ${String(i.metadata?.period ?? "").slice(0, 7)} ${i.summary}`
          : `issue approval ${i.metadata?.toolName}`,
      )
    // The month lines come on each month's line day (home-money.studio covers them), and the
    // Beta milestone is not drafted while its task is in progress: no money item at the board date.
    expect(money).toEqual([])
  })

  it("planned vs done for the day-rate project last month prices 6,510.00, 1,302.00 of VAT and 7,812.00", async () => {
    const month = lastMonth(BOARD_DATE)
    const facts = await call("anais", "projects_reconcileFacts", { project: "ALPINE", month })
    const id = (key: string) => facts.tasks.find((t: any) => t.key === key)?.id as string
    const card = await handler("anais", reconcilePropose, {
      project: "ALPINE",
      month,
      lines: [
        {
          name: "Data export",
          taskIds: ["ALPINE-11", "ALPINE-13", "ALPINE-14", "ALPINE-15"].map(id),
          proofs: [],
        },
        {
          name: "Monitoring",
          taskIds: ["ALPINE-6", "ALPINE-7", "ALPINE-16", "ALPINE-17"].map(id),
          proofs: [],
        },
      ],
    })
    expect(card.error).toBeUndefined()
    expect(card.tot.map((t: any) => [t.k, t.v.minor / 100])).toEqual([
      ["Excl. VAT", 6_510],
      ["VAT", 1_302],
      ["Incl. VAT", 7_812],
    ])
    expect(card.createInvoice).toBe("yes")
  })
})
