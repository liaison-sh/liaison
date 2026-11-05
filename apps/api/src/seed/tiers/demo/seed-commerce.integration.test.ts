// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedDemoCommerce` against a REAL database and, more importantly, against the
// REAL read paths.
//
// Rows an app cannot render are worthless for a demo, so nothing here is
// asserted from the seeder's own return value: every claim is either counted
// out of Postgres or read back through the app's own tool handler, executed in
// the sandbox exactly as a visitor's click would execute it
// (`invoicing:documents_search`, `boxtal:ready_list` / `returns_list` /
// `queue_counts`, `social:findings_list` / `counts` / `dm_list`,
// `pennylane:home_load`).
//
// Locally: run it against `liaison_hardening_test`, never a shared database.
//   DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_hardening_test \
//     bun test src/seed/tiers/demo/seed-commerce.integration.test.ts --timeout 900000
// It needs `apps/api` as its cwd for the `~/` alias, like the rest of the
// `migration` suite in scripts/test-run.ts.
import { beforeAll, describe, expect, it } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg, reloadInstalledApps } from "~/modules/apps/init"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { type SeedDemoCommerceResult, seedDemoCommerce } from "./seed-commerce"
import { type SeedDemoOrgResult, seedDemoOrg } from "./seed-org"

const ROOT = path.join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const ORG_SLUG = "demo-seed-commerce-integration"
const DB_URL = process.env.DATABASE_URL ?? ""

/** A fixed anchor, so two runs in this file produce byte-identical rows. */
const BASE_TIME = new Date("2026-09-16T12:00:00.000Z")

/** The apps this batch fills, and whose read paths it is checked through. */
const APPS = ["invoicing", "boxtal", "social", "pennylane", "monitoring"] as const

// This test WRITES. The development database is shared with another checkout,
// so it is refused outright rather than reported after the fact.
beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev/.test(DB_URL)) {
    throw new Error("refusing to seed liaison_dev: use liaison_hardening_test")
  }
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(ROOT, ".liaison-apps-demo-commerce")
  }
})

/** Run a tool the way the product runs it: through the sandbox, as the founder. */
async function callTool<T>(org: SeedDemoOrgResult, toolName: string, params: unknown): Promise<T> {
  const result = await executeTool<T>({
    toolName,
    orgId: org.orgId,
    actor: {
      actorType: "user",
      userId: org.adminUserId,
      orgId: org.orgId,
      scopes: ["*"],
      dimensionGrants: {},
    } as never,
    params,
    origin: "system",
  })
  return result.data
}

const COUNTED_TABLES = [
  "app_invoicing.issuer_profiles",
  "app_invoicing.tax_regimes",
  "app_invoicing.hs_code_library",
  "app_invoicing.contact_relationships",
  "app_invoicing.documents",
  "app_invoicing.document_lines",
  "app_boxtal.shipping_profile",
  "app_boxtal.product_profile",
  "app_boxtal.product_profile_link",
  "app_boxtal.local_product",
  "app_boxtal.pack",
  "app_boxtal.pack_component",
  "app_boxtal.shipment",
  "app_boxtal.claim",
  "app_boxtal.prep_meta",
  "app_boxtal.attention_rule",
  "app_pennylane.pnl_snapshot",
  "app_pennylane.cash_snapshot",
  "app_pennylane.account_class_map",
  "app_social.finding",
  "app_social.watched_object",
  "app_social.dm_conversation",
  "app_social.dm_message",
  "app_social.monitor_term",
  "app_social.sync_state",
  "app_monitoring.incidents",
  "kernel.contacts",
]

async function countsFor(orgId: string): Promise<Record<string, number>> {
  return withSystemDb("demo-commerce-test-counts", async (tx) => {
    const out: Record<string, number> = {}
    for (const table of COUNTED_TABLES) {
      const rows = await tx.execute(
        sql`SELECT count(*) AS count FROM ${sql.raw(table)} WHERE org_id = ${orgId}`,
      )
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
      out[table] = Number((list[0] as { count?: string })?.count ?? 0)
    }
    return out
  })
}

interface DocRow {
  id: string
  type: string
  status: string
  payment_status: string
  number: string | null
  counterparty_country: string
  counterparty_vat_id: string | null
  tax_treatment: string
  subtotal_minor: string
  tax_total_minor: string
  grand_total_minor: string
  issued_at: string | null
  due_at: string | null
  pdf_status: string | null
  pdf_file_id: string | null
}

interface LineRow {
  document_id: string
  subtotal_minor: string
  tax_minor: string
  total_minor: string
  tax_rate_bp: number | null
  quantity: string
  unit_price_minor: string
}

async function readDocs(orgId: string): Promise<{ docs: DocRow[]; lines: LineRow[] }> {
  return withSystemDb("demo-commerce-test-docs", async (tx) => {
    const d = await tx.execute(
      sql`SELECT id, type, status, payment_status, number, counterparty_country, counterparty_vat_id,
                 tax_treatment, subtotal_minor, tax_total_minor, grand_total_minor,
                 issued_at, due_at, pdf_status, pdf_file_id
          FROM app_invoicing.documents WHERE org_id = ${orgId}`,
    )
    const l = await tx.execute(
      sql`SELECT document_id, subtotal_minor, tax_minor, total_minor, tax_rate_bp, quantity, unit_price_minor
          FROM app_invoicing.document_lines WHERE org_id = ${orgId}`,
    )
    const rows = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []))
    return { docs: rows(d) as DocRow[], lines: rows(l) as LineRow[] }
  })
}

interface IncidentRow {
  id: string
  source: string
  severity: string
  status: string
  count: number
  dedup_key: string | null
  first_seen_at: string
  last_seen_at: string
  acknowledged_at: string | null
  acknowledged_by: string | null
  resolved_at: string | null
  resolved_by: string | null
  reopened_at: string | null
  resolution_note: string | null
}

async function readIncidents(orgId: string): Promise<IncidentRow[]> {
  return withSystemDb("demo-commerce-test-incidents", async (tx) => {
    const r = await tx.execute(
      sql`SELECT id, source, severity, status, count, dedup_key, first_seen_at, last_seen_at,
                 acknowledged_at, acknowledged_by, resolved_at, resolved_by, reopened_at,
                 resolution_note
          FROM app_monitoring.incidents WHERE org_id = ${orgId}`,
    )
    return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as IncidentRow[]
  })
}

/** The org's own user ids, so a triage stamp can be checked against reality. */
async function readOrgUserIds(orgId: string): Promise<Set<string>> {
  return withSystemDb("demo-commerce-test-users", async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM kernel.users WHERE org_id = ${orgId}`)
    const list = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as {
      id: string
    }[]
    return new Set(list.map((u) => u.id))
  })
}

describe("seedDemoCommerce against a real database", () => {
  let org: SeedDemoOrgResult
  let first: SeedDemoCommerceResult
  let second: SeedDemoCommerceResult
  let countsAfterFirst: Record<string, number>
  let countsAfterSecond: Record<string, number>
  let docs: DocRow[]
  let lines: LineRow[]
  let incidents: IncidentRow[]
  let orgUserIds: Set<string>

  beforeAll(async () => {
    org = await seedDemoOrg({ orgSlug: ORG_SLUG, variant: "reserved" })
    await ensureAppsForOrg(org.orgId)
    for (const name of APPS) await installFromDist(name, org.adminUserId)
    await reloadInstalledApps(org.orgId)

    first = await seedDemoCommerce({ org, baseTime: BASE_TIME })
    countsAfterFirst = await countsFor(org.orgId)
    second = await seedDemoCommerce({ org, baseTime: BASE_TIME })
    countsAfterSecond = await countsFor(org.orgId)
    const read = await readDocs(org.orgId)
    docs = read.docs
    lines = read.lines
    incidents = await readIncidents(org.orgId)
    orgUserIds = await readOrgUserIds(org.orgId)
  }, 900_000)

  it("is idempotent: the second run changes no row count and no resolved id", () => {
    expect(countsAfterSecond).toEqual(countsAfterFirst)
    expect(second.documentIdsByKey).toEqual(first.documentIdsByKey)
    expect(second.contactIdsByKey).toEqual(first.contactIdsByKey)
    expect(second.totals).toEqual(first.totals)
    expect(second.issuerProfileId).toBe(first.issuerProfileId)
  })

  it("writes the commerce surface the demo needs, at showroom scale", () => {
    expect(countsAfterFirst["app_invoicing.documents"]).toBeGreaterThanOrEqual(25)
    expect(countsAfterFirst["app_invoicing.documents"]).toBeLessThanOrEqual(40)
    expect(countsAfterFirst["app_invoicing.document_lines"]).toBeGreaterThan(
      countsAfterFirst["app_invoicing.documents"],
    )
    expect(countsAfterFirst["app_invoicing.issuer_profiles"]).toBe(1)
    expect(countsAfterFirst["app_invoicing.tax_regimes"]).toBe(4)
    expect(countsAfterFirst["app_boxtal.shipment"]).toBeGreaterThanOrEqual(10)
    expect(countsAfterFirst["app_boxtal.claim"]).toBeGreaterThanOrEqual(2)
    expect(countsAfterFirst["app_boxtal.pack"]).toBeGreaterThanOrEqual(4)
    expect(countsAfterFirst["app_boxtal.pack_component"]).toBeGreaterThanOrEqual(4)
    expect(countsAfterFirst["app_boxtal.attention_rule"]).toBeGreaterThanOrEqual(1)
    expect(countsAfterFirst["app_social.finding"]).toBeGreaterThanOrEqual(20)
    expect(countsAfterFirst["app_social.dm_conversation"]).toBeGreaterThanOrEqual(3)
    expect(countsAfterFirst["app_social.dm_message"]).toBeGreaterThanOrEqual(6)
    expect(countsAfterFirst["app_social.monitor_term"]).toBeGreaterThanOrEqual(5)
    expect(countsAfterFirst["app_pennylane.pnl_snapshot"]).toBe(1)
    expect(countsAfterFirst["app_pennylane.cash_snapshot"]).toBe(1)
  })

  it("the money adds up: every line and every document total is arithmetically correct", () => {
    const byDoc = new Map<string, LineRow[]>()
    for (const l of lines) {
      const list = byDoc.get(l.document_id) ?? []
      list.push(l)
      byDoc.set(l.document_id, list)
    }
    expect(byDoc.size).toBe(docs.length)
    for (const doc of docs) {
      const docLines = byDoc.get(doc.id) ?? []
      expect(docLines.length).toBeGreaterThan(0)
      let subtotal = 0n
      let tax = 0n
      for (const l of docLines) {
        const lineSubtotal = BigInt(l.subtotal_minor)
        const rate = BigInt(l.tax_rate_bp ?? 0)
        // subtotal = unit price x quantity, with the quantity a NUMERIC(15,3).
        const quantityThousandths = BigInt(Math.round(Number(l.quantity) * 1000))
        expect(lineSubtotal).toBe((BigInt(l.unit_price_minor) * quantityThousandths) / 1000n)
        // tax re-derived from the line subtotal and its own rate.
        const expectedTax = rate === 0n ? 0n : (lineSubtotal * rate) / 10_000n
        expect(BigInt(l.tax_minor)).toBe(expectedTax)
        expect(BigInt(l.total_minor)).toBe(lineSubtotal + BigInt(l.tax_minor))
        subtotal += lineSubtotal
        tax += BigInt(l.tax_minor)
      }
      expect(BigInt(doc.subtotal_minor)).toBe(subtotal)
      expect(BigInt(doc.tax_total_minor)).toBe(tax)
      expect(BigInt(doc.grand_total_minor)).toBe(subtotal + tax)
    }
  })

  it("applies the French VAT treatment each counterparty actually earns", () => {
    const eu = new Set([
      "AT",
      "BE",
      "BG",
      "HR",
      "CY",
      "CZ",
      "DK",
      "EE",
      "FI",
      "FR",
      "DE",
      "GR",
      "HU",
      "IE",
      "IT",
      "LV",
      "LT",
      "LU",
      "MT",
      "NL",
      "PL",
      "PT",
      "RO",
      "SK",
      "SI",
      "ES",
      "SE",
    ])
    const seen = new Set<string>()
    for (const doc of docs) {
      const c = doc.counterparty_country
      const expected =
        c === "FR"
          ? "eu_domestic"
          : eu.has(c)
            ? doc.counterparty_vat_id
              ? "eu_reverse_charge"
              : "eu_b2c_oss"
            : "eu_export_non_eu"
      expect(doc.tax_treatment).toBe(expected)
      seen.add(expected)
    }
    // All four branches are exercised by the seeded set, not just the easy one.
    expect([...seen].sort()).toEqual([
      "eu_b2c_oss",
      "eu_domestic",
      "eu_export_non_eu",
      "eu_reverse_charge",
    ])
  })

  it("issued documents carry the app's own retry-me PDF state, drafts carry none", () => {
    for (const doc of docs) {
      expect(doc.pdf_file_id).toBeNull()
      if (doc.status === "draft") expect(doc.pdf_status).toBeNull()
      else expect(doc.pdf_status).toBe("pending")
    }
  })

  it("spans every document kind and a spread of statuses", () => {
    const types = new Set(docs.map((d) => d.type))
    expect([...types].sort()).toEqual([
      "credit_note",
      "invoice",
      "proforma",
      "purchase_order",
      "quote",
    ])
    const statuses = new Set(docs.map((d) => d.status))
    for (const s of ["draft", "issued", "paid", "sent", "accepted", "expired"]) {
      expect(statuses.has(s)).toBe(true)
    }
    const payment = new Set(docs.map((d) => d.payment_status))
    for (const p of ["unpaid", "partial", "paid", "refunded"]) {
      expect(payment.has(p)).toBe(true)
    }
    // Genuinely overdue by the product's COMPUTED rule: issued, not settled,
    // past its due date. A stored status='overdue' would be invisible to it.
    const overdue = docs.filter(
      (d) =>
        d.type === "invoice" &&
        d.status === "issued" &&
        d.payment_status !== "paid" &&
        d.due_at !== null &&
        new Date(d.due_at).getTime() < BASE_TIME.getTime(),
    )
    expect(overdue.length).toBeGreaterThanOrEqual(3)
    // At least one is old enough to be interesting rather than merely late.
    const oldest = Math.max(
      ...overdue.map((d) => BASE_TIME.getTime() - new Date(d.due_at as string).getTime()),
    )
    expect(oldest / 86_400_000).toBeGreaterThan(45)
  })

  // ── Monitoring ─────────────────────────────────────────────────────────────

  it("seeds a monitoring board covering every status and every severity", () => {
    expect(countsAfterFirst["app_monitoring.incidents"]).toBeGreaterThanOrEqual(12)
    expect(incidents.length).toBe(countsAfterFirst["app_monitoring.incidents"])

    const byStatus = (s: string) => incidents.filter((i) => i.status === s)
    expect(byStatus("open").length).toBeGreaterThanOrEqual(1)
    expect(byStatus("acknowledged").length).toBeGreaterThanOrEqual(1)
    expect(byStatus("resolved").length).toBeGreaterThanOrEqual(1)
    expect(
      byStatus("open").length + byStatus("acknowledged").length + byStatus("resolved").length,
    ).toBe(incidents.length)

    const severities = new Set(incidents.map((i) => i.severity))
    expect([...severities].sort()).toEqual(["critical", "info", "warning"])
    expect(incidents.filter((i) => i.severity === "critical").length).toBeGreaterThanOrEqual(1)

    // More than one source, or the dashboard's per source health rail is a
    // single tile and its sort is untested.
    expect(new Set(incidents.map((i) => i.source)).size).toBeGreaterThanOrEqual(3)

    // Distinct dedup keys where present: the partial unique index on
    // (org_id, source, dedup_key) would have refused a collision outright.
    const keys = incidents.map((i) => i.dedup_key).filter((k): k is string => k !== null)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("carries the repeat and the reopen shapes the board exists to expose", () => {
    const repeated = incidents.filter((i) => Number(i.count) > 1)
    expect(repeated.length).toBeGreaterThanOrEqual(1)
    // A repeat is one incident whose count climbed while first_seen stayed put.
    const flapping = repeated.find(
      (i) => new Date(i.last_seen_at).getTime() - new Date(i.first_seen_at).getTime() > 86_400_000,
    )
    expect(flapping).toBeDefined()
    expect(Number(flapping?.count)).toBeGreaterThan(1)

    for (const i of incidents) {
      expect(new Date(i.last_seen_at).getTime()).toBeGreaterThanOrEqual(
        new Date(i.first_seen_at).getTime(),
      )
      expect(new Date(i.last_seen_at).getTime()).toBeLessThanOrEqual(BASE_TIME.getTime())
    }

    const reopened = incidents.filter((i) => i.reopened_at !== null)
    expect(reopened.length).toBeGreaterThanOrEqual(1)
  })

  it("every triage stamp names a real user in this org and resolves with a note", () => {
    expect(orgUserIds.size).toBeGreaterThan(1)
    const acked = incidents.filter((i) => i.status === "acknowledged")
    expect(acked.length).toBeGreaterThanOrEqual(1)
    for (const i of acked) {
      expect(i.acknowledged_at).not.toBeNull()
      expect(i.acknowledged_by).not.toBeNull()
      expect(orgUserIds.has(i.acknowledged_by as string)).toBe(true)
    }
    const resolved = incidents.filter((i) => i.status === "resolved")
    expect(resolved.length).toBeGreaterThanOrEqual(1)
    for (const i of resolved) {
      expect(i.resolved_at).not.toBeNull()
      expect(i.resolved_by).not.toBeNull()
      expect(orgUserIds.has(i.resolved_by as string)).toBe(true)
      expect((i.resolution_note ?? "").length).toBeGreaterThan(40)
      // Customer readable prose: no dash punctuation anywhere in the board.
      expect(i.resolution_note).not.toMatch(/[\u2013\u2014]|--/)
    }
    for (const i of incidents) {
      if (i.status !== "resolved") expect(i.resolved_at).toBeNull()
    }
  })

  it("monitoring incidents_list, filters and summary render the seeded board", async () => {
    // Every monitoring handler answers in the app's own `{ data }` envelope.
    const all = await callTool<{ data: { id: string; status: string; count: number }[] }>(
      org,
      "monitoring:incidents_list",
      { limit: 200 },
    )
    expect(all.data.length).toBe(incidents.length)

    for (const status of ["open", "acknowledged", "resolved"]) {
      const rows = await callTool<{ data: { status: string }[] }>(
        org,
        "monitoring:incidents_list",
        { status, limit: 200 },
      )
      expect(rows.data.length).toBe(incidents.filter((i) => i.status === status).length)
      expect(rows.data.length).toBeGreaterThanOrEqual(1)
      for (const row of rows.data) expect(row.status).toBe(status)
    }

    const criticals = await callTool<{ data: { severity: string }[] }>(
      org,
      "monitoring:incidents_list",
      { severity: "critical", limit: 200 },
    )
    expect(criticals.data.length).toBe(incidents.filter((i) => i.severity === "critical").length)
    expect(criticals.data.length).toBeGreaterThanOrEqual(1)

    const summary = await callTool<{
      data: {
        open: { critical: number; warning: number; info: number; total: number }
        acknowledged: number
        sources: { source: string; open: number }[]
      }
    }>(org, "monitoring:incidents_summary", {})
    const openRows = incidents.filter((i) => i.status === "open")
    expect(summary.data.open.total).toBe(openRows.length)
    expect(summary.data.open.critical).toBe(
      openRows.filter((i) => i.severity === "critical").length,
    )
    expect(summary.data.acknowledged).toBe(
      incidents.filter((i) => i.status === "acknowledged").length,
    )
    expect(summary.data.sources.length).toBe(new Set(incidents.map((i) => i.source)).size)
  })

  // ── The read paths ─────────────────────────────────────────────────────────

  it("invoicing documents_search renders the seeded set through the app's own read", async () => {
    const all = await callTool<
      { id: string; number: string | null; counterparty_name: string | null }[]
    >(org, "invoicing:documents_search", { limit: 100 })
    expect(all.length).toBe(docs.length)
    const numbers = all.map((r) => r.number).filter((n): n is string => n !== null)
    expect(numbers.length).toBeGreaterThanOrEqual(25)
    expect(new Set(numbers).size).toBe(numbers.length)

    const issued = await callTool<{ id: string }[]>(org, "invoicing:documents_search", {
      status: "issued",
      limit: 100,
    })
    expect(issued.length).toBeGreaterThanOrEqual(5)

    // Free-text retrieval by counterparty name, the path an agent actually takes.
    const byName = await callTool<{ counterparty_name: string | null }[]>(
      org,
      "invoicing:documents_search",
      { query: "Klangwerk", limit: 50 },
    )
    expect(byName.length).toBeGreaterThanOrEqual(3)
    for (const row of byName) expect(row.counterparty_name).toContain("Klangwerk")

    // And one document read whole, with its lines, through documents_get.
    const target = all.find((r) => r.number?.startsWith("INV-"))
    expect(target).toBeDefined()
    const full = await callTool<{ lines: unknown[]; grand_total_minor: unknown }>(
      org,
      "invoicing:documents_get",
      { id: target?.id },
    )
    expect(Array.isArray(full.lines)).toBe(true)
    expect(full.lines.length).toBeGreaterThan(0)
  })

  it("boxtal ready_list, returns_list and queue_counts render non trivial queues", async () => {
    const ready = await callTool<{ rows: { id: string; has_label: boolean; recipient: string }[] }>(
      org,
      "boxtal:ready_list",
      {},
    )
    expect(ready.rows.length).toBeGreaterThanOrEqual(3)
    for (const row of ready.rows) {
      expect(row.has_label).toBe(true)
      expect(row.recipient).not.toBe("-")
    }

    const returns = await callTool<{ rows: { id: string; reason: string | null }[] }>(
      org,
      "boxtal:returns_list",
      {},
    )
    expect(returns.rows.length).toBeGreaterThanOrEqual(2)
    for (const row of returns.rows) expect(row.reason).not.toBeNull()

    const counts = await callTool<{
      ready: number
      returns: number
      exceptions: number
      to_prepare: number
    }>(org, "boxtal:queue_counts", {})
    expect(counts.ready).toBe(ready.rows.length)
    expect(counts.returns).toBe(returns.rows.length)
    expect(counts.exceptions).toBeGreaterThanOrEqual(2)

    const exceptions = await callTool<{ rows: { tracking_status: string | null }[] }>(
      org,
      "boxtal:exceptions_list",
      {},
    )
    expect(exceptions.rows.length).toBe(counts.exceptions)
  })

  it("social findings_list, counts and dm_list render the listening feed", async () => {
    const findings = await callTool<{ findings: unknown[]; totalCount: number }>(
      org,
      "social:findings_list",
      { limit: 100 },
    )
    expect(findings.totalCount).toBeGreaterThanOrEqual(20)
    expect(findings.findings.length).toBe(findings.totalCount)

    const counts = await callTool<{
      findings_new: number
      awaiting_approval: number
      open_dms: number
    }>(org, "social:counts", {})
    expect(counts.findings_new).toBeGreaterThanOrEqual(1)
    expect(counts.awaiting_approval).toBeGreaterThanOrEqual(1)
    expect(counts.open_dms).toBeGreaterThanOrEqual(1)

    const dms = await callTool<{ conversations: { last_message_snippet: unknown }[] }>(
      org,
      "social:dm_list",
      {},
    )
    expect(dms.conversations.length).toBeGreaterThanOrEqual(2)

    const watched = await callTool<{ watched: unknown[] }>(org, "social:watched_list", {})
    expect(watched.watched.length).toBeGreaterThanOrEqual(3)

    const terms = await callTool<{ terms: unknown[] }>(org, "social:monitor_terms_list", {})
    expect(terms.terms.length).toBeGreaterThanOrEqual(5)
  })

  it("pennylane home_load renders a dashboard consistent with the invoicing totals", async () => {
    const home = await callTool<{
      pnl: {
        revenue_minor: string
        cogs_minor: string
        gross_margin_minor: string
      } | null
      cash: { total_by_currency: Record<string, string>; cash_status: string } | null
    }>(org, "pennylane:home_load", {})

    expect(home.pnl).not.toBeNull()
    expect(home.cash).not.toBeNull()
    const revenue = BigInt(home.pnl?.revenue_minor ?? "0")
    const cogs = BigInt(home.pnl?.cogs_minor ?? "0")
    expect(BigInt(home.pnl?.gross_margin_minor ?? "0")).toBe(revenue - cogs)

    // The same net-of-tax revenue the invoicing documents add up to: every
    // non draft invoice, with the credit notes subtracted.
    let expected = 0n
    for (const d of docs) {
      if (d.type === "invoice" && d.status !== "draft") expected += BigInt(d.subtotal_minor)
      if (d.type === "credit_note") expected += BigInt(d.subtotal_minor)
    }
    expect(revenue).toBe(expected)
    expect(revenue).toBe(BigInt(first.totals.revenueMinor))
    expect(Object.keys(home.cash?.total_by_currency ?? {})).toContain("EUR")
    expect(home.cash?.cash_status).toBe("live")
  })
})
