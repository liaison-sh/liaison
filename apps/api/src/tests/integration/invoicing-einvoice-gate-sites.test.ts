// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The invoicing e-invoicing gate, on real Postgres, through the real kernel
// path (executeTool -> preflight -> sandbox handler -> bridge): every manual
// issue site refuses a French business buyer whose e-invoice data is missing
// with the typed, retryable 422 envelope, BEFORE any approval request or any
// document exists. Runs as a user holding only the issuer's scopes (never
// admin). The org's gate mode is `enforce`, except the last case, which proves
// `warn` on an org that already issued documents before regimes existed.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, version, "bundle.js"),
  }
}

const ORG = "00000000-0000-4000-8000-0000000e7001"
const USER = "00000000-0000-4000-8000-0000000e7002"
const THREAD = "00000000-0000-4000-8000-0000000e7003"

// The issuer's own role: documents, contacts, settings read and the approval
// right. Never admin.
const CEO_ROLE_SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:approve",
]

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: CEO_ROLE_SCOPES,
  dimensionGrants: {},
}

// A French business buyer with its kind, category and structured billing
// stated, but no SIREN on file: an e-invoice cannot be issued to it.
const buyer = {
  contact_id: null,
  legal_name: "Exemple Industries SAS",
  country: "FR",
  vat_id: null,
  address: "1 rue de l'Exemple, 75002 Paris",
  email: "compta@exemple-industries.example",
  customer_kind: "business",
  billing_line1: "1 rue de l'Exemple",
  billing_postcode: "75002",
  billing_city: "Paris",
  billing_country_code: "FR",
}
const items = [{ description: "Widget", quantity: "2", unit_price_minor: 5000 }]

let issuerProfileId = ""
let draftOrderComplete = 0

interface ToolFailure {
  code?: string
  status?: number
  body?: { missing?: Array<{ field: string; fix_tool: string }>; gate_mode?: string }
  details?: { retryable?: boolean }
}

async function callTool(
  toolName: string,
  params: Record<string, unknown>,
  origin: "in-app-agent" | "human-ui" = "in-app-agent",
): Promise<{ ok: true; data: unknown; blocked: boolean } | { ok: false; err: ToolFailure }> {
  try {
    const res = await executeTool({ toolName, orgId: ORG, actor, params, threadId: THREAD, origin })
    return { ok: true, data: res.data, blocked: !!res.blocked }
  } catch (err) {
    return { ok: false, err: err as ToolFailure }
  }
}

async function counts(): Promise<{ approvals: number; documents: number }> {
  const [a] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
  const [d] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM app_invoicing.documents WHERE org_id = ${ORG}`
  return { approvals: a?.n ?? 0, documents: d?.n ?? 0 }
}

/** The site refused with the gate's envelope and left no approval and no new document. */
async function expectGateRefusal(
  call: Promise<Awaited<ReturnType<typeof callTool>>>,
  before: { approvals: number; documents: number },
  code = "einvoice_data_missing",
): Promise<void> {
  const r = await call
  if (r.ok) throw new Error(`expected a gate refusal, got ${JSON.stringify(r.data)}`)
  expect(r.err.code).toBe(code)
  expect(r.err.status).toBe(422)
  expect(r.err.details?.retryable).toBe(true)
  expect(r.err.body?.gate_mode).toBe("enforce")
  expect(r.err.body?.missing?.[0]?.fix_tool).toBeTruthy()
  expect(r.err.body?.missing?.map((m) => m.field)).toContain("buyer_siren")
  expect(await counts()).toEqual(before)
}

async function seedDocument(fields: {
  type: "quote" | "invoice"
  status: string
  number: string
  shopify_order_id?: string | null
  shopify_draft_order_id?: string | null
}): Promise<string> {
  const id = randomUUID()
  await sql`INSERT INTO app_invoicing.documents
    (id, org_id, type, status, number, number_int, year_of_issue, currency, incoterm, issuer_profile_id,
     counterparty_name, counterparty_address, counterparty_email, counterparty_country,
     customer_kind, operation_category, operation_category_source,
     billing_line1, billing_postcode, billing_city, billing_country_code,
     subtotal_minor, tax_total_minor, grand_total_minor, issued_at, external_refs, lifecycle_log,
     shopify_order_id, shopify_draft_order_id)
    VALUES (${id}, ${ORG}, ${fields.type}, ${fields.status}, ${fields.number},
     ${Number(fields.number.split("-").pop())}, 2026, 'EUR', 'DAP',
     ${issuerProfileId}, ${buyer.legal_name}, ${buyer.address}, ${buyer.email}, 'FR',
     'business', 'goods', 'explicit', ${buyer.billing_line1}, ${buyer.billing_postcode},
     ${buyer.billing_city}, 'FR', 10000, 2000, 12000, '2026-05-28',
     ${JSON.stringify(fields.shopify_draft_order_id ? { shopify_draft_order_id: fields.shopify_draft_order_id } : {})}::jsonb,
     '[]'::jsonb, ${fields.shopify_order_id ?? null}, ${fields.shopify_draft_order_id ?? null})`
  await sql`INSERT INTO app_invoicing.document_lines
    (org_id, document_id, position, description, quantity, unit_price_minor, discount_minor,
     line_kind, tax_rate_bp, subtotal_minor, tax_minor, total_minor)
    VALUES (${ORG}, ${id}, 1, 'Widget', '2', 5000, 0, 'goods', 2000, 10000, 2000, 12000)`
  return id
}

describe("invoicing e-invoicing gate at every manual issue site (real Postgres, enforce)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Einvoice Gate Sites Org', 'einvoice-gate-sites-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'einvoice-gate-sites@test.com', 'hash', 'Gate Sites Tester', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'einvoice-gate-sites-thread', 'agent_chat', ${USER})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${USER}`
    for (const scope of CEO_ROLE_SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }

    await initSandboxPool()
    await initWorkerPool()
    await registerApps([bundledDescriptor("invoicing") as never], ORG)
    // A stand-in for the Shopify app's draft-order tools: counts every completion the
    // invoicing convert path asks for (the Shopify-linked case must never reach it).
    toolRegistry.set([ORG, "shopify", "draft_orders_complete"], {
      appName: "shopify",
      name: "draft_orders_complete",
      description: "counting stand-in",
      // Any scope the caller holds: the stand-in only counts, the real app checks its own.
      requiredScopes: ["invoicing:documents:write"],
      handler: async () => {
        draftOrderComplete += 1
        return { draftOrder: { id: "gid://shopify/DraftOrder/7002" } }
      },
    } as never)
    toolRegistry.set([ORG, "shopify", "draft_orders_get"], {
      appName: "shopify",
      name: "draft_orders_get",
      description: "stand-in",
      // Any scope the caller holds: the stand-in only counts, the real app checks its own.
      requiredScopes: ["invoicing:documents:write"],
      handler: async () => ({ draftOrder: { orderId: null, orderName: null } }),
    } as never)

    // A French, VAT-registered issuer (in scope of the reform), and the org's gate in enforce.
    issuerProfileId = randomUUID()
    await sql`INSERT INTO app_invoicing.issuer_profiles
      (id, org_id, legal_name, country, vat_id, address, default_currency, default_language)
      VALUES (${issuerProfileId}, ${ORG}, 'Gate Sites Issuer SAS', 'FR', 'FR68900000001',
              '1 rue Test, 75001 Paris', 'EUR', 'fr')`
    await sql`INSERT INTO app_invoicing.einvoicing_settings (org_id, gate_mode, gate_mode_source)
      VALUES (${ORG}, 'enforce', 'config')`
  }, 60_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    toolRegistry.delete([ORG, "shopify", "draft_orders_complete"])
    toolRegistry.delete([ORG, "shopify", "draft_orders_get"])
    resetAppRegistries()
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.document_lines WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
    await releaseTestLock()
  }, 60_000)

  it("invoice_issue", async () => {
    const created = await callTool("invoicing:drafts_create", {
      type: "invoice",
      counterparty_contact_id: null,
      counterparty_name: buyer.legal_name,
      counterparty_address: buyer.address,
      counterparty_email: buyer.email,
      counterparty_country: "FR",
      customer_kind: "business",
      operation_category: "goods",
      billing_line1: buyer.billing_line1,
      billing_postcode: buyer.billing_postcode,
      billing_city: buyer.billing_city,
      issuer_profile_id: issuerProfileId,
      currency: "EUR",
      items,
    })
    if (!created.ok) throw new Error(`drafts_create failed: ${JSON.stringify(created.err)}`)
    const draftId = (created.data as { draft_id: string }).draft_id
    const before = await counts()
    await expectGateRefusal(callTool("invoicing:invoice_issue", { draft_id: draftId }), before)
  })

  it("invoice_create_and_issue", async () => {
    const before = await counts()
    await expectGateRefusal(
      callTool("invoicing:invoice_create_and_issue", {
        counterparty: buyer,
        issuer_profile_id: issuerProfileId,
        currency: "EUR",
        operation_category: "goods",
        items,
      }),
      before,
    )
  })

  it("credit_note_create_and_issue", async () => {
    const before = await counts()
    await expectGateRefusal(
      callTool("invoicing:credit_note_create_and_issue", {
        counterparty: buyer,
        issuer_profile_id: issuerProfileId,
        currency: "EUR",
        operation_category: "goods",
        items: [{ description: "Widget", quantity: "1", unit_price_minor: -5000 }],
      }),
      before,
    )
  })

  it("credit_note_issue", async () => {
    const created = await callTool("invoicing:drafts_create", {
      type: "credit_note",
      counterparty_contact_id: null,
      counterparty_name: buyer.legal_name,
      counterparty_address: buyer.address,
      counterparty_email: buyer.email,
      counterparty_country: "FR",
      customer_kind: "business",
      operation_category: "goods",
      billing_line1: buyer.billing_line1,
      billing_postcode: buyer.billing_postcode,
      billing_city: buyer.billing_city,
      issuer_profile_id: issuerProfileId,
      currency: "EUR",
      items: [{ description: "Widget", quantity: "1", unit_price_minor: -5000 }],
    })
    if (!created.ok) throw new Error(`drafts_create failed: ${JSON.stringify(created.err)}`)
    const draftId = (created.data as { draft_id: string }).draft_id
    const before = await counts()
    await expectGateRefusal(callTool("invoicing:credit_note_issue", { draft_id: draftId }), before)
  })

  it("documents_convert_to_invoice (local quote)", async () => {
    const quoteId = await seedDocument({
      type: "quote",
      status: "accepted",
      number: "QUO-2026-7001",
    })
    const before = await counts()
    await expectGateRefusal(
      callTool("invoicing:documents_convert_to_invoice", { source_document_id: quoteId }),
      before,
    )
    const [quote] = await sql<Array<{ status: string }>>`
      SELECT status FROM app_invoicing.documents WHERE id = ${quoteId}`
    expect(quote?.status).toBe("accepted")
  })

  it("documents_convert_to_invoice (Shopify-linked quote, human click): refused before the draft order is completed", async () => {
    const quoteId = await seedDocument({
      type: "quote",
      status: "sent",
      number: "QUO-2026-7002",
      shopify_draft_order_id: "gid://shopify/DraftOrder/7002",
    })
    const before = await counts()
    await expectGateRefusal(
      callTool(
        "invoicing:documents_convert_to_invoice",
        { source_document_id: quoteId },
        "human-ui",
      ),
      before,
    )
    // Shopify was never asked to complete the draft order, and the quote never moved.
    expect(draftOrderComplete).toBe(0)
    const [quote] = await sql<Array<{ status: string; lifecycle_log: Array<{ event: string }> }>>`
      SELECT status, lifecycle_log FROM app_invoicing.documents WHERE id = ${quoteId}`
    expect(quote?.status).toBe("sent")
    expect((quote?.lifecycle_log ?? []).some((e) => e.event === "draft_order_completed")).toBe(
      false,
    )
  })

  it("a quote issued with a caller-asserted SIREN confirmation records none; its convert is refused registry_unconfirmed", async () => {
    const quote = await callTool(
      "invoicing:quote_create_and_issue",
      {
        counterparty: { ...buyer, siren: "902000009", siren_confirmed_via: "auto" },
        issuer_profile_id: issuerProfileId,
        currency: "EUR",
        items,
      },
      "human-ui",
    )
    if (!quote.ok) throw new Error(`quote_create_and_issue failed: ${JSON.stringify(quote.err)}`)
    const quoteId = (quote.data as { document_id: string }).document_id
    const [row] = await sql<
      Array<{ buyer_siren: string | null; buyer_siren_confirmed_via: string | null }>
    >`
      SELECT buyer_siren, buyer_siren_confirmed_via FROM app_invoicing.documents WHERE id = ${quoteId}`
    expect(row?.buyer_siren).toBe("902000009")
    expect(row?.buyer_siren_confirmed_via).toBeNull()
    const before = await counts()
    const r = await callTool("invoicing:documents_convert_to_invoice", {
      source_document_id: quoteId,
      operation_category: "goods",
    })
    if (r.ok) throw new Error(`expected a gate refusal, got ${JSON.stringify(r.data)}`)
    expect(r.err.code).toBe("registry_unconfirmed")
    expect(r.err.status).toBe(422)
    expect(r.err.details?.retryable).toBe(true)
    expect(await counts()).toEqual(before)
  })

  it("order_reissue_apply", async () => {
    // An invoice issued before regimes were recorded (no regime): its credit note is classified
    // from the current data, which lacks the SIREN.
    const originalId = await seedDocument({
      type: "invoice",
      status: "issued",
      number: "INV-2026-7003",
      shopify_order_id: "gate-sites-order-1",
    })
    const before = await counts()
    await expectGateRefusal(
      callTool("invoicing:order_reissue_apply", {
        original_document_id: originalId,
        shopify_order_id: "gate-sites-order-1",
        billing_signature: "sig-1",
        dedupe_key: "gate-sites-order-1:sig-1",
        items: [{ description: "Widget", quantity: "3", unit_price_minor: 5000 }],
      }),
      before,
    )
  })

  it("warn: an org with documents issued before regimes existed issues and records the warning", async () => {
    // No settings row: the mode materialises from the org's history as `warn`. The case seeds
    // its own invoice issued before regimes existed, so it never depends on test order.
    await seedDocument({ type: "invoice", status: "issued", number: "INV-2026-7090" })
    await sql`DELETE FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
    const r = await callTool(
      "invoicing:invoice_create_and_issue",
      {
        counterparty: buyer,
        issuer_profile_id: issuerProfileId,
        currency: "EUR",
        operation_category: "goods",
        items,
      },
      "human-ui",
    )
    if (!r.ok) throw new Error(`warn-mode issue failed: ${JSON.stringify(r.err)}`)
    const data = r.data as { document_id: string; einvoicing_warning?: { code: string } }
    expect(data.einvoicing_warning?.code).toBe("einvoice_data_missing")
    const [doc] = await sql<
      Array<{
        regime: string
        regime_reasons: Array<{ code: string }>
        lifecycle_log: Array<{ event: string }>
      }>
    >`SELECT regime, regime_reasons, lifecycle_log FROM app_invoicing.documents WHERE id = ${data.document_id}`
    expect((doc?.regime_reasons ?? []).map((x) => x.code)).toContain("gate_warning")
    expect((doc?.lifecycle_log ?? []).some((e) => e.event === "einvoice_gate_warning")).toBe(true)
    const [settings] = await sql<Array<{ gate_mode: string; gate_mode_source: string }>>`
      SELECT gate_mode, gate_mode_source FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
    expect(settings).toEqual({ gate_mode: "warn", gate_mode_source: "upgrade_default" })
  })

  it("a foreign-currency issue by the issuer role snapshots the cached ECB rate", async () => {
    // Today's rate is already cached, so the preflight warm-up makes no network call.
    const today = new Date().toISOString().slice(0, 10)
    await sql`INSERT INTO app_invoicing.fx_rates (org_id, currency, rate_date, rate, fetched_at)
      VALUES (${ORG}, 'USD', ${today}, '1.1225', now())
      ON CONFLICT DO NOTHING`
    const r = await callTool(
      "invoicing:invoice_create_and_issue",
      {
        counterparty: buyer,
        issuer_profile_id: issuerProfileId,
        currency: "USD",
        operation_category: "goods",
        items,
      },
      "human-ui",
    )
    if (!r.ok) throw new Error(`foreign-currency issue failed: ${JSON.stringify(r.err)}`)
    const data = r.data as { document_id: string }
    const [doc] = await sql<
      Array<{
        fx_rate: string | null
        fx_rate_date: string | null
        fx_source: string | null
        tax_total_eur_minor: string | null
      }>
    >`SELECT fx_rate, fx_rate_date, fx_source, tax_total_eur_minor::text AS tax_total_eur_minor
      FROM app_invoicing.documents WHERE id = ${data.document_id}`
    expect(doc?.fx_rate).toBe("1.1225")
    expect(doc?.fx_rate_date).toBe(today)
    expect(doc?.fx_source).toBe("ECB")
    expect(doc?.tax_total_eur_minor).not.toBeNull()
  })
})
