// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world seeded once as a visitor org at the board date, then read
// back through the product's own reads: its desks and their teams, its
// support queue, channels and routines, who is on the team, which apps are on,
// and what Home shows the owner and the people around them.
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/studio/world-desk.studio.integration.test.ts
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AttentionItem } from "@liaison/shared"
import { DEMO_WORLD_NEEDS, STUDIO_PROSPECT_ROUTINE_NAME } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { readApprovalRequesters } from "~/modules/approvals/requester"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { seedContext } from "~/seed/context"
import { personalAgentOf } from "~/seed/factories/agent/presence"
import { actorFor, rowsOf } from "~/seed/factories/people/actors"
import { DEMO_APPS, DEMO_WORLD_APPS } from "~/seed/tiers/demo/demo-apps"
import {
  refreshSeededAttention,
  type SeedDemoWorldResult,
  seedDemoWorld,
  seedScenarioStart,
} from "~/seed/tiers/demo/seed-demo"
import { drainOutbox } from "~/tests/helpers/outbox"
import {
  activeAppNames,
  installFromDist,
  uninstallAppsSince,
} from "../../../../test-support/seed/install-dist-apps"
import { studioMorningBrief } from "./brief"
import { STUDIO_CLIENTS, STUDIO_DELIVERY_KEYS, STUDIO_PAST_CLIENTS, STUDIO_TEAM } from "./fiction"
import { STUDIO_CHANNEL_TITLES } from "./threads-specs"

/** The board date: Monday 9 November 2026, 09:30 in Paris. */
const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")

let world: SeedDemoWorldResult
let appsBeforeSeed = new Set<string>()

type Row = Record<string, unknown>
async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
  return withPrivilegedDb(world.orgId, "studio-desk-test", async (tx) =>
    rowsOf<Row>(await tx.execute(query)),
  )
}

function userIdOf(key: string): string {
  if (key === "owner") return world.org.ownerUserId as string
  const id = world.org.peopleByKey[key]?.userId
  if (!id) throw new Error(`no person ${key}`)
  return id
}

/**
 * One person's Home feed at a moment (the board date unless named). Home serves the apps' lists as
 * last stored, and the seed stored them when it ran (today's clock), so the person's lists are
 * first recomputed at that moment, as the minute tick stores them then.
 */
async function homeOf(key: string, at: Date = BOARD_DATE): Promise<AttentionItem[]> {
  const userId = userIdOf(key)
  const actor = await actorFor(seedContext({ orgId: world.orgId, now: at }), userId)
  // A list stored later wins over one computed at an earlier time: the seed's lists go first.
  await rows(sql`
    DELETE FROM kernel.app_attention_items
     WHERE org_id = ${world.orgId}::uuid AND user_id = ${userId}::uuid`)
  setSystemTime(at)
  try {
    await refreshSeededAttention(world.orgId, [userId])
    const feed = await aggregateAttentionItems({ orgId: world.orgId, actor })
    expect(feed.errors ?? []).toEqual([])
    return feed.items
  } finally {
    setSystemTime()
  }
}

/** The decisions Home counts under Needs you: approvals not marked uncounted. */
const counted = (items: AttentionItem[]) =>
  items.filter((i) => i.kind === "approval_pending" && i.metadata?.uncounted !== true)

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "studio-desk-")),
      "apps",
    )
  }
  await installFromDist("invoicing", crypto.randomUUID())
  // The world's catalog apps beside invoicing, as a demo box has them; removed after the file.
  appsBeforeSeed = await activeAppNames()
  for (const app of ["agreements", "github"]) await installFromDist(app, crypto.randomUUID())
  const slug = `studio-desk-${crypto.randomUUID().slice(0, 8)}`
  world = await seedDemoWorld({
    orgSlug: slug,
    variant: "visitor",
    locale: "en",
    owner: { email: `owner@${slug}.example`, name: "Studio Owner", password: "StudioOwner1!Seed" },
    worldId: "studio",
    needs: [...DEMO_WORLD_NEEDS.studio],
    baseTime: BOARD_DATE,
  })
}, 900_000)

afterAll(async () => {
  await uninstallAppsSince(appsBeforeSeed)
  DemoModeTestAccess.set(null)
})

describe("the services world's desks, queues and Home at the board date", () => {
  it("seeds every layer with no failure", () => {
    expect(world.failures).toEqual([])
  })

  it("the delivery, finance, sales and support desks exist with their teams", async () => {
    const desks = await rows(sql`
      SELECT handle, display_name AS name, scope_ceiling AS ceiling FROM kernel.agents
       WHERE org_id = ${world.orgId}::uuid AND handle = ANY(${"{@delivery,@finance,@sales,@support}"}::text[])
       ORDER BY handle`)
    expect(desks.map((d) => [d.handle, d.name])).toEqual([
      ["@delivery", "Delivery Desk"],
      ["@finance", "Finance Desk"],
      ["@sales", "Sales Desk"],
      ["@support", "Support Desk"],
    ])
    // Each desk reaches the apps of its team's work, and the delivery desk calls no invoicing tool.
    const ceiling = (h: string) => (desks.find((d) => d.handle === h)?.ceiling ?? []) as string[]
    expect(ceiling("@delivery").some((x) => x.startsWith("projects:"))).toBe(true)
    const [delivery] = await rows(sql`
      SELECT tool_allowlist AS tools FROM kernel.agents
       WHERE org_id = ${world.orgId}::uuid AND handle = '@delivery'`)
    expect(((delivery?.tools ?? []) as string[]).filter((t) => t.startsWith("invoicing:"))).toEqual(
      [],
    )
    expect(ceiling("@finance").some((x) => x.startsWith("invoicing:"))).toBe(true)
    expect(ceiling("@support").some((x) => x.startsWith("tickets:"))).toBe(true)
    const channels = await rows(sql`
      SELECT title FROM kernel.threads
       WHERE org_id = ${world.orgId}::uuid AND title = ANY(${`{${Object.values(STUDIO_CHANNEL_TITLES).join(",")}}`}::text[])`)
    expect(channels.map((c) => c.title).sort()).toEqual(Object.values(STUDIO_CHANNEL_TITLES).sort())
  })

  it("twenty-four active members, ten holding timeboxes, none external", async () => {
    const members = await rows(sql`
      SELECT email, user_type FROM kernel.users
       WHERE org_id = ${world.orgId}::uuid AND status = 'active' AND user_type = 'member'`)
    expect(members).toHaveLength(STUDIO_TEAM.length + 1)
    expect(members).toHaveLength(24)
    // The client's two portal people are the org's only external users, never members.
    const external = await rows(sql`
      SELECT email FROM kernel.users
       WHERE org_id = ${world.orgId}::uuid AND user_type = 'external'`)
    expect(external.map((e) => String(e.email).split("@")[0]).sort()).toEqual([
      "pauline",
      "remi.castel",
    ])
    const holders = await rows(sql`
      SELECT DISTINCT u.email FROM app_projects.tasks t
        JOIN kernel.users u ON u.id = t.assignee_id
       WHERE t.org_id = ${world.orgId}::uuid AND t.timebox_minutes IS NOT NULL`)
    expect(holders.map((h) => String(h.email).split("@")[0]).sort()).toEqual([
      ...STUDIO_DELIVERY_KEYS,
    ])
  })

  it("the studio world has its nine apps on and the payments, shop, carrier, books, monitoring, social and connector apps off", async () => {
    const on = Object.values(world.org.appsByName)
      .filter((a) => a.enabled)
      .map((a) => a.name)
    expect(on.sort()).toEqual([...DEMO_WORLD_APPS.studio].sort())
    const studio = new Set<string>(DEMO_WORLD_APPS.studio)
    const offNames = DEMO_APPS.filter((n) => !studio.has(n))
    expect(offNames.length).toBeGreaterThan(0)
    const off = await rows(sql`
      SELECT name, status FROM kernel.apps
       WHERE org_id = ${world.orgId}::uuid AND name = ANY(${`{${offNames.join(",")}}`}::text[])`)
    expect(off.filter((a) => a.status === "active")).toEqual([])
  })

  it("the queues read three support items and one knowledge item, and no task or deal of the owner's", async () => {
    const items = await homeOf("owner")
    const of = (app: string) => items.filter((i) => i.app === app)
    // Three tickets waiting on a reply, each answered once already: queue volume, no SLA alert.
    expect(of("tickets").map((i) => i.kind)).toEqual([
      "awaiting_agent",
      "awaiting_agent",
      "awaiting_agent",
    ])
    expect(of("knowledge").map((i) => String(i.kind))).toEqual(["knowledge_review"])
    // The plan assigns every task and deal to the team, none to the owner's seat.
    expect(of("projects")).toEqual([])
  })

  it("Home at the board date shows the owner the rows the product's rules give, the change request card first", async () => {
    const owner = await homeOf("owner")
    expect(counted(owner).map((i) => i.metadata?.toolName)).toEqual([
      "agreements:change_request_send",
    ])
    // No other row asks the owner for a decision: tickets are queue volume, nothing is urgent.
    expect(owner.filter((i) => i.kind === "sla_risk")).toEqual([])
    // The lead's open work is due next Wednesday, nine days on: past the due-soon window, so
    // Home has no task row for it at the board date. A week on, the same three tasks are due
    // this week. Finance has nothing of money at the board date.
    const bastien = await homeOf("bastien")
    expect(counted(bastien)).toEqual([])
    const tasks = (items: AttentionItem[]) =>
      items.filter((i) => i.app === "projects" && i.kind.startsWith("task_")).map((i) => i.kind)
    expect(tasks(bastien)).toEqual([])
    const nextMonday = new Date(BOARD_DATE.getTime() + 7 * 86_400_000)
    expect(tasks(await homeOf("bastien", nextMonday))).toEqual([
      "task_due_this_week",
      "task_due_this_week",
      "task_due_this_week",
    ])
    expect(counted(await homeOf("anais"))).toEqual([])
    // The change request card reaches only the person who decides it.
    const cards = await rows(sql`
      SELECT tool_name, notify_user_ids::text[] AS notify FROM kernel.approval_requests
       WHERE org_id = ${world.orgId}::uuid AND status = 'pending'`)
    expect(cards.map((c) => [c.tool_name, c.notify])).toEqual([
      ["agreements:change_request_send", [userIdOf("owner")]],
    ])
  })

  it("the seeded routines do not tick from seeded events", async () => {
    const routines = await rows(sql`
      SELECT name, enabled, kind FROM kernel.routines
       WHERE org_id = ${world.orgId}::uuid ORDER BY name`)
    expect(routines.map((r) => [r.name, r.enabled, r.kind])).toEqual([
      ["Morning brief", true, "recurring"],
      ["agreements-scope-check", true, "event"],
      ["projects-client-reports", true, "recurring"],
    ])
    // Every event the seed queued, the client's mail among them, is delivered: none runs one.
    await drainOutbox()
    const runs = await rows(sql`
      SELECT count(*)::int AS n FROM kernel.routine_runs WHERE org_id = ${world.orgId}::uuid`)
    expect(runs[0]?.n).toBe(0)
  })

  it("the Morning brief's thread holds the brief of the board date", async () => {
    const [brief] = await rows(sql`
      SELECT m.content FROM kernel.routines r
        JOIN kernel.messages m ON m.thread_id = r.output_thread_id AND m.author_type = 'agent'
       WHERE r.org_id = ${world.orgId}::uuid AND r.name = 'Morning brief'`)
    expect(brief?.content).toBe(studioMorningBrief(BOARD_DATE))
  })

  it("the change request card names the Scope check routine that staged it, never the visitor", async () => {
    const [card] = await rows(sql`
      SELECT id::text AS id FROM kernel.approval_requests
       WHERE org_id = ${world.orgId}::uuid AND tool_name = 'agreements:change_request_send'`)
    const requesters = await withPrivilegedDb(world.orgId, "studio-desk-requester", (tx) =>
      readApprovalRequesters(tx, world.orgId, [String(card?.id)]),
    )
    const requester = requesters.get(String(card?.id))
    expect(requester?.kind).toBe("agent")
    expect(requester?.name).toMatch(/^Routine /)
    expect(requester?.name).not.toContain("Studio Owner")
  })

  it("the studio's invoicing documents name only the studio's own clients and ship nothing", async () => {
    const docs = await rows(sql`
      SELECT type, counterparty_name AS name,
             counterparty_shipping_address AS ship_to, counterparty_shipping_name AS ship_name
        FROM app_invoicing.documents WHERE org_id = ${world.orgId}::uuid`)
    expect(docs.length).toBeGreaterThan(0)
    // Its clients now and its clients of earlier work: no other world's customer or supplier.
    const own = new Set<string>([
      ...STUDIO_CLIENTS.map((c) => c.name),
      ...STUDIO_PAST_CLIENTS.map((c) => c.name),
    ])
    expect([...new Set(docs.map((d) => String(d.name)))].filter((n) => !own.has(n))).toEqual([])
    // A services firm buys nothing on purchase orders here and ships no parcel.
    expect(docs.filter((d) => d.type === "purchase_order")).toEqual([])
    expect(docs.filter((d) => d.ship_to !== null || d.ship_name !== null)).toEqual([])
  })

  it("the sales scenario's start brings its routine, off, on the owner's own agent", async () => {
    const owner = userIdOf("owner")
    await seedScenarioStart(world.orgId, owner, "sales", "studio")
    const agent = await personalAgentOf(seedContext({ orgId: world.orgId, now: new Date() }), owner)
    const found = await rows(sql`
      SELECT enabled, owner_agent_id::text AS agent FROM kernel.routines
       WHERE org_id = ${world.orgId}::uuid AND name = ${STUDIO_PROSPECT_ROUTINE_NAME}`)
    expect(found.map((r) => [r.enabled, r.agent])).toEqual([[false, agent]])
  })
})
