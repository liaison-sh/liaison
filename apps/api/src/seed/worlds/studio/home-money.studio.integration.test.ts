// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Money on Home on the services world, freshly seeded: at the November and December month ends,
// before and after the months are drafted (three projects reconciled, a milestone, an advance),
// each project holds at most one money item waiting on its biller. The counts are stated before
// and after.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type AttentionItem, DEMO_WORLD_NEEDS } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { computeAttentionItems } from "~/apps/projects/attention"
import { MONTH_CLOSE_KIND } from "~/apps/projects/service/home-lines"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { createHandlerApprovalRequest } from "~/modules/apps/execute-tool"
import { primeOrgApps } from "~/modules/apps/org-apps"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { seedContext } from "~/seed/context"
import { actorFor, rowsOf } from "~/seed/factories/people/actors"
import { seedReconciliation } from "~/seed/factories/projects/reconcile"
import { seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import * as minimal from "~/seed/tiers/minimal"
import { invoiceCarrying } from "~/tests/helpers/projects-claims"
import {
  activeAppNames,
  installFromDist,
  uninstallAppsSince,
} from "../../../../test-support/seed/install-dist-apps"

const DB_URL = process.env.DATABASE_URL ?? ""
/** The board date: Monday 9 November 2026, 09:30 in Paris. */
const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")
/** November's line day (Friday 27), its last day, December's line day and its last day. */
const DAYS = ["2026-11-27", "2026-11-30", "2026-12-30", "2026-12-31"] as const

let orgId = ""
let biller = ""
let ownerId = ""
const keyOf = new Map<string, string>()
const idOf = new Map<string, string>()

const noon = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d, 12))
}

/**
 * The biller's money items on `day`, per project key and month ("ALPINE 2026-11"): month lines
 * (their period) and invoice issue approvals (the month of their latest issue day).
 */
async function moneyOn(day: string): Promise<Record<string, string[]>> {
  const actor = await actorFor(seedContext({ orgId, now: BOARD_DATE, log: () => {} }), biller)
  const items: AttentionItem[] = await withRlsContext(actor, async (tx) => [
    ...(await computeAttentionItems(tx, orgId, biller, [], noon(day))),
    ...(await computeApprovalAttentionItems(tx, orgId, biller, [], noon(day))),
  ])
  const out: Record<string, string[]> = {}
  const add = (projectId: string | null | undefined, month: unknown, what: string) => {
    const key = projectId ? keyOf.get(projectId) : undefined
    if (!key) return
    const slot = `${key} ${String(month).slice(0, 7)}`
    out[slot] = [...(out[slot] ?? []), what]
  }
  for (const i of items) {
    if ((i.kind as string) === MONTH_CLOSE_KIND) add(i.entityId, i.metadata?.period, "month line")
    if (i.kind === "approval_pending" && i.metadata?.toolName === "invoicing:invoice_issue") {
      const rows = rowsOf<{ p: string | null }>(
        await db.execute(sql`
          SELECT d.billing_project_id::text AS p
            FROM kernel.approval_requests a
            JOIN app_invoicing.documents d ON d.id::text = a.current_payload->>'draft_id'
           WHERE a.id = ${i.entityId}::uuid`),
      )
      add(rows[0]?.p, i.metadata?.latestOn, "issue approval")
    }
  }
  return out
}

/** The month of `key` drafted as Create drafts it: the reconciliation past proposed, its draft
 *  invoice carrying its key, and the draft's issue approval parked by invoicing. */
async function drafted(key: string, month: string, latestOn: string, ref?: string) {
  const projectId = idOf.get(key) as string
  let externalRef = ref
  if (!externalRef) {
    const id = await seedReconciliation(orgId, {
      now: new Date(),
      projectId,
      createdBy: biller,
      threadId: await minimal.thread(orgId, biller),
      state: "drafted",
      month,
      idleDays: 0,
      documentRef: "pending",
    })
    externalRef = `reconcile:${id}:1`
    await db.execute(sql`
      UPDATE app_projects.reconciliations SET document_ref = ${externalRef} WHERE id = ${id}::uuid`)
  }
  const doc = await invoiceCarrying(
    {
      orgId,
      owner: { userId: ownerId } as minimal.Session,
      projectId,
      tasks: {},
      threadId: "",
    },
    { externalRef, status: "draft" },
  )
  await createHandlerApprovalRequest({
    orgId,
    requestedBy: biller,
    actorScopes: ["invoicing:*", "projects:*"],
    defaultAppName: "invoicing",
    origin: "in-app-agent",
    input: {
      tool_name: "invoicing:invoice_issue",
      summary: `Issue the ${key} draft for ${month}`,
      summary_detail: { lines: ["Line 1", "Line 2", "Line 3"], latest_on: latestOn },
      current_payload: { draft_id: doc.id },
      approve_scope: "invoicing:documents:write",
      expiry_hours: 720,
    },
  })
}

/** The apps active before the world seed: the ones it adds are removed after the file. */
let appsBeforeSeed = new Set<string>()

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "studio-home-money-")),
      "apps",
    )
  }
  await installFromDist("invoicing", crypto.randomUUID())
  // What the world seed installs from the catalog (its needs name the agreements app).
  appsBeforeSeed = await activeAppNames()
  const slug = `studio-money-${crypto.randomUUID().slice(0, 8)}`
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
  await primeOrgApps(orgId, 0)
  const people = await withPrivilegedDb(orgId, "studio-money:people", async (tx) =>
    rowsOf<{ email: string; id: string }>(
      await tx.execute(
        sql`SELECT email, id::text AS id FROM kernel.users WHERE org_id = ${orgId}::uuid`,
      ),
    ),
  )
  biller = people.find((p) => p.email.startsWith("anais@"))?.id ?? ""
  ownerId = people.find((p) => p.email.startsWith("owner@"))?.id ?? biller
  for (const r of await withPrivilegedDb(orgId, "studio-money:projects", async (tx) =>
    rowsOf<{ id: string; key: string }>(
      await tx.execute(
        sql`SELECT id::text AS id, key FROM app_projects.projects WHERE org_id = ${orgId}::uuid`,
      ),
    ),
  )) {
    keyOf.set(r.id, r.key)
    idOf.set(r.key, r.id)
  }
}, 900_000)

afterAll(async () => {
  await uninstallAppsSince(appsBeforeSeed)
  DemoModeTestAccess.set(null)
})

describe("money on Home on the services world", () => {
  it("each project holds at most one money item in Needs you each month", async () => {
    expect(biller).not.toBe("")
    const count = async () =>
      Object.fromEntries(await Promise.all(DAYS.map(async (d) => [d, await moneyOn(d)] as const)))
    const before = await count()
    // Before: the month line on its day, for each project billed by time or by the month.
    // The portal's Beta milestone is not drafted: its task is still in progress.
    expect(before).toEqual({
      "2026-11-27": {
        "ALPINE 2026-11": ["month line"],
        "RHONE 2026-11": ["month line"],
        "SOREL 2026-11": ["month line"],
      },
      "2026-11-30": {},
      "2026-12-30": {
        "ALPINE 2026-12": ["month line"],
        "RHONE 2026-12": ["month line"],
        "SOREL 2026-12": ["month line"],
      },
      "2026-12-31": {},
    })

    // November is drafted: three months reconciled and an advance received.
    for (const key of ["ALPINE", "RHONE", "SOREL"]) await drafted(key, "2026-11", "2026-11-30")
    await drafted("VERD", "2026-11", "2026-11-20", "advance:studio-verd")
    // December too, for two of them.
    for (const key of ["ALPINE", "SOREL"]) await drafted(key, "2026-12", "2026-12-31")

    const after = await count()
    // The bar: at most one money item per project and month, whatever the day.
    for (const [day, slots] of Object.entries(after)) {
      for (const [slot, items] of Object.entries(slots)) {
        expect({ day, slot, items: items.length }).toEqual({ day, slot, items: 1 })
      }
    }
    // After: each drafted month is its one issue approval (no line per invoice line); the month
    // line is left only where a month is not drafted (Rhone, December).
    const nov = {
      "ALPINE 2026-11": ["issue approval"],
      "RHONE 2026-11": ["issue approval"],
      "SOREL 2026-11": ["issue approval"],
      "VERD 2026-11": ["issue approval"],
    }
    const dec = { "ALPINE 2026-12": ["issue approval"], "SOREL 2026-12": ["issue approval"] }
    expect(after).toEqual({
      "2026-11-27": { ...nov, ...dec },
      "2026-11-30": { ...nov, ...dec },
      "2026-12-30": { ...nov, ...dec, "RHONE 2026-12": ["month line"] },
      "2026-12-31": { ...nov, ...dec },
    })
  })

  it("an invoice's issue approval reaches the people who hold its scope, not delivery", async () => {
    // The approvals the month ends above parked, as invoicing parks them.
    const rows = rowsOf<{ email: string }>(
      await db.execute(sql`
        SELECT DISTINCT u.email
          FROM kernel.approval_requests a
          CROSS JOIN LATERAL unnest(a.notify_user_ids) AS n(user_id)
          JOIN kernel.users u ON u.id = n.user_id
         WHERE a.org_id = ${orgId}::uuid AND a.tool_name = 'invoicing:invoice_issue'`),
    )
    const reached = rows.map((r) => r.email.split("@")[0]).sort()
    // Finance, the two sales people, the project lead, the co-founder and the owner's seat:
    // the holders of the issue's scope. No developer, designer, data engineer or QA.
    expect(reached).toEqual(["anais", "bastien", "lea", "owner", "romain", "sarah"])
    // A developer's Home holds no issue approval.
    const people = await withPrivilegedDb(orgId, "studio-money:delivery", async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id::text AS id FROM kernel.users
               WHERE org_id = ${orgId}::uuid AND email LIKE 'clara@%'`,
        ),
      ),
    )
    const clara = people[0]?.id ?? ""
    expect(clara).not.toBe("")
    const actor = await actorFor(seedContext({ orgId, now: BOARD_DATE, log: () => {} }), clara)
    const items = await withRlsContext(actor, (tx) =>
      computeApprovalAttentionItems(tx, orgId, clara, [], noon(DAYS[0])),
    )
    expect(items.filter((i) => i.metadata?.toolName === "invoicing:invoice_issue")).toEqual([])
  })
})
