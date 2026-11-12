// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scheduled reconciliation job tests — corrects Shopify-synced invoices'
// payment status against the authoritative Shopify order financial_status.
// Mirrors the shopify-order-paid.test.ts harness (createMockDb + a stubbed
// executeTool keyed by tool name).

import { describe, expect, test } from "bun:test"
import { createMockDb, type MockDb } from "../test-db"
import { testTime } from "../test-time"
import {
  type ReconcileCrossAppEnvelope,
  type ReconcileCtx,
  reconcileShopifyPayments,
  reconcileShopifyPaymentsJobHandler,
} from "./reconcile-shopify-payments"

interface SeedDocOptions {
  id?: string
  type?: string
  status?: string
  payment_status?: string
  scope?: "goods" | "software" | null
  shopify_order_id?: string | null
  external_refs?: Record<string, unknown> | null
  lifecycle_log?: Array<Record<string, unknown>>
  issuer_profile_id?: string
}

function seedDoc(over: SeedDocOptions = {}): Record<string, unknown> {
  return {
    id: over.id ?? "doc-1",
    issuer_profile_id: over.issuer_profile_id ?? null,
    type: over.type ?? "invoice",
    status: over.status ?? "issued",
    payment_status: over.payment_status ?? "unpaid",
    scope: over.scope ?? "goods",
    shopify_order_id: over.shopify_order_id === undefined ? "9001" : over.shopify_order_id,
    external_refs: over.external_refs ?? { shopify_order_id: over.shopify_order_id ?? "9001" },
    lifecycle_log: over.lifecycle_log ?? [
      { event: "issued", actor: "system", ts: "2026-06-01T00:00:00Z" },
    ],
  }
}

function makeCtx(opts?: {
  docs?: Array<Record<string, unknown>>
  issuerProfiles?: Array<Record<string, unknown>>
  documentLines?: Array<Record<string, unknown>>
  ordersByGid?: Record<string, ReconcileCrossAppEnvelope>
  executeToolImpl?: (
    target: string,
    args: Record<string, unknown>,
  ) => Promise<ReconcileCrossAppEnvelope>
  // Opt-in PDF bridge. OFF by default so payment-only tests keep ctx.pdf undefined (no render, no
  // spurious render errors); the inline-render tests turn it on.
  pdf?: boolean
}): {
  ctx: ReconcileCtx
  db: MockDb
  calls: Array<{ target: string; args: Record<string, unknown> }>
  renderCalls: Array<{ template_kind: string; data: unknown }>
  emittedAttention: Array<{ entity: string; action: string; entityId?: string; data?: unknown }>
} {
  const db = createMockDb({
    seed: {
      documents: opts?.docs ?? [],
      issuer_profiles: opts?.issuerProfiles ?? [],
      document_lines: opts?.documentLines ?? [],
    },
  })
  const calls: Array<{ target: string; args: Record<string, unknown> }> = []
  const renderCalls: Array<{ template_kind: string; data: unknown }> = []
  const emittedAttention: Array<{
    entity: string
    action: string
    entityId?: string
    data?: unknown
  }> = []
  const ctx: ReconcileCtx = {
    db,
    time: testTime(),
    emit: async (event) => {
      emittedAttention.push({
        entity: event.entity,
        action: event.action,
        entityId: event.entityId,
        data: event.data,
      })
    },
    async executeTool(target, args) {
      calls.push({ target, args })
      if (opts?.executeToolImpl) return opts.executeToolImpl(target, args)
      if (target === "shopify:orders_get") {
        const id = String(args.id ?? "")
        const found = opts?.ordersByGid?.[id]
        if (found) return found
        return { status: "error", error: { code: "NOT_FOUND", message: "no such order" } }
      }
      return { status: "error", error: { code: "UNKNOWN_TOOL", message: `unhandled ${target}` } }
    },
    ...(opts?.pdf
      ? {
          pdf: {
            async render(p: { template_kind: string; data: unknown }) {
              renderCalls.push(p)
              return {
                file_id: `pdf-${renderCalls.length}`,
                byte_size: 1024,
                page_count: 1,
                sha256: "0".repeat(64),
                parent_entity_id: crypto.randomUUID(),
              }
            },
          },
        }
      : {}),
  }
  return { ctx, db, calls, renderCalls, emittedAttention }
}

const RECON_ISSUER = {
  id: "iss-1",
  legal_name: "Fabrikam SAS",
  country: "FR",
  vat_id: "FR40908227172",
  address: "12 rue de la Musique",
  iban: "FR7630006000011234567890189",
  swift_bic: "AGRIFRPP",
  bank_name: "Credit Agricole",
  default_language: "en",
}

/** A full late-flip candidate doc (UNPAID at issue) with the columns ensureDocumentPdf needs. */
function fullDoc(id: string, orderId: string): Record<string, unknown> {
  return {
    ...seedDoc({ id, shopify_order_id: orderId, scope: "goods", payment_status: "unpaid" }),
    issuer_profile_id: "iss-1",
    number: `INV-${id}`,
    currency: "EUR",
    subtotal_minor: "74900",
    tax_total_minor: "14980",
    grand_total_minor: "89880",
    tax_treatment: "standard",
    incoterm: "DAP",
    issued_at: "2026-05-15",
    due_at: null,
    counterparty_name: "Jane Producer",
    counterparty_country: "DE",
    counterparty_vat_id: null,
    counterparty_address: "Hauptstrasse 5",
    counterparty_email: "jane@example.com",
    counterparty_contact_id: "contact-1",
    pdf_file_id: "pdf-old",
    pdf_status: "ready",
  }
}

function orderResult(over: {
  financialStatus: string
  fulfillmentStatus?: string
  processedAt?: string
  createdAt?: string
}): ReconcileCrossAppEnvelope {
  return {
    status: "completed",
    result: {
      financialStatus: over.financialStatus,
      fulfillmentStatus: over.fulfillmentStatus ?? "UNFULFILLED",
      attributes: {
        financialStatus: over.financialStatus,
        fulfillmentStatus: over.fulfillmentStatus ?? "UNFULFILLED",
        processedAt: over.processedAt,
        createdAt: over.createdAt,
      },
    },
  }
}

describe("reconcileShopifyPayments", () => {
  test("paid + FULFILLED order, goods invoice -> status=fulfilled, payment_status=paid, paid_at set, lifecycle gains marked_paid", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ id: "doc-1", shopify_order_id: "9001", scope: "goods" })],
      ordersByGid: {
        "gid://shopify/Order/9001": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
          processedAt: "2026-06-05T10:00:00Z",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.scanned).toBe(1)
    expect(result.marked_paid).toBe(1)
    expect(result.marked_payment_only).toBe(0)
    expect(result.errors).toEqual([])

    const doc = db.__all("documents")[0]!
    expect(doc.status).toBe("fulfilled")
    expect(doc.payment_status).toBe("paid")
    expect(doc.paid_at).toBe("2026-06-05")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(
      log.some(
        (e) =>
          e.event === "marked_paid" && e.actor === "system" && e.source === "shopify_reconcile",
      ),
    ).toBe(true)
  })

  test("late settlement: flips to paid AND re-renders the PDF inline as 'Amount paid' (link:false, payment_status reaches render)", async () => {
    const DOC = "00000000-0000-4000-8000-0000000009aa"
    const { ctx, db, renderCalls } = makeCtx({
      pdf: true,
      issuerProfiles: [RECON_ISSUER],
      documentLines: [
        {
          id: "l1",
          document_id: DOC,
          position: 1,
          description: "Tessera 2",
          quantity: "1",
          unit_price_minor: "74900",
          discount_minor: "0",
          line_kind: "goods",
          tax_rate_bp: 2000,
          subtotal_minor: "74900",
          tax_minor: "14980",
          total_minor: "89880",
          product_source: "shopify",
          external_id: null,
        },
      ],
      docs: [fullDoc(DOC, "9100")],
      ordersByGid: {
        "gid://shopify/Order/9100": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "UNFULFILLED",
          createdAt: "2026-06-10T00:00:00Z",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.marked_payment_only).toBe(1) // unfulfilled goods: payment flips, status stays issued
    expect(result.pdf_rerendered).toBe(1)
    expect(result.errors).toEqual([])

    const doc = db.__all("documents").find((d) => d.id === DOC)!
    expect(doc.payment_status).toBe("paid")
    expect(doc.pdf_file_id).toBe("pdf-1") // replaced the stale pdf-old
    expect(doc.pdf_status).toBe("ready")
    expect(renderCalls).toHaveLength(1)
    const rd = (renderCalls[0]!.data as { document: Record<string, unknown> }).document
    expect(rd.payment_status).toBe("paid")
    expect(rd.paid_at).toBe("2026-06-10")
  })

  test("render budget bounds the run: excess late-flips are DEFERRED (left unpaid), not lost — next tick finishes them", async () => {
    const A = "00000000-0000-4000-8000-0000000000a1"
    const B = "00000000-0000-4000-8000-0000000000b2"
    const mk = () =>
      makeCtx({
        pdf: true,
        issuerProfiles: [RECON_ISSUER],
        docs: [fullDoc(A, "9301"), fullDoc(B, "9302")],
        ordersByGid: {
          "gid://shopify/Order/9301": orderResult({
            financialStatus: "PAID",
            fulfillmentStatus: "UNFULFILLED",
            createdAt: "2026-06-10T00:00:00Z",
          }),
          "gid://shopify/Order/9302": orderResult({
            financialStatus: "PAID",
            fulfillmentStatus: "UNFULFILLED",
            createdAt: "2026-06-10T00:00:00Z",
          }),
        },
      })
    const { ctx, db } = mk()
    // Budget of 1: only one of the two late-flips is processed this run.
    const r1 = await reconcileShopifyPayments(ctx, { maxRerenders: 1 })
    expect(r1.pdf_rerendered).toBe(1)
    const paidNow = db.__all("documents").filter((d) => d.payment_status === "paid")
    expect(paidNow).toHaveLength(1) // the OTHER stays unpaid (deferred), not silently marked paid
    const stillUnpaid = db
      .__all("documents")
      .filter((d) => (d.payment_status ?? "unpaid") === "unpaid")
    expect(stillUnpaid).toHaveLength(1)
    expect(stillUnpaid[0]!.pdf_file_id).toBe("pdf-old") // deferred doc was NOT re-rendered

    // Next tick (fresh budget) finishes the deferred one.
    const r2 = await reconcileShopifyPayments(ctx, { maxRerenders: 40 })
    expect(r2.pdf_rerendered).toBe(1)
    expect(db.__all("documents").every((d) => d.payment_status === "paid")).toBe(true)
  })

  test("no PDF re-render for a status-only (fulfillment) change, and none when ctx carries no pdf bridge", async () => {
    // Already paid, only fulfillment flips issued->fulfilled: paymentChanged=false, so no render.
    const DOC = "00000000-0000-4000-8000-0000000009bb"
    const { ctx, renderCalls } = makeCtx({
      pdf: true,
      issuerProfiles: [RECON_ISSUER],
      docs: [{ ...fullDoc(DOC, "9200"), payment_status: "paid" }],
      ordersByGid: {
        "gid://shopify/Order/9200": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
          processedAt: "2026-06-05T00:00:00Z",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.marked_paid).toBe(1) // status flip issued->fulfilled
    expect(result.pdf_rerendered).toBe(0)
    expect(renderCalls).toHaveLength(0)
  })

  test("paid + UNFULFILLED order, goods invoice -> payment_status=paid but status STAYS issued; lifecycle gains marked_paid", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ id: "doc-2", shopify_order_id: "9002", scope: "goods" })],
      ordersByGid: {
        "gid://shopify/Order/9002": orderResult({
          financialStatus: "paid",
          fulfillmentStatus: "UNFULFILLED",
          createdAt: "2026-06-01T00:00:00Z",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.marked_paid).toBe(0)
    expect(result.marked_payment_only).toBe(1)

    const doc = db.__all("documents")[0]!
    expect(doc.status).toBe("issued")
    expect(doc.payment_status).toBe("paid")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.some((e) => e.event === "marked_paid")).toBe(true)
  })

  test("paid order, SOFTWARE-scope invoice, order unfulfilled -> status=fulfilled (digital, no shipping)", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ id: "doc-3", shopify_order_id: "9003", scope: "software" })],
      ordersByGid: {
        "gid://shopify/Order/9003": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "UNFULFILLED",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.marked_paid).toBe(1)
    const doc = db.__all("documents")[0]!
    expect(doc.status).toBe("fulfilled")
    expect(doc.payment_status).toBe("paid")
  })

  test("REFUNDED order -> invoice unchanged (still issued/unpaid), no lifecycle entry", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ id: "doc-4", shopify_order_id: "9004" })],
      ordersByGid: {
        "gid://shopify/Order/9004": orderResult({ financialStatus: "REFUNDED" }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.skipped_refunded).toBe(1)
    expect(result.marked_paid).toBe(0)
    expect(result.marked_payment_only).toBe(0)
    const doc = db.__all("documents")[0]!
    expect(doc.status).toBe("issued")
    expect(doc.payment_status).toBe("unpaid")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.some((e) => e.event === "marked_paid")).toBe(false)
  })

  test("locally-refunded invoice is NEVER re-marked paid, even if Shopify still reports PAID (eventual-consistency clobber guard)", async () => {
    // The refund webhook sets payment_status=refunded but leaves status=issued
    // (nothing shipped-state changed), so the doc stays a reconcile candidate.
    // If reconcile runs before Shopify propagates the refund, orders_get can
    // still say financial_status=PAID. Reconcile must NOT downgrade the local
    // refund back to paid — that is the bug that left a refunded invoice showing
    // "paid" with no reversal on the books.
    const { ctx, db } = makeCtx({
      docs: [
        {
          ...seedDoc({ id: "doc-refunded", shopify_order_id: "9500", scope: "goods" }),
          status: "issued",
          payment_status: "refunded",
          lifecycle_log: [{ event: "refunded", refund_amount_minor: "89900" }],
        },
      ],
      ordersByGid: {
        "gid://shopify/Order/9500": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.marked_paid).toBe(0)
    expect(result.marked_payment_only).toBe(0)
    expect(result.skipped_refunded).toBe(1)
    const doc = db.__all("documents")[0]!
    expect(doc.payment_status).toBe("refunded")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.some((e) => e.event === "marked_paid")).toBe(false)
  })

  test("locally-partial-refunded invoice is likewise not re-marked paid", async () => {
    const { ctx, db } = makeCtx({
      docs: [
        {
          ...seedDoc({ id: "doc-partial", shopify_order_id: "9501", scope: "goods" }),
          status: "issued",
          payment_status: "partial",
        },
      ],
      ordersByGid: {
        "gid://shopify/Order/9501": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.marked_paid).toBe(0)
    expect(result.marked_payment_only).toBe(0)
    const doc = db.__all("documents")[0]!
    expect(doc.payment_status).toBe("partial")
  })

  test("PARTIALLY_REFUNDED and VOIDED orders are also skipped as refunded", async () => {
    const { ctx, db } = makeCtx({
      docs: [
        seedDoc({ id: "doc-5", shopify_order_id: "9005" }),
        seedDoc({ id: "doc-6", shopify_order_id: "9006" }),
      ],
      ordersByGid: {
        "gid://shopify/Order/9005": orderResult({ financialStatus: "PARTIALLY_REFUNDED" }),
        "gid://shopify/Order/9006": orderResult({ financialStatus: "VOIDED" }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.skipped_refunded).toBe(2)
    expect(
      db.__all("documents").every((d) => d.status === "issued" && d.payment_status === "unpaid"),
    ).toBe(true)
  })

  test("PENDING order -> invoice unchanged", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ id: "doc-7", shopify_order_id: "9007" })],
      ordersByGid: {
        "gid://shopify/Order/9007": orderResult({ financialStatus: "PENDING" }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.skipped_unpaid).toBe(1)
    const doc = db.__all("documents")[0]!
    expect(doc.status).toBe("issued")
    expect(doc.payment_status).toBe("unpaid")
  })

  test("AUTHORIZED / PARTIALLY_PAID orders are also skipped as unpaid", async () => {
    const { ctx, db } = makeCtx({
      docs: [
        seedDoc({ id: "doc-8", shopify_order_id: "9008" }),
        seedDoc({ id: "doc-9", shopify_order_id: "9009" }),
      ],
      ordersByGid: {
        "gid://shopify/Order/9008": orderResult({ financialStatus: "AUTHORIZED" }),
        "gid://shopify/Order/9009": orderResult({ financialStatus: "PARTIALLY_PAID" }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.skipped_unpaid).toBe(2)
    expect(db.__all("documents").every((d) => d.payment_status === "unpaid")).toBe(true)
  })

  test("idempotency: running twice yields the same rows and does NOT append a second marked_paid", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ id: "doc-10", shopify_order_id: "9010", scope: "goods" })],
      ordersByGid: {
        "gid://shopify/Order/9010": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
          processedAt: "2026-06-05T10:00:00Z",
        }),
      },
    })
    const r1 = await reconcileShopifyPayments(ctx)
    expect(r1.marked_paid).toBe(1)
    const r2 = await reconcileShopifyPayments(ctx)
    expect(r2.marked_paid).toBe(0)
    expect(r2.marked_payment_only).toBe(0)

    const doc = db.__all("documents")[0]!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.filter((e) => e.event === "marked_paid")).toHaveLength(1)
  })

  test("executeTool throws for one order -> that order's invoices untouched, errors[] has an entry, OTHER orders still processed", async () => {
    const { ctx, db } = makeCtx({
      docs: [
        seedDoc({ id: "doc-11", shopify_order_id: "9011", scope: "goods" }),
        seedDoc({ id: "doc-12", shopify_order_id: "9012", scope: "goods" }),
      ],
      executeToolImpl: async (target, args) => {
        const id = String(args.id ?? "")
        if (id === "gid://shopify/Order/9011") {
          throw new Error("Shopify API timeout")
        }
        if (id === "gid://shopify/Order/9012") {
          return orderResult({
            financialStatus: "PAID",
            fulfillmentStatus: "FULFILLED",
            processedAt: "2026-06-05T10:00:00Z",
          })
        }
        return { status: "error", error: { code: "NOT_FOUND", message: "no such order" } }
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.order_id).toBe("9011")
    expect(result.errors[0]!.message).toContain("Shopify API timeout")

    const doc11 = db.__all("documents").find((d) => d.id === "doc-11")!
    expect(doc11.status).toBe("issued")
    expect(doc11.payment_status).toBe("unpaid")

    const doc12 = db.__all("documents").find((d) => d.id === "doc-12")!
    expect(doc12.status).toBe("fulfilled")
    expect(doc12.payment_status).toBe("paid")
    expect(result.marked_paid).toBe(1)
  })

  test("orders_get envelope status !== completed also records an error and continues", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ id: "doc-13", shopify_order_id: "9013" })],
      ordersByGid: {
        "gid://shopify/Order/9013": {
          status: "error",
          error: { code: "RATE_LIMIT", message: "throttled" },
        },
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.order_id).toBe("9013")
    const doc = db.__all("documents")[0]!
    expect(doc.status).toBe("issued")
    expect(doc.payment_status).toBe("unpaid")
  })

  test("falls back to external_refs.shopify_order_id when the top-level column is absent", async () => {
    const { ctx, db } = makeCtx({
      docs: [
        seedDoc({
          id: "doc-14",
          shopify_order_id: null,
          external_refs: { shopify_order_id: "9014", scope: "goods" },
          scope: "goods",
        }),
      ],
      ordersByGid: {
        "gid://shopify/Order/9014": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.marked_paid).toBe(1)
    const doc = db.__all("documents")[0]!
    expect(doc.status).toBe("fulfilled")
  })

  test("invoice with no resolvable order id is skipped from lookup entirely (not scanned into an order bucket)", async () => {
    const { ctx, db, calls } = makeCtx({
      docs: [seedDoc({ id: "doc-15", shopify_order_id: null, external_refs: {} })],
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.scanned).toBe(1)
    expect(calls.filter((c) => c.target === "shopify:orders_get")).toHaveLength(0)
    expect(result.errors).toEqual([])
    const doc = db.__all("documents")[0]!
    expect(doc.status).toBe("issued")
    expect(doc.payment_status).toBe("unpaid")
  })

  test("a split order (goods + software docs sharing one order id) reconciles each by its own scope", async () => {
    const { ctx, db } = makeCtx({
      docs: [
        seedDoc({ id: "doc-goods", shopify_order_id: "9020", scope: "goods" }),
        seedDoc({ id: "doc-sw", shopify_order_id: "9020", scope: "software" }),
      ],
      ordersByGid: {
        "gid://shopify/Order/9020": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "UNFULFILLED",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    // goods stays issued (payment-only), software flips to paid (fully marked).
    expect(result.marked_payment_only).toBe(1)
    expect(result.marked_paid).toBe(1)
    const goods = db.__all("documents").find((d) => d.id === "doc-goods")!
    const sw = db.__all("documents").find((d) => d.id === "doc-sw")!
    expect(goods.status).toBe("issued")
    expect(goods.payment_status).toBe("paid")
    expect(sw.status).toBe("fulfilled")
    expect(sw.payment_status).toBe("paid")
  })

  test("orders_get is called once per unique order id, not once per document", async () => {
    const { ctx, calls } = makeCtx({
      docs: [
        seedDoc({ id: "doc-a", shopify_order_id: "9030", scope: "goods" }),
        seedDoc({ id: "doc-b", shopify_order_id: "9030", scope: "software" }),
      ],
      ordersByGid: {
        "gid://shopify/Order/9030": orderResult({ financialStatus: "PENDING" }),
      },
    })
    await reconcileShopifyPayments(ctx)
    expect(calls.filter((c) => c.target === "shopify:orders_get")).toHaveLength(1)
  })

  test("kernel-shaped job handler forwards ctx and opts (payload ignored)", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ id: "doc-16", shopify_order_id: "9016", scope: "goods" })],
      ordersByGid: {
        "gid://shopify/Order/9016": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
        }),
      },
    })
    const result = await reconcileShopifyPaymentsJobHandler(undefined, ctx, {
      now: new Date("2026-06-10T00:00:00Z"),
    })
    expect(result.marked_paid).toBe(1)
    expect(db.__all("documents")[0]!.status).toBe("fulfilled")
  })

  test("candidates outside status='issued' are not scanned (a paid document is not re-fetched)", async () => {
    const { ctx, calls } = makeCtx({
      docs: [
        seedDoc({ id: "doc-17", shopify_order_id: "9017", status: "paid", payment_status: "paid" }),
      ],
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.scanned).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test("draft/credit_note rows are excluded by the type='invoice' scope", async () => {
    const { ctx } = makeCtx({
      docs: [seedDoc({ id: "doc-18", type: "credit_note", shopify_order_id: "9018" })],
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.scanned).toBe(0)
  })

  test("paid_at falls back to today when the order carries neither processedAt nor createdAt", async () => {
    const { ctx, db } = makeCtx({
      docs: [seedDoc({ id: "doc-19", shopify_order_id: "9019", scope: "goods" })],
      ordersByGid: {
        "gid://shopify/Order/9019": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
        }),
      },
    })
    const fixedNow = new Date("2026-07-09T12:00:00Z")
    await reconcileShopifyPayments(ctx, { now: fixedNow })
    const doc = db.__all("documents")[0]!
    expect(doc.paid_at).toBe("2026-07-09")
  })

  // red: drop the ctx.emit call in the reconcile loop's paid-flip branch -> a Shopify order that
  // settles late corrects the document's payment_status in the database but leaves no trace in
  // kernel.audit_log, so no human reviewing the audit trail sees the reconcile job did it.
  test("emits document:paid when reconciliation marks a document paid", async () => {
    const { ctx, emittedAttention } = makeCtx({
      docs: [seedDoc({ id: "doc-20", shopify_order_id: "9020", scope: "goods" })],
      ordersByGid: {
        "gid://shopify/Order/9020": orderResult({
          financialStatus: "PAID",
          fulfillmentStatus: "FULFILLED",
          processedAt: "2026-06-05T10:00:00Z",
        }),
      },
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.marked_paid).toBe(1)
    const evt = emittedAttention.find((e) => e.action === "paid")
    expect(evt).toBeDefined()
    expect(evt?.entity).toBe("document")
    expect(evt?.entityId).toBe("doc-20")
    expect(evt?.data).toMatchObject({
      document_id: "doc-20",
      type: "invoice",
      paid_at: "2026-06-05",
      payment_status: "paid",
    })
  })

  test("does not emit document:paid when a document is already paid and nothing changes", async () => {
    const { ctx, emittedAttention } = makeCtx({
      docs: [
        seedDoc({ id: "doc-21", shopify_order_id: "9021", status: "paid", payment_status: "paid" }),
      ],
    })
    await reconcileShopifyPayments(ctx)
    expect(emittedAttention.find((e) => e.action === "paid")).toBeUndefined()
  })
})

describe("the paid date reads the issuer's date", () => {
  const PARIS = { id: "iss-paris", timezone: "Europe/Paris" }
  const paidOrder = (over: { processedAt?: string; createdAt?: string }) => ({
    "gid://shopify/Order/9001": orderResult({
      financialStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      ...over,
    }),
  })
  const doc = () =>
    seedDoc({ id: "doc-1", shopify_order_id: "9001", scope: "goods", issuer_profile_id: PARIS.id })

  test("an order processed at 00:20 on 1 January in Paris", async () => {
    const { ctx, db } = makeCtx({
      docs: [doc()],
      issuerProfiles: [PARIS],
      ordersByGid: paidOrder({ processedAt: "2026-12-31T23:20:00Z" }),
    })
    await reconcileShopifyPayments(ctx)
    expect(db.__all("documents")[0]!.paid_at).toBe("2027-01-01")
  })

  test("an order with no date of its own: the run's instant, in Paris", async () => {
    const { ctx, db } = makeCtx({
      docs: [doc()],
      issuerProfiles: [PARIS],
      ordersByGid: paidOrder({}),
    })
    await reconcileShopifyPayments(ctx, { now: new Date("2026-12-31T23:20:00Z") })
    expect(db.__all("documents")[0]!.paid_at).toBe("2027-01-01")
  })

  test("an unknown zone leaves the invoice for the next run and says why", async () => {
    const { ctx, db } = makeCtx({
      docs: [doc()],
      issuerProfiles: [{ ...PARIS, timezone: "Europe/Atlantis" }],
      ordersByGid: paidOrder({ processedAt: "2026-12-31T23:20:00Z" }),
    })
    const result = await reconcileShopifyPayments(ctx)
    expect(result.marked_paid).toBe(0)
    expect(result.errors[0]?.message).toContain("Atlantis")
    expect(db.__all("documents")[0]!.payment_status).toBe("unpaid")
  })
})
