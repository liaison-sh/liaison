// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Automatic credit notes (Shopify refund / cancellation) that the e-invoicing gate refuses park
// their OWN arguments, and the deferred-retry sweep re-issues exactly that credit note once the
// buyer's identity is fixed: never the whole refund or cancellation handler (which would see the
// refund already recorded and issue nothing, or re-append the cancellation and re-raise its
// attention item). Real issue pipeline against the in-memory mock db.
import { describe, expect, test } from "bun:test"
import { type DeferredRow, park } from "../deferred"
import { deferredRetryJobHandler } from "../handlers/deferred-dispatch"
import { onShopifyOrderCancelled, type OrderCancelledCtx } from "../handlers/shopify-order-cancelled"
import { onShopifyRefundCreated, type RefundCtx } from "../handlers/shopify-refund-created"
import { creditNoteCreateAndIssue, documentsUpdate, type MutationsCtx } from "../mutations"
import { createMockDb, type MockDb } from "../test-db"
import { raiseIdentityAttention } from "./gate"
import { retryParkedCreditNote } from "./parked-credit-note"
import { FICTIONAL_SIRENS } from "./test-fixtures"

const ISSUER_ROW = {
  id: "iss-1",
  legal_name: "Exemple Emetteur SAS",
  country: "FR",
  vat_id: "FR68900000001",
  address: "1 rue de l'Emetteur, 75001 Paris",
  iban: null,
  swift_bic: null,
  bank_name: null,
  default_language: "fr",
  prefix_invoice: "INV-{YYYY}-",
  prefix_quote: "QUO-{YYYY}-",
  prefix_proforma: "PRO-{YYYY}-",
  prefix_po: "PO-{YYYY}-",
  prefix_credit_note: "CN-{YYYY}-",
  invoice_approval_threshold_minor: null,
  po_approval_threshold_minor: null,
  require_two_eyes: false,
  mail_account_id: null,
}

const ORIGINAL_ID = "00000000-0000-4000-8000-0000000e7001"
const CONTACT = "00000000-0000-4000-8000-0000000c7001"
const ORDER = "ORD-T17"

/** An invoice issued before the e-invoicing regime existed (no stored regime), to a French
 *  company whose identity is not on file yet. Structured billing is on the document. */
function legacyFrInvoice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORIGINAL_ID,
    type: "invoice",
    scope: "goods",
    status: "issued",
    payment_status: "paid",
    number: "INV-2026-0001",
    number_int: 1,
    year_of_issue: 2026,
    issued_at: "2026-09-01",
    issuer_profile_id: "iss-1",
    counterparty_contact_id: CONTACT,
    counterparty_name: "Atelier Exemple SARL",
    counterparty_address: "1 rue de l'Exemple, 75002 Paris",
    counterparty_vat_id: null,
    counterparty_email: "compta@atelier-exemple.example",
    counterparty_country: "FR",
    billing_line1: "1 rue de l'Exemple",
    billing_postcode: "75002",
    billing_city: "Paris",
    billing_country_code: "FR",
    currency: "EUR",
    subtotal_minor: "10000",
    tax_total_minor: "2000",
    grand_total_minor: "12000",
    tax_treatment: "fr_domestic",
    incoterm: "DAP",
    shopify_order_id: ORDER,
    external_refs: {},
    lifecycle_log: [{ event: "issued" }, { event: "marked_paid" }],
    ...over,
  }
}

const LINE = {
  id: "line-1",
  document_id: ORIGINAL_ID,
  position: 1,
  description: "Etabli en chene",
  quantity: "1.000",
  unit_price_minor: "10000",
  discount_minor: "0",
  line_kind: "goods",
  tax_rate_bp: 2000,
  subtotal_minor: "10000",
  tax_minor: "2000",
  total_minor: "12000",
  hs_code: null,
  country_of_origin: "FR",
  customs_description: null,
  product_source: "shopify",
  external_id: "gid://shopify/ProductVariant/7001",
}

function seededDb(): MockDb {
  return createMockDb({
    seed: {
      issuer_profiles: [ISSUER_ROW],
      einvoicing_settings: [{ id: "set-1", gate_mode: "enforce", gate_mode_source: "config" }],
      documents: [legacyFrInvoice()],
      document_lines: [LINE],
    },
  })
}

type Emitted = { entity: string; action: string; entityId?: string; data?: unknown }

function makeCtx(db: MockDb): { ctx: RefundCtx & OrderCancelledCtx; emitted: Emitted[] } {
  let seq = 0
  const emitted: Emitted[] = []
  const ctx = {
    getUserId: async () => "system",
    db: db as unknown as RefundCtx["db"] & OrderCancelledCtx["db"],
    emit: async (e: Emitted) => {
      emitted.push(e)
    },
    sequences: {
      async allocate(p: { key: string }) {
        const ex = (await db.findMany("__sequences", { where: { key: p.key }, limit: 1 })) as Array<
          Record<string, unknown>
        >
        const cur = ex[0]
        const next = (Number(cur?.value ?? 0) || 0) + 1
        if (cur) await db.update("__sequences", String(cur.id), { value: next })
        else await db.insert("__sequences", { key: p.key, value: next })
        return { value: next }
      },
    },
    pdf: {
      async render() {
        return { file_id: `pdf-${++seq}`, byte_size: 1024, page_count: 1, sha256: "0".repeat(64), parent_entity_id: crypto.randomUUID() }
      },
    },
    messages: {
      async post() {
        return { message_id: `msg-${++seq}` }
      },
    },
    requestApproval: async () => ({ approval_id: `appr-${++seq}` }),
    executeTool: async () => ({ status: "completed", result: {} }),
  } as unknown as RefundCtx & OrderCancelledCtx
  return { ctx, emitted }
}

function creditNotes(db: MockDb) {
  return db.__all("documents").filter((d) => d.type === "credit_note")
}

function parks(db: MockDb) {
  return db.__all("deferred_events")
}

/** Record the buyer's registry-confirmed identity, as the identity tools do (changed_at bumped). */
async function fixIdentity(db: MockDb, at: Date): Promise<void> {
  await db.insert("counterparty_identities", {
    contact_id: CONTACT,
    customer_kind: "business",
    siren: FICTIONAL_SIRENS[0],
    registry_name: "ATELIER EXEMPLE",
    registry_line1: "1 rue de l'Exemple",
    registry_postcode: "75002",
    registry_city: "Paris",
    registry_country_code: "FR",
    registry_status: "A",
    registry_checked_at: at,
    source: "registry",
    confirmed_via: "auto",
    changed_at: at,
  })
}

const sweep = (ctx: RefundCtx & OrderCancelledCtx, now: Date) =>
  deferredRetryJobHandler(undefined, ctx as unknown as Parameters<typeof deferredRetryJobHandler>[1], { now })

describe("refund credit note parked on the buyer's identity", () => {
  test("park, identity fixed, sweep: exactly one credit note issued and the park resolved; a second sweep issues none", async () => {
    const db = seededDb()
    const { ctx, emitted } = makeCtx(db)
    const t0 = new Date("2026-10-14T10:00:00Z")

    const res = await onShopifyRefundCreated(
      { data: { id: "refund-701", order_id: ORDER, refund_amount_minor: 3000n } },
      ctx,
    )
    // The refund itself is recorded; only its credit note waits.
    expect(res.status).toBe("ok")
    expect(creditNotes(db)).toHaveLength(0)
    const [park] = parks(db)
    expect(parks(db)).toHaveLength(1)
    expect(park!.event_id).toBe(`cn:refund-701:${ORIGINAL_ID}`)
    expect(park!.status).toBe("awaiting_data")
    expect(park!.reason).toBe("customer_kind_missing")
    expect(park!.blocked_on).toEqual({
      kind: "einvoice_identity",
      contact_id: CONTACT,
      document_id: ORIGINAL_ID,
      code: "customer_kind_missing",
    })
    const payload = park!.event_payload_json as Record<string, unknown>
    expect(payload.kind).toBe("parked_credit_note")
    expect(payload.source).toBe("refund")
    expect(payload.original_document_id).toBe(ORIGINAL_ID)
    expect(payload.amount_minor).toBe("3000")
    expect(payload.full_reversal).toBe(false)
    expect(payload.refund_id).toBe("refund-701")
    expect(emitted.filter((e) => e.action === "identity_missing")).toHaveLength(1)

    // Still blocked: the sweep tries, the park stays open.
    const first = await sweep(ctx, t0)
    expect(first.failed).toBe(1)
    expect(creditNotes(db)).toHaveLength(0)
    expect(parks(db)[0]!.status).toBe("awaiting_data")

    // The identity is fixed one minute later; two minutes later the 5-minute backoff has not
    // elapsed, but the identity change makes the park due.
    await fixIdentity(db, new Date(t0.getTime() + 60_000))
    const second = await sweep(ctx, new Date(t0.getTime() + 120_000))
    expect(second.succeeded).toBe(1)
    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    expect(String(cns[0]!.grand_total_minor)).toBe("-3000")
    expect((cns[0]!.external_refs as Record<string, unknown>).original_document_id).toBe(ORIGINAL_ID)
    expect(cns[0]!.regime).toBe("e_invoice")
    expect(cns[0]!.buyer_siren).toBe(FICTIONAL_SIRENS[0])
    expect(parks(db)[0]!.status).toBe("resolved")
    // The refund was not recorded a second time.
    const original = (await db.findOne("documents", ORIGINAL_ID)) as Record<string, unknown>
    const log = original.lifecycle_log as Array<Record<string, unknown>>
    expect(log.filter((e) => e.shopify_refund_id === "refund-701")).toHaveLength(1)

    const third = await sweep(ctx, new Date(t0.getTime() + 3 * 3_600_000))
    expect(third.scanned).toBe(0)
    expect(creditNotes(db)).toHaveLength(1)
  })

  test("re-driving the same parked credit note twice issues it once", async () => {
    const db = seededDb()
    const { ctx } = makeCtx(db)
    await onShopifyRefundCreated(
      { data: { id: "refund-702", order_id: ORDER, refund_amount_minor: 3000n } },
      ctx,
    )
    await fixIdentity(db, new Date("2026-10-14T10:01:00Z"))
    const row = parks(db)[0] as unknown as DeferredRow
    const mctx = ctx as unknown as MutationsCtx
    expect(await retryParkedCreditNote(mctx, row)).toEqual({ status: "ok" })
    expect(await retryParkedCreditNote(mctx, row)).toEqual({ status: "ok" })
    expect(creditNotes(db)).toHaveLength(1)
  })

  test("a full reversal partly covered meanwhile re-issues only the remainder", async () => {
    const db = seededDb()
    const { ctx } = makeCtx(db)
    await onShopifyRefundCreated(
      { data: { id: "refund-703", order_id: ORDER, refund_amount_minor: 12000n } },
      ctx,
    )
    const row = parks(db)[0] as unknown as DeferredRow
    expect((row.event_payload_json as Record<string, unknown>).full_reversal).toBe(true)
    await fixIdentity(db, new Date("2026-10-14T10:01:00Z"))
    // Meanwhile a person credited 50.00 of the 120.00 by hand.
    const manual = await creditNoteCreateAndIssue(
      { ...(ctx as unknown as MutationsCtx), approval: { approvalRequestId: "a-1", approvalDeciderId: "u-1", toolName: "invoicing:credit_note_create_and_issue" } },
      {
        issuer_profile_id: "iss-1",
        counterparty: {
          contact_id: CONTACT,
          legal_name: "Atelier Exemple SARL",
          country: "FR",
          vat_id: null,
          address: "1 rue de l'Exemple, 75002 Paris",
          email: "compta@atelier-exemple.example",
          billing_line1: "1 rue de l'Exemple",
          billing_postcode: "75002",
          billing_city: "Paris",
          billing_country_code: "FR",
        },
        currency: "EUR",
        items: [{ description: "Geste commercial", quantity: "1", unit_price_minor: -4167n, tax_rate_bp_override: 2000, line_kind: "goods" }] as never,
        original_document_id: ORIGINAL_ID,
        operation_category: "goods",
      },
    )
    expect(manual.status).toBe("completed")
    expect(await retryParkedCreditNote(ctx as unknown as MutationsCtx, row)).toEqual({ status: "ok" })
    const auto = creditNotes(db).filter(
      (d) => (d.external_refs as Record<string, unknown>).reason === "Auto-generated on Shopify refund refund-703",
    )
    expect(auto).toHaveLength(1)
    // 120.00 - 50.00 (41.67 + 8.33 VAT) = 70.00 remain; the reversal never over-credits.
    expect(String(auto[0]!.grand_total_minor)).toBe("-7000")
  })
})

describe("cancellation credit note parked on the buyer's identity", () => {
  test("park, identity fixed, sweep: one credit note, no duplicate cancellation record or attention", async () => {
    const db = seededDb()
    const { ctx, emitted } = makeCtx(db)
    const t0 = new Date("2026-10-14T10:00:00Z")

    const res = await onShopifyOrderCancelled({ data: { orderId: ORDER, cancel_reason: "customer" } }, ctx)
    expect(res.status).toBe("ok")
    expect(creditNotes(db)).toHaveLength(0)
    expect(parks(db)).toHaveLength(1)
    const park = parks(db)[0]!
    expect(park.event_id).toBe(`cn:cancel:${ORDER}:${ORIGINAL_ID}`)
    expect((park.blocked_on as Record<string, unknown>).kind).toBe("einvoice_identity")
    expect((park.event_payload_json as Record<string, unknown>).source).toBe("cancel")
    expect((park.event_payload_json as Record<string, unknown>).order_id).toBe(ORDER)
    const emittedAtCancel = emitted.length
    expect(emitted.filter((e) => e.action === "identity_missing")).toHaveLength(1)

    await fixIdentity(db, new Date(t0.getTime() + 60_000))
    const out = await sweep(ctx, new Date(t0.getTime() + 120_000))
    expect(out.succeeded).toBe(1)
    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    expect(String(cns[0]!.grand_total_minor)).toBe("-12000")
    expect(parks(db)[0]!.status).toBe("resolved")

    const original = (await db.findOne("documents", ORIGINAL_ID)) as Record<string, unknown>
    const log = original.lifecycle_log as Array<Record<string, unknown>>
    expect(log.filter((e) => e.event === "shopify_order_cancelled")).toHaveLength(1)
    // The sweep raised no cancellation attention or audit event again: only the credit
    // note's own audit trail.
    const sinceSweep = emitted.slice(emittedAtCancel)
    expect(sinceSweep.filter((e) => e.action === "order_cancelled" || e.action === "cancelled")).toHaveLength(0)
    // The identity item is not raised again; the sweep only closes it.
    const identityEvents = sinceSweep.filter((e) => e.action === "identity_missing")
    expect(identityEvents).toHaveLength(1)
    expect((identityEvents[0]!.data as Record<string, unknown>).resolved).toBe(true)
    expect(openAttention(emitted, "identity_missing")).toEqual([])

    const again = await sweep(ctx, new Date(t0.getTime() + 3 * 3_600_000))
    expect(again.scanned).toBe(0)
    expect(creditNotes(db)).toHaveLength(1)
  })
})

/** Attention items still open for an event action: raised (resolved:false) minus resolved. */
function openAttention(emitted: Emitted[], action: string): string[] {
  const open = new Set<string>()
  for (const e of emitted) {
    if (e.action !== action) continue
    const resolved = (e.data as Record<string, unknown> | undefined)?.resolved === true
    if (resolved) open.delete(String(e.entityId))
    else open.add(String(e.entityId))
  }
  return [...open]
}

/** An e-invoice to a French company whose stored snapshot carries no SIREN (issued in warn mode). */
function eInvoiceWithoutSiren(over: Record<string, unknown> = {}): Record<string, unknown> {
  return legacyFrInvoice({
    regime: "e_invoice",
    customer_kind: "business",
    buyer_legal_name: "ATELIER EXEMPLE",
    buyer_siren: null,
    operation_category: "goods",
    operation_category_source: "lines_authoritative",
    ...over,
  })
}

function dbWith(original: Record<string, unknown>): MockDb {
  return createMockDb({
    seed: {
      issuer_profiles: [ISSUER_ROW],
      einvoicing_settings: [{ id: "set-1", gate_mode: "enforce", gate_mode_source: "config" }],
      documents: [original],
      document_lines: [LINE],
    },
  })
}

describe("an e-invoice original whose snapshot lacks the buyer's SIREN", () => {
  test("park, confirmed identity, sweep: exactly one credit note, SIREN provenance recorded, original untouched", async () => {
    const db = dbWith(eInvoiceWithoutSiren())
    const { ctx, emitted } = makeCtx(db)
    const t0 = new Date("2026-10-14T10:00:00Z")
    await onShopifyRefundCreated({ data: { id: "refund-801", order_id: ORDER, refund_amount_minor: 3000n } }, ctx)
    expect(parks(db)).toHaveLength(1)
    expect(parks(db)[0]!.reason).toBe("einvoice_data_missing")

    await fixIdentity(db, new Date(t0.getTime() + 60_000))
    const out = await sweep(ctx, new Date(t0.getTime() + 120_000))
    expect(out.succeeded).toBe(1)
    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    expect(cns[0]!.buyer_siren).toBe(FICTIONAL_SIRENS[0])
    expect(cns[0]!.buyer_siren_confirmed_via).toBe("auto")
    const reasons = cns[0]!.regime_reasons as Array<Record<string, unknown>>
    expect(reasons.some((r) => r.code === "buyer_siren_from_identity")).toBe(true)
    expect(parks(db)[0]!.status).toBe("resolved")
    const original = (await db.findOne("documents", ORIGINAL_ID)) as Record<string, unknown>
    expect(original.buyer_siren).toBeNull()
    expect(openAttention(emitted, "identity_missing")).toEqual([])
  })

  test("an unconfirmed identity does not stand in for the original's SIREN", async () => {
    const db = dbWith(eInvoiceWithoutSiren())
    const { ctx } = makeCtx(db)
    await onShopifyRefundCreated({ data: { id: "refund-802", order_id: ORDER, refund_amount_minor: 3000n } }, ctx)
    await db.insert("counterparty_identities", {
      contact_id: CONTACT,
      customer_kind: "business",
      siren: FICTIONAL_SIRENS[0],
      source: "derived",
      confirmed_via: null,
      changed_at: new Date("2026-10-14T10:01:00Z"),
    })
    const row = parks(db)[0] as unknown as DeferredRow
    expect(await retryParkedCreditNote(ctx as unknown as MutationsCtx, row)).toEqual({
      status: "still_blocked",
      reason: "einvoice_data_missing",
    })
    expect(creditNotes(db)).toHaveLength(0)
  })

  test("contactless original: the refusal names documents_update; linking the contact then confirming the identity unblocks it", async () => {
    const db = dbWith(eInvoiceWithoutSiren({ counterparty_contact_id: null }))
    const { ctx, emitted } = makeCtx(db)
    const mctx = ctx as unknown as MutationsCtx
    // The refusal the park carries tells the person what can actually unblock it.
    const refusal = await creditNoteCreateAndIssue(mctx, {
      issuer_profile_id: "iss-1",
      counterparty: {
        contact_id: null,
        legal_name: "Atelier Exemple SARL",
        country: "FR",
        vat_id: null,
        address: "1 rue de l'Exemple, 75002 Paris",
        email: "compta@atelier-exemple.example",
      },
      currency: "EUR",
      items: [{ description: "Remise", quantity: "1", unit_price_minor: -2500n, tax_rate_bp_override: 2000, line_kind: "goods" }] as never,
      original_document_id: ORIGINAL_ID,
    })
    expect(refusal.status).toBe("error")
    if (refusal.status !== "error") throw new Error("expected a refusal")
    const body = (refusal.error as { body?: { missing?: Array<{ field: string; fix_tool: string }> } }).body
    expect(body?.missing?.find((m) => m.field === "buyer_siren")?.fix_tool).toBe("documents_update")
    expect(refusal.error.message).toContain("documents_update")

    await onShopifyRefundCreated({ data: { id: "refund-803", order_id: ORDER, refund_amount_minor: 3000n } }, ctx)
    expect(parks(db)).toHaveLength(1)
    const park = parks(db)[0]!
    expect((park.blocked_on as Record<string, unknown>).contact_id).toBeNull()

    // A person links the original to its buyer's contact, and the identity gets confirmed.
    const linked = await documentsUpdate(mctx, { id: ORIGINAL_ID, counterparty_contact_id: CONTACT })
    expect(linked.status).toBe("completed")
    await fixIdentity(db, new Date("2026-10-14T10:01:00Z"))
    expect(await retryParkedCreditNote(mctx, park as unknown as DeferredRow)).toEqual({ status: "ok" })
    expect(creditNotes(db)).toHaveLength(1)
    expect(creditNotes(db)[0]!.buyer_siren).toBe(FICTIONAL_SIRENS[0])
    // The contactless park's attention item is keyed by the park; it closes with the park.
    await sweep(ctx, new Date("2026-10-14T12:00:00Z"))
    expect(openAttention(emitted, "identity_missing")).toEqual([])
  })
})

describe("identity attention closes with the last park waiting on the contact", () => {
  test("two parks for one contact: the item stays open until both resolve", async () => {
    const SECOND = "00000000-0000-4000-8000-0000000e7002"
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        einvoicing_settings: [{ id: "set-1", gate_mode: "enforce", gate_mode_source: "config" }],
        documents: [
          legacyFrInvoice(),
          legacyFrInvoice({ id: SECOND, number: "INV-2026-0002", number_int: 2, shopify_order_id: "ORD-T17-B" }),
        ],
        document_lines: [LINE, { ...LINE, id: "line-2", document_id: SECOND }],
      },
    })
    const { ctx, emitted } = makeCtx(db)
    await onShopifyRefundCreated({ data: { id: "refund-901", order_id: ORDER, refund_amount_minor: 3000n } }, ctx)
    await onShopifyRefundCreated({ data: { id: "refund-902", order_id: "ORD-T17-B", refund_amount_minor: 3000n } }, ctx)
    expect(openAttention(emitted, "identity_missing")).toEqual([CONTACT])

    // The sweep re-issues both, one after the other: the first to resolve leaves the second
    // still waiting on the same contact, so the item closes only with the second.
    await fixIdentity(db, new Date("2026-10-14T10:01:00Z"))
    const out = await sweep(ctx, new Date("2026-10-14T10:02:00Z"))
    expect(out.succeeded).toBe(2)
    expect(openAttention(emitted, "identity_missing")).toEqual([])
    const resolves = emitted.filter(
      (e) => e.action === "identity_missing" && (e.data as Record<string, unknown>).resolved === true,
    )
    expect(resolves).toHaveLength(1)
  })

  test("a cancellation closing the order's identity park resolves its attention item", async () => {
    const db = seededDb()
    const { ctx, emitted } = makeCtx(db)
    // An order-paid park waiting on the buyer's identity, with its attention item.
    const def = await park(
      { db },
      {
        event_id: "ORD-T17-C",
        event_payload_json: { id: "ORD-T17-C" },
        status: "awaiting_data",
        reason: "customer_kind_missing",
        blocked_on: { kind: "einvoice_identity", contact_id: CONTACT, code: "customer_kind_missing" },
      },
    )
    await raiseIdentityAttention(ctx, { park: def, contact_id: CONTACT, code: "customer_kind_missing" })
    expect(openAttention(emitted, "identity_missing")).toEqual([CONTACT])
    await onShopifyOrderCancelled({ data: { orderId: "ORD-T17-C" } }, ctx)
    expect(openAttention(emitted, "identity_missing")).toEqual([])
  })
})

describe("a credit note refused for any other reason parks with attention, never only a log line", () => {
  test("incomplete recipient: parked, raised, and re-issued alone once the original is completed", async () => {
    const db = dbWith(legacyFrInvoice({ counterparty_email: null }))
    await fixIdentity(db, new Date("2026-10-14T09:00:00Z"))
    const { ctx, emitted } = makeCtx(db)
    await onShopifyRefundCreated({ data: { id: "refund-951", order_id: ORDER, refund_amount_minor: 3000n } }, ctx)
    expect(creditNotes(db)).toHaveLength(0)
    expect(parks(db)).toHaveLength(1)
    const p = parks(db)[0]!
    expect(p.event_id).toBe(`cn:refund-951:${ORIGINAL_ID}`)
    expect(p.reason).toBe("counterparty_incomplete")
    expect((p.blocked_on as Record<string, unknown>).kind).toBe("auto_credit_note")
    expect(openAttention(emitted, "credit_note_refused")).toEqual([String(p.id)])

    // The person completes the original's recipient; the sweep re-issues the credit note alone.
    const mctx = ctx as unknown as MutationsCtx
    expect((await documentsUpdate(mctx, { id: ORIGINAL_ID, counterparty_email: "compta@atelier-exemple.example" })).status).toBe(
      "completed",
    )
    const out = await sweep(ctx, new Date("2026-10-14T12:00:00Z"))
    expect(out.succeeded).toBe(1)
    expect(creditNotes(db)).toHaveLength(1)
    expect(openAttention(emitted, "credit_note_refused")).toEqual([])
  })
})
