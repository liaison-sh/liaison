// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An organization's own sales app reporting its sales to invoicing through revenue-stream@1, on
// the real kernel, sandbox, outbox and Postgres: the app is no dependency of invoicing and
// invoicing names no app. Its sale:paid reaches invoicing's contract subscription, which reads the
// sale through the contract (from the app's own table) and issues one invoice under the bound
// stream's issuer, keyed by the sale; a replay issues nothing more; the app's sale:refunded gives
// one credit note on that invoice; invoicing lists the stream and, read only, the app's sales.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  flushEventHandlers,
  initEventBus,
  _publishEventInternal as publishEvent,
} from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { insertAppRow } from "~/seed/factories/app-tables"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _firstParty: true,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "invoicing",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

const opTool = (handler: string, props: string[]) => ({
  description: `revenue-stream@1 ${handler}`,
  requiredScopes: ["salesbook:internal"],
  handler,
  trustBoundary: "internal",
  agentVisible: false,
  contractOnly: true,
  readOnly: true,
  params: { type: "object", properties: Object.fromEntries(props.map((p) => [p, {}])) },
})

const writeTool = (handler: string) => ({
  description: `salesbook ${handler}`,
  requiredScopes: ["salesbook:write"],
  handler,
  writesToTable: "app_salesbook.sales",
  params: { type: "object", properties: { sale: {}, external_id: {}, refund: {}, announce: {} } },
})

/** The organization's own app: no first-party flag, no dependency either way. */
const SALESBOOK = {
  name: "salesbook",
  version: "1.0.0",
  trusted: false,
  scopes: ["salesbook:internal", "salesbook:write"],
  schema: {
    sales: {
      rlsScope: "internal",
      internalWriteScope: "salesbook:write",
      fields: { external_id: "string", sale: "json" },
      constraints: { unique: [["external_id"]] },
    },
  },
  tools: {
    rs_sale_get: opTool("rs_sale_get", ["external_id"]),
    rs_sales_list: opTool("rs_sales_list", ["paid_from", "paid_to", "cursor"]),
    record_sale: writeTool("record_sale"),
    store_sale: writeTool("store_sale"),
    refund_sale: writeTool("refund_sale"),
  },
  implements: [
    {
      contract: "revenue-stream",
      version: 1,
      tools: { sale_get: "rs_sale_get", sales_list: "rs_sales_list" },
    },
  ],
  events: { emits: ["sale:paid", "sale:refunded"] },
  _format: "manifest",
  _bundlePath: join(import.meta.dir, "__fixtures__", "revenue-app", "handler-bundle.js"),
}

type Row = Record<string, unknown>
let ORG = ""
let actor: UserContext
let issuerId = ""
let streamId = ""

const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:settings:read",
  "invoicing:settings:write",
  "salesbook:write",
  "salesbook:internal",
]

async function tool(name: string, params: Row): Promise<Row> {
  const res = await executeTool<Row>({
    toolName: name,
    orgId: ORG,
    actor,
    params,
    origin: "human-ui",
  })
  return res.data as Row
}

/**
 * The app's event as its payment provider's webhook makes it: published by the app, as the
 * system (the way a payment provider's webhook reaches invoicing).
 */
async function announce(action: "paid" | "refunded", externalId: string, at: string) {
  await publishEvent({
    app: "salesbook",
    entity: "sale",
    action,
    entityId: externalId,
    data: { external_id: externalId, occurred_at: at },
    orgId: ORG,
    actorId: "system:salesbook",
    actorType: "system",
  })
  await drain()
}

async function drain(): Promise<void> {
  await flushEventHandlers()
  for (let i = 0; i < 20; i++) if (!(await processOutboxBatch())) break
  await flushEventHandlers()
}

function sale(id: string, soldAt: string): Row {
  return {
    external_id: id,
    refs: { order_name: `SB-${id}` },
    sold_at: soldAt,
    paid: { status: "paid", payment_ref: `pay-${id}` },
    currency: "EUR",
    buyer: {
      email: "lena@example.de",
      name: "Lena Buyer",
      kind: "individual",
      billing: { line1: "Hauptstr. 1", postcode: "10115", city: "Berlin", country: "DE" },
      tax_evidence: { billing_country: "DE", card_country: "DE" },
    },
    lines: [
      {
        description: "Workshop seat",
        quantity: "1",
        unit_price_minor: "10000",
        kind: "service",
        tax: { rate_bp: 1900, amount_minor: "1900", reported_by_source: true },
      },
    ],
    totals: { total_minor: "11900", subtotal_minor: "10000", tax_minor: "1900" },
  }
}

async function docs(): Promise<Row[]> {
  return sql<Row[]>`SELECT id::text, type, number, external_ref, grand_total_minor::text AS total,
      external_refs, original_document_id::text AS original
    FROM app_invoicing.documents WHERE org_id = ${ORG} ORDER BY created_at`
}

describe("an organization's own sales app reports its sales to invoicing (revenue-stream@1)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    ORG = (await createTestOrg()).id
    const admin = await minimal.person(ORG, { role: "admin" })
    actor = { actorType: "user", userId: admin.id, orgId: ORG, scopes: SCOPES, dimensionGrants: {} }
    initEventBus()
    await initSandboxPool()
    await initWorkerPool()
    const reg = await registerApps([invoicingDescriptor() as never, SALESBOOK as never], ORG)
    expect(reg.failedApps).toEqual([])
    const created = await tool("invoicing:settings_issuer_profile_create", {
      legal_name: "Atelier Test SARL",
      country: "FR",
      vat_id: "FR40902000009",
      address: "1 rue de Test, 75011 Paris",
      default_currency: "EUR",
      default_language: "en",
    })
    issuerId = String(created.id)
    await sql`UPDATE app_invoicing.issuer_profiles SET timezone = 'Europe/Paris' WHERE id = ${issuerId}`
    // The stream a person bound (revenue_stream_bind, gated and never auto-approved: its decision
    // is the row it writes), from 20 November.
    streamId = crypto.randomUUID()
    await withPrivilegedDb(ORG, "test", (tx) =>
      insertAppRow(tx as never, "invoicing", "revenue_streams", {
        id: streamId,
        org_id: ORG,
        provider_app: "salesbook",
        source_ref: null,
        label: "Workshops",
        issuer_profile_id: issuerId,
        mode: "auto",
        issue_from: "2026-11-20T00:00:00.000Z",
        mail: "none",
      }),
    )
  }, 180_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("a sale:paid issues one invoice under the stream's issuer, keyed by the sale; a replay issues nothing more", async () => {
    await tool("salesbook:record_sale", {
      sale: sale("S-1", "2026-11-21T10:00:00.000Z"),
      announce: false,
    })
    await announce("paid", "S-1", "2026-11-21T10:00:00.000Z")
    let rows = await docs()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: "invoice",
      external_ref: "rs:salesbook:S-1:software",
      total: "11900",
    })
    expect(rows[0]?.external_refs).toMatchObject({
      revenue_stream_id: streamId,
      sale_provider: "salesbook",
      sale_external_id: "S-1",
      order_name: "SB-S-1",
    })
    await announce("paid", "S-1", "2026-11-21T10:00:00.000Z")
    rows = await docs()
    expect(rows).toHaveLength(1)
  }, 120_000)

  it("a sale paid before the stream was bound is not issued by its event", async () => {
    await tool("salesbook:record_sale", {
      sale: sale("S-0", "2026-11-10T10:00:00.000Z"),
      announce: false,
    })
    await announce("paid", "S-0", "2026-11-10T10:00:00.000Z")
    const rows = await docs()
    expect(rows.map((r) => r.external_ref)).toEqual(["rs:salesbook:S-1:software"])
  }, 120_000)

  it("a sale:refunded gives one credit note on the sale's invoice, keyed by the refund", async () => {
    const refund = { refund_id: "R-1", amount_minor: "5950", at: "2026-11-22T09:00:00.000Z" }
    await tool("salesbook:refund_sale", { external_id: "S-1", refund, announce: false })
    await announce("refunded", "S-1", refund.at)
    const rows = await docs()
    const invoice = rows.find((r) => r.type === "invoice") as Row
    const notes = rows.filter((r) => r.type === "credit_note")
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      external_ref: "rs:salesbook:refund:R-1",
      original: invoice.id,
    })
    expect(Math.abs(Number(notes[0]?.total))).toBe(5950)
  }, 120_000)

  it("invoicing lists the stream, and the catch-up preview lists the app's sales without writing", async () => {
    const list = await tool("invoicing:revenue_streams_list", {})
    expect(list.availableProviders).toContain("salesbook")
    expect((list.streams as Row[]).map((s) => s.streamId)).toContain(streamId)
    const before = (await docs()).length
    const preview = await tool("invoicing:revenue_stream_catch_up_preview", {
      streamId,
      paidFrom: "2026-11-01T00:00:00.000Z",
      paidTo: "2026-12-01T00:00:00.000Z",
    })
    expect(preview).toMatchObject({
      dryRun: true,
      counts: { sales: 2, alreadyInvoiced: 1, toIssue: 1 },
    })
    const sales = preview.sales as Row[]
    // Oldest first: the sale from before the binding, then the invoiced one.
    expect(sales.map((s) => s.external_id)).toEqual(["S-0", "S-1"])
    expect(sales[0]).toMatchObject({
      treatment: "eu_b2c_oss",
      net_minor: "10000",
      tax_minor: "1900",
      source_tax_minor: "1900",
      already_invoiced: null,
      blockers: [],
    })
    expect(sales[1]?.already_invoiced).toBeTruthy()
    expect((await docs()).length).toBe(before)
  }, 120_000)
})
