// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task D7 — Issuance helper tests.
//
// Exercises the composition of D2 (tax), D3 (numbering), D5 (money), D6
// (PDF render via ctx.pdf), and K1 (thread post via ctx.messages) at the
// in-app boundary. Tests run against the shared `createMockDb` generic-CRUD
// surface (matches the sandbox bridge); production code uses the same
// `findMany / findOne / insert / update` calls in tests as it does in
// real runtime.

import { describe, expect, test } from "bun:test"
import { FxRateUnavailableError } from "./einvoicing/fx"
import { EinvoiceGateRefusal } from "./einvoicing/gate"
import { FICTIONAL_SIRENS, FR_SELLER_IDENTITY } from "./einvoicing/test-fixtures"
import { type IssueCtx, type IssueInput, issueDocument } from "./issue"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"

// ── In-memory ctx scaffold ──────────────────────────────────────────────

interface OverlaySeed {
  source: string
  external_id: string
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
}

function makeCtx(opts?: {
  overlay?: OverlaySeed[]
  failRenderTimes?: number
  failThreadPost?: boolean
  /**
   * When set, ctx.executeTool resolves `shopify:variants_get` from this map
   * (keyed by variant gid), simulating the live issue-time customs fetch.
   */
  variantCustoms?: Record<
    string,
    { hs_code: string | null; country_of_origin: string | null; customs_description: string | null }
  >
}): {
  ctx: IssueCtx
  db: MockDb
  state: {
    threadPosts: Array<{
      contact_id: string
      body: string
      attachment_file_ids: string[]
    }>
    renderCalls: Array<{ template_kind: string; data: unknown }>
    emittedAttention: Array<{ entity: string; action: string; entityId?: string; data?: unknown }>
  }
} {
  const db = createMockDb({
    seed: {
      ...(opts?.overlay
        ? { product_customs_overlay: opts.overlay as unknown as Array<Record<string, unknown>> }
        : {}),
      // E-invoicing gate in enforce mode; the French business buyer has a confirmed identity.
      einvoicing_settings: [{ gate_mode: "enforce", gate_mode_source: "config" }],
      counterparty_identities: [
        {
          contact_id: "contact-fr-1",
          customer_kind: "business",
          siren: FICTIONAL_SIRENS[0],
          registry_name: "Acme France SAS",
          registry_status: "A",
          source: "registry",
          confirmed_via: "auto",
        },
      ],
    },
  })
  const state = {
    threadPosts: [] as Array<{
      contact_id: string
      body: string
      attachment_file_ids: string[]
    }>,
    renderCalls: [] as Array<{ template_kind: string; data: unknown }>,
    emittedAttention: [] as Array<{
      entity: string
      action: string
      entityId?: string
      data?: unknown
    }>,
  }
  let failRenderRemaining = opts?.failRenderTimes ?? 0
  const failThreadPost = !!opts?.failThreadPost

  const ctx: IssueCtx = {
    getUserId: async () => "user-1",
    db,
    time: testTime(),
    pdf: {
      async render(p) {
        state.renderCalls.push(p)
        if (failRenderRemaining > 0) {
          failRenderRemaining -= 1
          throw Object.assign(new Error("render boom"), { code: "render_failed" })
        }
        return {
          file_id: `file-${state.renderCalls.length}`,
          byte_size: 1024,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: {
      async post(p) {
        if (failThreadPost) {
          throw Object.assign(new Error("thread boom"), {
            code: "thread_post_failed",
          })
        }
        state.threadPosts.push(p)
        return { message_id: `msg-${state.threadPosts.length}` }
      },
    },
    emit: async (event) => {
      state.emittedAttention.push({
        entity: event.entity,
        action: event.action,
        entityId: event.entityId,
        data: event.data,
      })
    },
    ...(opts?.variantCustoms
      ? {
          executeTool: async (target: string, args: string | Record<string, unknown>) => {
            if (target !== "shopify:variants_get") {
              return { status: "error" as const, error: { code: "unknown_tool", message: target } }
            }
            const parsed = (typeof args === "string" ? JSON.parse(args) : args) as { id?: unknown }
            const id = String(parsed.id ?? "")
            const c = opts.variantCustoms?.[id]
            return { status: "completed" as const, result: { id, attributes: { ...(c ?? {}) } } }
          },
        }
      : {}),
  }
  return { ctx, db, state }
}

// ── Fixtures ────────────────────────────────────────────────────────────

const issuerFR = {
  id: "issuer-1",
  legal_name: "Société Générale Test SARL",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue de Test, 75001 Paris",
  iban: "FR7630006000011234567890189",
  swift_bic: "BNPAFRPP",
  bank_name: "BNP Test",
  default_language: "en" as const,
  prefix_invoice: "INV-{YYYY}-",
  prefix_quote: "QUO-{YYYY}-",
  prefix_proforma: "PRO-{YYYY}-",
  prefix_po: "PO-{YYYY}-",
  // The seller identity a French e-invoice (Factur-X) needs.
  ...FR_SELLER_IDENTITY,
}

const counterpartyDE = {
  contact_id: "contact-1",
  legal_name: "Müller Handel GmbH",
  country: "DE",
  vat_id: "DE123456789",
  address: "Hauptstrasse 5, 10115 Berlin",
  email: "buchhaltung@muellerhandel.example",
}

// FR→FR B2B is domestic 20% — used by tests that need a non-zero tax rate.
const counterpartyFR = {
  contact_id: "contact-fr-1",
  legal_name: "Acme France SAS",
  country: "FR",
  vat_id: "FR55555555555",
  address: "10 rue Domestic, 75001 Paris",
  email: "compta@acmefrance.example",
  customer_kind: "business" as const,
  billing_line1: "10 rue Domestic",
  billing_postcode: "75001",
  billing_city: "Paris",
}

function baseDraft(): IssueInput["draft"] {
  return {
    currency: "EUR",
    incoterm: "DAP",
    year_of_issue: 2026,
    issued_at: "2026-05-15",
    due_at: "2026-06-14",
    external_refs: {},
    lines: [
      {
        position: 1,
        description: "Widget A",
        quantity: "1",
        unit_price_minor: 10000n,
        product_source: null,
        external_id: null,
      },
    ],
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("issueDocument (D7)", () => {
  test("happy path — inserts document, allocates number, renders PDF, posts thread", async () => {
    const { ctx, db, state } = makeCtx()
    const result = await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: baseDraft(),
    })
    expect(result.number).toBe("INV-2026-0001")
    expect(result.pdf_file_id).toBe("file-1")
    const docs = db.__all("documents")
    const lines = db.__all("document_lines")
    expect(docs).toHaveLength(1)
    expect(lines).toHaveLength(1)
    expect(state.threadPosts).toHaveLength(1)
    expect(state.renderCalls).toHaveLength(1)
    const doc = docs[0]!
    expect(doc.pdf_status).toBe("ready")
    expect(doc.subtotal_minor).toBe("10000")
    expect(doc.tax_total_minor).toBe("2000") // FR domestic 20%
    expect(doc.grand_total_minor).toBe("12000")
  })

  test("Shopify order number — mirrored onto the indexed column AND passed to the PDF template", async () => {
    // red: drop the shopify_order_number mirror in issueDocument -> the column stays
    // null, so documents_search can no longer match the order name and the PDF
    // header prints no Order line.
    const { ctx, db, state } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: {
        ...baseDraft(),
        external_refs: {
          shopify_order_id: "12768069779622",
          shopify_order_number: "#1149",
        },
      },
    })
    const doc = db.__all("documents")[0]!
    expect(doc.shopify_order_id).toBe("12768069779622")
    expect(doc.shopify_order_number).toBe("#1149")
    const rendered = state.renderCalls[0] as { data: { document: Record<string, unknown> } }
    expect(rendered.data.document.shopify_order_number).toBe("#1149")
  })

  test("Shopify order number — a manual invoice mirrors null, never an empty string", async () => {
    // An empty column would match a bare free-text search and render an "Order:"
    // label with nothing after it.
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: { ...baseDraft(), external_refs: { shopify_order_number: "  " } },
    })
    expect(db.__all("documents")[0]!.shopify_order_number).toBeNull()
  })

  test("PO number — mirrored onto the indexed column AND passed to the PDF template", async () => {
    // red: drop the po_number mirror in issueDocument -> the column stays null, so
    // documents_search can no longer match the PO number and the PDF header prints
    // no PO number line.
    const { ctx, db, state } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: { ...baseDraft(), external_refs: { po_number: "PO-4471" } },
    })
    const doc = db.__all("documents")[0]!
    expect(doc.po_number).toBe("PO-4471")
    const rendered = state.renderCalls[0] as { data: { document: Record<string, unknown> } }
    expect(rendered.data.document.po_number).toBe("PO-4471")
  })

  // red: drop `notes: draft.notes ?? null` from the documentInsert (or the render-data
  // `notes`) -> the free text an operator typed is either lost at issue or never reaches
  // the PDF face the customer reads.
  test("notes — persisted on the document row AND passed to the PDF template", async () => {
    const { ctx, db, state } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: { ...baseDraft(), notes: "Contract FR-2026-118\nDelivery in 2 batches" },
    })
    const doc = db.__all("documents")[0]!
    expect(doc.notes).toBe("Contract FR-2026-118\nDelivery in 2 batches")
    const rendered = state.renderCalls[0] as { data: { document: Record<string, unknown> } }
    expect(rendered.data.document.notes).toBe("Contract FR-2026-118\nDelivery in 2 batches")
  })

  test("notes — a document without notes stores null, and renders null (never undefined)", async () => {
    const { ctx, db, state } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: baseDraft(),
    })
    expect(db.__all("documents")[0]!.notes).toBeNull()
    const rendered = state.renderCalls[0] as { data: { document: Record<string, unknown> } }
    expect(rendered.data.document.notes).toBeNull()
  })

  test("PO number — a manual invoice mirrors null, never an empty string", async () => {
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: { ...baseDraft(), external_refs: { po_number: "   " } },
    })
    expect(db.__all("documents")[0]!.po_number).toBeNull()
  })

  // red: drop the po_number_changed lifecycle_log append at issue time -> a
  // customer dispute months later has no record of when/how the PO number
  // was first attached to the invoice.
  test("PO number — set at issue is audited in lifecycle_log as po_number_changed", async () => {
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: { ...baseDraft(), external_refs: { po_number: "PO-4471" } },
      po_number_source: "person",
    })
    const doc = db.__all("documents")[0]!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    const entry = log.find((e) => e.event === "po_number_changed")
    expect(entry).toBeDefined()
    expect(entry?.from).toBeNull()
    expect(entry?.to).toBe("PO-4471")
    expect(entry?.source).toBe("person")
  })

  test("PO number — the Shopify order-paid flow logs source shopify_sync, not person", async () => {
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: { ...baseDraft(), external_refs: { po_number: "PO-9911" } },
      po_number_source: "shopify_sync",
    })
    const doc = db.__all("documents")[0]!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    const entry = log.find((e) => e.event === "po_number_changed")
    expect(entry?.source).toBe("shopify_sync")
  })

  test("PO number — no audit entry when the document carries none", async () => {
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: baseDraft(),
    })
    const doc = db.__all("documents")[0]!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.find((e) => e.event === "po_number_changed")).toBeUndefined()
  })

  test("create-and-issue items WITHOUT `position` get sequential positions (NOT-NULL document_lines.position)", async () => {
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "proforma",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: {
        ...baseDraft(),
        // Agent create-and-issue items carry no `position` (only DB-loaded draft lines do).
        lines: [
          {
            description: "Kestrel 6 demo unit",
            quantity: "6",
            unit_price_minor: 120000n,
            product_source: null,
            external_id: null,
          },
          {
            description: "Travel case",
            quantity: "1",
            unit_price_minor: 12900n,
            product_source: null,
            external_id: null,
          },
        ],
      },
    })
    const lines = db.__all("document_lines") as Array<Record<string, unknown>>
    expect(lines).toHaveLength(2)
    // Pre-fix: position was undefined → NULL INSERT → 23502 NOT-NULL violation aborted the whole
    // gated issuance (422). Each line must now carry a non-null, sequential position.
    expect(lines.every((l) => typeof l.position === "number")).toBe(true)
    expect(lines.map((l) => l.position).sort((a, b) => (a as number) - (b as number))).toEqual([
      0, 1,
    ])
  })

  test("export Shopify line (HS codes required), empty overlay — fetches customs live at issue time and caches it", async () => {
    const variantId = "gid://shopify/ProductVariant/8001"
    const { ctx, db } = makeCtx({
      variantCustoms: {
        [variantId]: {
          hs_code: "6109.10",
          country_of_origin: "FR",
          customs_description: "Cotton t-shirt",
        },
      },
    })
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      // FR → US = eu_export_non_eu (requires_hs_code: true) — the ONLY case the
      // issue-time live customs fetch runs. Intra-EU / domestic invoices skip it
      // (HS codes are not legally required, and a custom/deleted variant would
      // otherwise fail the fetch needlessly).
      counterparty: { ...counterpartyDE, country: "US", vat_id: null },
      draft: {
        ...baseDraft(),
        lines: [
          {
            position: 1,
            description: "Tee",
            quantity: "1",
            unit_price_minor: 10000n,
            product_source: "shopify",
            external_id: variantId,
          },
        ],
      },
    })
    const line = (db.__all("document_lines") as Array<Record<string, unknown>>)[0]!
    expect(line.hs_code).toBe("6109.10")
    expect(line.country_of_origin).toBe("FR")
    expect(line.customs_description).toBe("Cotton t-shirt")
    // Cached into the overlay so the next issuance reads from the overlay.
    const overlay = (db.__all("product_customs_overlay") as Array<Record<string, unknown>>).find(
      (r) => r.external_id === variantId,
    )
    expect(overlay).toBeDefined()
    expect(overlay?.hs_code).toBe("6109.10")
  })

  test("intra-EU Shopify line, empty overlay + executeTool present — customs fetch SKIPPED (HS codes not required)", async () => {
    // C3 regression: the issue-time live customs fetch must only run for invoices
    // that LEGALLY require HS codes (extra-EU export). For an intra-EU (FR→DE) or
    // domestic invoice it is skipped — even though executeTool + variant customs are
    // available — so a custom line / since-deleted variant can never fail the fetch
    // or spam errors. The customs columns stay blank (no fetch attempted).
    const variantId = "gid://shopify/ProductVariant/8001"
    const { ctx, db } = makeCtx({
      variantCustoms: {
        [variantId]: { hs_code: "6109.10", country_of_origin: "FR", customs_description: "Tee" },
      },
    })
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyDE, // FR→DE = intra-EU, requires_hs_code: false
      draft: {
        ...baseDraft(),
        lines: [
          {
            position: 1,
            description: "Tee",
            quantity: "1",
            unit_price_minor: 10000n,
            product_source: "shopify",
            external_id: variantId,
          },
        ],
      },
    })
    const line = (db.__all("document_lines") as Array<Record<string, unknown>>)[0]!
    expect(line.hs_code).toBeNull()
    // Nothing cached either — the fetch never ran.
    expect(db.__all("product_customs_overlay")).toHaveLength(0)
  })

  test("Shopify line, no overlay AND no executeTool — customs stay blank (overlay-only behavior)", async () => {
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyDE,
      draft: {
        ...baseDraft(),
        lines: [
          {
            position: 1,
            description: "Tee",
            quantity: "1",
            unit_price_minor: 10000n,
            product_source: "shopify",
            external_id: "gid://shopify/ProductVariant/9999",
          },
        ],
      },
    })
    const line = (db.__all("document_lines") as Array<Record<string, unknown>>)[0]!
    expect(line.hs_code).toBeNull()
  })

  test("existing overlay wins — no live fetch clobber when overlay already has customs", async () => {
    const variantId = "gid://shopify/ProductVariant/7001"
    const { ctx, db } = makeCtx({
      overlay: [
        {
          source: "shopify",
          external_id: variantId,
          hs_code: "1111.11",
          country_of_origin: "DE",
          customs_description: "Pre-synced",
        },
      ],
      variantCustoms: {
        [variantId]: {
          hs_code: "9999.99",
          country_of_origin: "US",
          customs_description: "Live (should be ignored)",
        },
      },
    })
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyDE,
      draft: {
        ...baseDraft(),
        lines: [
          {
            position: 1,
            description: "x",
            quantity: "1",
            unit_price_minor: 10000n,
            product_source: "shopify",
            external_id: variantId,
          },
        ],
      },
    })
    const line = (db.__all("document_lines") as Array<Record<string, unknown>>)[0]!
    expect(line.hs_code).toBe("1111.11") // overlay value, not the live one
  })

  test("PDF render failure — document persists with pdf_status='failed'; retry handle preserved", async () => {
    const { ctx, db } = makeCtx({ failRenderTimes: 1 })
    const result = await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyDE,
      draft: baseDraft(),
    })
    expect(result.pdf_file_id).toBeNull()
    expect(result.number).toBe("INV-2026-0001")
    const doc = db.__all("documents")[0]!
    expect(doc.pdf_status).toBe("failed")
    expect(doc.pdf_file_id).toBeNull()
    // Number persists so re-running render does not re-allocate.
    expect(doc.number).toBe("INV-2026-0001")
    expect(doc.number_int).toBe(1)
    // Lifecycle log records the failure for retry plumbing.
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "issued" }),
        expect.objectContaining({ event: "pdf_render_failed" }),
      ]),
    )
  })

  test("thread post failure — document persists; attention entry emitted; no thread post", async () => {
    const { ctx, db, state } = makeCtx({ failThreadPost: true })
    const result = await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyDE,
      draft: baseDraft(),
    })
    expect(result.number).toBe("INV-2026-0001")
    expect(state.threadPosts).toHaveLength(0)
    const doc = db.__all("documents")[0]!
    expect(doc.pdf_status).toBe("ready")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "issued" }),
        expect.objectContaining({ event: "thread_post_failed" }),
      ]),
    )
  })

  test("3-line per-line tax treatment — standard + reverse-charge + zero-tax", async () => {
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: {
        ...baseDraft(),
        lines: [
          {
            position: 1,
            description: "Standard line",
            quantity: "1",
            unit_price_minor: 10000n,
            product_source: null,
            external_id: null,
          },
          {
            position: 2,
            description: "Reverse-charge line",
            quantity: "1",
            unit_price_minor: 10000n,
            tax_rate_bp_override: 0,
            product_source: null,
            external_id: null,
          },
          {
            position: 3,
            description: "Zero-tax line",
            quantity: "1",
            unit_price_minor: 5000n,
            tax_rate_bp_override: 0,
            product_source: null,
            external_id: null,
          },
        ],
      },
    })
    const lines = (db.__all("document_lines") as Array<Record<string, unknown>>).sort(
      (a, b) => (a.position as number) - (b.position as number),
    )
    expect(lines).toHaveLength(3)
    expect(lines[0]!.tax_rate_bp).toBe(2000)
    expect(lines[0]!.tax_minor).toBe("2000")
    expect(lines[1]!.tax_rate_bp).toBe(0)
    expect(lines[1]!.tax_minor).toBe("0")
    expect(lines[2]!.tax_rate_bp).toBe(0)
    expect(lines[2]!.tax_minor).toBe("0")
  })

  test("money rollup consistency — document totals = SUM(lines) to the minor unit", async () => {
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: {
        ...baseDraft(),
        lines: [
          {
            position: 1,
            description: "L1",
            quantity: "2.5",
            unit_price_minor: 199n,
            product_source: null,
            external_id: null,
          },
          {
            position: 2,
            description: "L2",
            quantity: "1",
            unit_price_minor: 3333n,
            product_source: null,
            external_id: null,
          },
        ],
      },
    })
    const doc = db.__all("documents")[0]!
    const lines = db.__all("document_lines")
    const lineSubSum = lines.reduce((s, l) => s + BigInt(String(l.subtotal_minor)), 0n)
    const lineTaxSum = lines.reduce((s, l) => s + BigInt(String(l.tax_minor)), 0n)
    const lineTotSum = lines.reduce((s, l) => s + BigInt(String(l.total_minor)), 0n)
    expect(BigInt(String(doc.subtotal_minor))).toBe(lineSubSum)
    expect(BigInt(String(doc.tax_total_minor))).toBe(lineTaxSum)
    expect(BigInt(String(doc.grand_total_minor))).toBe(lineTotSum)
  })

  test("customs snapshot — line hs_code/country_of_origin frozen at issue time", async () => {
    const overlay: OverlaySeed[] = [
      {
        source: "shopify",
        external_id: "p-1",
        hs_code: "8471.30",
        country_of_origin: "FR",
        customs_description: "Original",
      },
    ]
    const { ctx, db } = makeCtx({ overlay })
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyDE,
      draft: {
        ...baseDraft(),
        lines: [
          {
            position: 1,
            description: "Widget",
            quantity: "1",
            unit_price_minor: 10000n,
            product_source: "shopify",
            external_id: "p-1",
          },
        ],
      },
    })
    // Now edit the overlay row — line snapshot must NOT change.
    const overlayRows = db.__all("product_customs_overlay")
    const id = String(overlayRows[0]!.id)
    await db.update("product_customs_overlay", id, {
      hs_code: "9999.99",
      country_of_origin: "US",
      customs_description: "Edited",
    })
    const line = db.__all("document_lines")[0]!
    expect(line.hs_code).toBe("8471.30")
    expect(line.country_of_origin).toBe("FR")
    expect(line.customs_description).toBe("Original")
  })

  test("lifecycle log appended with issued event including actor + ts", async () => {
    const { ctx, db } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyDE,
      draft: baseDraft(),
    })
    const log = db.__all("documents")[0]!.lifecycle_log as Array<Record<string, unknown>>
    const issued = log.find((e) => e.event === "issued") as
      | { event: string; actor: string; ts: string }
      | undefined
    expect(issued).toBeDefined()
    expect(issued?.actor).toBe("user-1")
    expect(issued?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  // red: drop the ctx.emit call in issueDocument's document:issued block -> a fresh
  // invoice, credit note or PO never reaches kernel.audit_log, so no human can see it
  // was issued without opening the document itself.
  test("emits document:issued with type, number, status, currency and grand_total_minor", async () => {
    const { ctx, state } = makeCtx()
    const result = await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: baseDraft(),
    })
    const evt = state.emittedAttention.find((e) => e.action === "issued")
    expect(evt).toBeDefined()
    expect(evt?.entity).toBe("document")
    expect(evt?.entityId).toBe(result.document_id)
    expect(evt?.data).toMatchObject({
      document_id: result.document_id,
      type: "invoice",
      number: "INV-2026-0001",
      status: "issued",
      currency: "EUR",
      grand_total_minor: "12000",
    })
  })

  // red: drop the settlement branch's ctx.emit call -> a Shopify order-paid invoice is born
  // already settled but the audit trail never shows the marked_paid moment, only the issuance.
  test("emits document:paid for a born-settled issuance, with paid_at and payment_status", async () => {
    const { ctx, state } = makeCtx()
    const result = await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: baseDraft(),
      settlement: { paid_at: "2026-05-15T10:00:00.000Z", source: "shopify" },
    })
    const evt = state.emittedAttention.find((e) => e.action === "paid")
    expect(evt).toBeDefined()
    expect(evt?.entity).toBe("document")
    expect(evt?.entityId).toBe(result.document_id)
    expect(evt?.data).toMatchObject({
      document_id: result.document_id,
      type: "invoice",
      number: "INV-2026-0001",
      status: "issued",
      currency: "EUR",
      grand_total_minor: "12000",
      paid_at: "2026-05-15T10:00:00.000Z",
      payment_status: "paid",
    })
  })

  test("no document:paid event when the document is issued unsettled", async () => {
    const { ctx, state } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: baseDraft(),
    })
    expect(state.emittedAttention.find((e) => e.action === "paid")).toBeUndefined()
  })

  // red: drop the issue-time po_number_changed ctx.emit call -> a document issued WITH a PO
  // number already set shows no audit trail for how that number got there.
  test("emits document:po_number_changed (from null) when a document is issued with a PO number", async () => {
    const { ctx, state } = makeCtx()
    const result = await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: { ...baseDraft(), external_refs: { po_number: "PO-4471" } },
    })
    const evt = state.emittedAttention.find((e) => e.action === "po_number_changed")
    expect(evt).toBeDefined()
    expect(evt?.entity).toBe("document")
    expect(evt?.entityId).toBe(result.document_id)
    expect(evt?.data).toMatchObject({
      document_id: result.document_id,
      type: "invoice",
      number: "INV-2026-0001",
      status: "issued",
      from: null,
      to: "PO-4471",
    })
  })

  test("no document:po_number_changed event when a document is issued without a PO number", async () => {
    const { ctx, state } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: baseDraft(),
    })
    expect(state.emittedAttention.find((e) => e.action === "po_number_changed")).toBeUndefined()
  })
})

// ── Ship to snapshot (buildTemplateData + persistence) ─────────────────────
//
// An invoice must show BOTH addresses when they differ (requested by Priya). The ship to is
// persisted as its own snapshot and handed to the template; it is NEVER a tax input.
describe("issueDocument ship to snapshot", () => {
  const counterpartyWithShipTo = {
    ...counterpartyFR,
    shipping_address: "Am Hafen 12\n21079 Hamburg\nDE",
    shipping_name: "Spedition Nord KG",
  }

  test("persists the ship to columns and emits them in the template data", async () => {
    const { ctx, db, state } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyWithShipTo,
      draft: baseDraft(),
    })
    const doc = db.__all("documents")[0]!
    expect(doc.counterparty_address).toBe("10 rue Domestic, 75001 Paris")
    expect(doc.counterparty_shipping_address).toBe("Am Hafen 12\n21079 Hamburg\nDE")
    expect(doc.counterparty_shipping_name).toBe("Spedition Nord KG")
    const rendered = state.renderCalls[0] as {
      data: { counterparty: Record<string, unknown> }
    }
    expect(rendered.data.counterparty.address).toBe("10 rue Domestic, 75001 Paris")
    expect(rendered.data.counterparty.shipping_address).toBe("Am Hafen 12\n21079 Hamburg\nDE")
    expect(rendered.data.counterparty.shipping_name).toBe("Spedition Nord KG")
  })

  test("a counterparty with no ship to persists nulls, never a copy of the billing address", async () => {
    const { ctx, db, state } = makeCtx()
    await issueDocument(ctx, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: baseDraft(),
    })
    const doc = db.__all("documents")[0]!
    expect(doc.counterparty_shipping_address).toBeNull()
    expect(doc.counterparty_shipping_name).toBeNull()
    const rendered = state.renderCalls[0] as {
      data: { counterparty: Record<string, unknown> }
    }
    expect(rendered.data.counterparty.shipping_address).toBeNull()
  })

  // HARD CONSTRAINT. classify() keys off counterparty_country. A US ship to on an FR->FR
  // domestic invoice must leave the treatment, the rate and the total exactly where they were.
  test("a ship to in another country does not touch the VAT classification", async () => {
    const { ctx: ctxA, db: dbA } = makeCtx()
    await issueDocument(ctxA, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: counterpartyFR,
      draft: baseDraft(),
    })
    const { ctx: ctxB, db: dbB } = makeCtx()
    await issueDocument(ctxB, {
      type: "invoice",
      operation_category: "goods",
      issuer: issuerFR,
      counterparty: {
        ...counterpartyFR,
        shipping_address: "1 Export Road\nNew York\nUS",
        shipping_name: "US Forwarder Inc",
      },
      draft: baseDraft(),
    })
    const plain = dbA.__all("documents")[0]!
    const shipped = dbB.__all("documents")[0]!
    expect(shipped.tax_treatment).toBe(plain.tax_treatment)
    expect(shipped.counterparty_country).toBe(plain.counterparty_country)
    expect(String(shipped.tax_total_minor)).toBe(String(plain.tax_total_minor))
    expect(String(shipped.grand_total_minor)).toBe(String(plain.grand_total_minor))
  })
})

// The backstop: a path that skipped its handler-level check still cannot issue a French business
// e-invoice without the buyer's SIREN. Thrown before numbering, so no number is consumed.
describe("issueDocument e-invoicing backstop (enforce)", () => {
  test("throws EinvoiceGateRefusal for a French business buyer without a SIREN and allocates no number", async () => {
    const { ctx, db, state } = makeCtx()
    let caught: unknown
    try {
      await issueDocument(ctx, {
        type: "invoice",
        operation_category: "goods",
        issuer: issuerFR,
        counterparty: { ...counterpartyFR, contact_id: "contact-without-identity", vat_id: null },
        draft: baseDraft(),
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EinvoiceGateRefusal)
    expect((caught as EinvoiceGateRefusal).result.code).toBe("einvoice_data_missing")
    expect(db.__sequences.size).toBe(0)
    expect(db.__all("documents")).toHaveLength(0)
  })

  describe("foreign-currency snapshot", () => {
    test("issue snapshots fx when cached", async () => {
      const { ctx, db } = makeCtx()
      await db.insert("fx_rates", {
        currency: "USD",
        rate_date: "2026-05-14",
        rate: "1.1225",
        fetched_at: new Date("2026-05-14T15:00:00Z"),
      })
      await issueDocument(ctx, {
        type: "invoice",
        operation_category: "goods",
        issuer: issuerFR,
        counterparty: counterpartyFR,
        draft: { ...baseDraft(), currency: "USD" },
      })
      const doc = db.__all("documents")[0]!
      expect(doc.tax_total_minor).toBe("2000")
      expect(doc.fx_rate).toBe("1.1225")
      expect(doc.fx_rate_date).toBe("2026-05-14")
      expect(doc.fx_source).toBe("ECB")
      expect(String(doc.tax_total_eur_minor)).toBe("1782") // 20.00 USD / 1.1225 = 17.82 EUR
    })

    test("a foreign-currency e-invoice with no cached rate is refused before numbering, retryable", async () => {
      const { ctx, db, state } = makeCtx()
      let caught: unknown
      try {
        await issueDocument(ctx, {
          type: "invoice",
          operation_category: "goods",
          issuer: issuerFR,
          counterparty: counterpartyFR,
          draft: { ...baseDraft(), currency: "USD" },
        })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(FxRateUnavailableError)
      expect((caught as FxRateUnavailableError).code).toBe("fx_rate_unavailable")
      expect((caught as FxRateUnavailableError).retryable).toBe(true)
      expect(db.__sequences.size).toBe(0)
      expect(db.__all("documents")).toHaveLength(0)
    })

    test("a foreign-currency document outside the e-invoicing regime issues without a rate", async () => {
      const { ctx, db } = makeCtx()
      const result = await issueDocument(ctx, {
        type: "invoice",
        operation_category: "goods",
        issuer: issuerFR,
        counterparty: counterpartyDE,
        draft: { ...baseDraft(), currency: "USD" },
      })
      expect(result.number).toBe("INV-2026-0001")
      const doc = db.__all("documents")[0]!
      const regime = (doc.einvoice as { regime?: string } | undefined)?.regime ?? doc.regime
      expect(regime).toBeDefined()
      expect(regime).not.toBe("e_invoice")
      expect(doc.fx_rate ?? null).toBeNull()
      expect(doc.tax_total_eur_minor ?? null).toBeNull()
    })

    test("a EUR document carries no rate", async () => {
      const { ctx, db } = makeCtx()
      await issueDocument(ctx, {
        type: "invoice",
        operation_category: "goods",
        issuer: issuerFR,
        counterparty: counterpartyFR,
        draft: baseDraft(),
      })
      expect(db.__all("documents")[0]!.fx_rate ?? null).toBeNull()
    })
  })
})

// ── No transaction across the run: what one issuing commit guarantees ────────
describe("issueDocument commits number, document and lines in one batch", () => {
  const input = (): IssueInput => ({
    type: "invoice",
    operation_category: "goods",
    issuer: issuerFR,
    counterparty: counterpartyFR,
    draft: baseDraft(),
  })

  test("one batch carries the number, the document, its lines and the caller's writes", async () => {
    const { ctx, db } = makeCtx()
    db.__seed("documents", [
      { id: "00000000-0000-4000-8000-0000000d0a1f", type: "invoice", status: "draft" },
    ])
    const specs: Array<Parameters<MockDb["batch"]>[0]> = []
    const batch = db.batch.bind(db)
    db.batch = async (spec) => {
      specs.push(spec)
      return batch(spec)
    }
    await issueDocument(ctx, {
      ...input(),
      commit_with: [{ delete: "documents", id: "00000000-0000-4000-8000-0000000d0a1f" }],
    })
    expect(specs).toHaveLength(1)
    expect(specs[0]?.sequence?.key).toBe("invoicing:doc_number:issuer-1:invoice:2026")
    expect(specs[0]?.ops.map((o) => Object.keys(o)[0])).toEqual(["insert", "insert", "delete"])
    expect(db.__all("documents").map((d) => d.number)).toEqual(["INV-2026-0001"])
  })

  test("a failing write of the batch persists nothing and consumes no number", async () => {
    const { ctx, db } = makeCtx()
    await expect(
      issueDocument(ctx, {
        ...input(),
        commit_with: [{ update: "documents", id: "missing", data: {} }],
      }),
    ).rejects.toThrow()
    expect(db.__all("documents")).toHaveLength(0)
    expect(db.__all("document_lines")).toHaveLength(0)
    expect((await issueDocument(ctx, input())).number).toBe("INV-2026-0001")
  })

  test("a run killed after the commit leaves the issued document numbered, and no gap", async () => {
    const { ctx, db } = makeCtx()
    // The run dies right after the issuing commit (its first call after it fails for good).
    const dying = { ...ctx, emit: async () => Promise.reject(new Error("process died")) }
    await expect(issueDocument(dying, input())).rejects.toThrow("process died")
    const [doc] = db.__all("documents")
    expect(doc?.number).toBe("INV-2026-0001")
    expect(doc?.pdf_status).toBe("pending")
    expect(db.__all("document_lines")).toHaveLength(1)
    expect((await issueDocument(ctx, input())).number).toBe("INV-2026-0002")
  })

  test("issues started together never share a number and leave none out", async () => {
    const { ctx, db } = makeCtx()
    const results = await Promise.all(Array.from({ length: 8 }, () => issueDocument(ctx, input())))
    expect(results.map((r) => r.number).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `INV-2026-000${i + 1}`),
    )
    expect(new Set(db.__all("documents").map((d) => d.number_int)).size).toBe(8)
  })
})
