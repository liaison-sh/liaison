// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E4 — `onShopifyOrderCancelled` handler.
//
// The lifecycle event is always recorded. When the order carries an ISSUED
// (non-draft) invoice that is not already fully credit noted, cancelling the
// order also AUTO-ISSUES the reversing credit note(s) — the same auto-reversal
// contract `onShopifyRefundCreated` already has for a Shopify refund: the
// cancellation is authoritative and irreversible, so the correction document
// is generated automatically, no approval gate. A draft invoice, an order with
// no invoice yet, or an invoice already fully credit noted is skipped (still
// records the lifecycle event and, for a live invoice, the attention card).

import { resolveOpenParks } from "../deferred"
import { autoCreditNoteCounterparty, issueOrParkAutoCreditNote } from "../einvoicing/parked-credit-note"
import type { LineKind } from "../issue"
import { creditedTotalMinor, ISSUED_INVOICE_STATUSES, type MutationsCtx } from "../mutations"
import { buildAdjustmentReversalItems } from "./shopify-refund-created"
import { toBigInt } from "../mutations/shared"

export interface OrderCancelledPayload {
  id: string
  shop_id: string
  cancelled_at?: string
  cancel_reason?: string
}

export interface OrderCancelledDoc {
  id: string
  type: string
  number: string | null
  status: string
  grand_total_minor: bigint
  lifecycle_log: Array<Record<string, unknown>>
  /** Carried so this order's own document set can serve as `isFullyCredited`'s
   *  `candidateDocs` fallback (a credit note's `external_refs.original_document_id`
   *  back-link) without a second query. */
  external_refs: Record<string, unknown>
}

export interface OrderCancelledDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      limit?: number
    },
  ): Promise<unknown[]>
  findOne(entity: string, id: string): Promise<unknown | null>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface OrderCancelledCtx {
  getUserId(): Promise<string>
  db: OrderCancelledDb
  // The real SDK channel for attention: emit a declared event mapped to an
  // attention item by the manifest rule `invoicing:order_cancelled`.
  emit(event: {
    entity: string
    action: string
    entityId?: string
    data?: unknown
    metadata?: Record<string, unknown>
  }): Promise<void>
  // Full issue pipeline — present on the kernel-injected event ctx (identical to
  // onShopifyRefundCreated's), absent on minimal unit-test ctxs. When present, a
  // cancelled order with a live invoice also AUTO-ISSUES the reversing credit
  // note(s). Typed against MutationsCtx's fields so creditNoteCreateAndIssue can
  // run with this ctx.
  pdf?: MutationsCtx["pdf"]
  sequences?: MutationsCtx["sequences"]
  requestApproval?: MutationsCtx["requestApproval"]
  executeTool?: MutationsCtx["executeTool"]
  messages?: MutationsCtx["messages"]
  // Kernel-injected logger (absent on minimal unit-test ctxs).
  logger?: {
    error(msg: string, data?: unknown): void
    warn?(msg: string, data?: unknown): void
  }
}

export type OrderCancelledResult =
  | { status: "ok"; document_id: string; attention_emitted: boolean }
  | { status: "noop"; reason: "no_invoice_yet" }

/** True when the runtime ctx carries the issue pipeline (so a credit note can be issued). */
function hasIssuePipeline(ctx: OrderCancelledCtx): boolean {
  return typeof ctx.pdf?.render === "function" && typeof ctx.sequences?.allocate === "function"
}

async function findDocumentsByShopifyOrderId(
  db: OrderCancelledDb,
  shopifyOrderId: string,
): Promise<OrderCancelledDoc[]> {
  // Indexed equality on the top-level shopify_order_id column. A split order
  // (goods + software scopes) carries several documents — a cancellation
  // concerns all of them.
  const rows = await db.findMany("documents", {
    where: { shopify_order_id: shopifyOrderId },
    limit: 10,
  })
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    type: String(r.type ?? "invoice"),
    number: (r.number as string | null) ?? null,
    status: String(r.status ?? "draft"),
    grand_total_minor: toBigInt(r.grand_total_minor),
    lifecycle_log:
      (r.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? [],
    external_refs: (r.external_refs as Record<string, unknown> | undefined) ?? {},
  }))
}

/**
 * Auto-issue the credit note(s) that reverse the OUTSTANDING balance of an issued invoice on
 * order cancellation. `remaining = abs(invoice total) - creditedTotalMinor(...)` decides the
 * shape:
 *   - remaining <= 0: nothing outstanding (already fully reversed by a prior full credit note,
 *     or by a cancellation retry) -- skip. Also idempotent for a retried/duplicate cancelled
 *     event, since the second call's `creditedTotalMinor` sees the credit note the first call
 *     issued.
 *   - remaining equals the full invoice total (nothing credited yet, e.g. no prior refund):
 *     mirrors onShopifyRefundCreated's FULL-reversal path -- every line of the invoice, negated,
 *     each keeping its own tax rate.
 *   - 0 < remaining < full total (a prior PARTIAL refund already credited part of the invoice,
 *     e.g. a Shopify partial refund before the order was cancelled): issue ONE adjustment credit
 *     note for exactly `remaining`, reusing onShopifyRefundCreated's partial-refund adjustment
 *     shape (`buildAdjustmentReversalItems`) rather than a full line-by-line mirror -- a full
 *     mirror here would OVER-REVERSE the invoice past its own total.
 * Best-effort: a failure here never unwinds the lifecycle event already recorded.
 *
 * Two literally CONCURRENT deliveries of the same cancellation (racing each other, both reading
 * "not yet credited" before either write lands) never reach this function at all: the kernel's
 * webhook ingestion route claims an atomic Redis `SET NX` dedupe key per delivery before the
 * event is emitted to any subscriber (`apps/api/src/modules/webhooks/routes.ts`), so only one of
 * two racing deliveries is ever dispatched.
 */
async function autoIssueCancelCreditNotes(
  ctx: OrderCancelledCtx,
  docs: OrderCancelledDoc[],
  orderId: string,
): Promise<void> {
  for (const doc of docs) {
    if (doc.type !== "invoice") continue
    if (!ISSUED_INVOICE_STATUSES.has(doc.status)) continue
    await issueOneCancelCreditNote(ctx, doc, docs, orderId)
  }
}

/**
 * Reverse what remains of ONE issued invoice of a cancelled order (see autoIssueCancelCreditNotes).
 * An e-invoicing refusal parks this credit note alone on the buyer's identity, for the retry
 * sweep to re-issue without replaying the cancellation.
 */
async function issueOneCancelCreditNote(
  ctx: OrderCancelledCtx,
  doc: OrderCancelledDoc,
  docs: OrderCancelledDoc[],
  orderId: string,
): Promise<void> {
  const mctx = ctx as unknown as MutationsCtx
  // Pass the invoice's own id AND the already-fetched order document set as `candidateDocs` —
  // the durable external_refs.original_document_id back-link fallback (see creditedTotalMinor in
  // mutations.ts). Without `id`, the back-link scan can never match (it compares against
  // `invoiceRow.id`), so a credit note whose lifecycle_log marker is missing/lost was invisible
  // here — the ONE path with no marker fallback — and cancelling issued a SECOND credit note.
  const credited = await creditedTotalMinor(
    mctx.db,
    { id: doc.id, lifecycle_log: doc.lifecycle_log },
    docs as unknown as Array<Record<string, unknown>>,
  )
  const invoiceTotal =
    doc.grand_total_minor < 0n ? -doc.grand_total_minor : doc.grand_total_minor
  const remaining = invoiceTotal - credited
  if (remaining <= 0n) return

  const fresh = (await mctx.db.findOne("documents", doc.id)) as Record<string, unknown> | null
  if (!fresh) return

  // The credit note inherits the ORIGINAL invoice's recipient snapshot verbatim (see
  // autoCreditNoteCounterparty): an incomplete one refuses and parks until it is completed.
  const counterparty = autoCreditNoteCounterparty(fresh)
  const currency = String(fresh.currency ?? "EUR")

  const lineRows = (await mctx.db.findMany("document_lines", {
    where: { document_id: doc.id },
  })) as Array<Record<string, unknown>>

  // remaining === invoiceTotal means nothing has been credited yet (credited === 0n): the
  // ordinary happy path, a full line-by-line mirror. Anything less means a prior partial
  // credit note already covered part of the invoice, so only the remainder gets reversed here
  // -- issuing a full mirror on top would over-reverse the invoice past its own total.
  let items: Array<Record<string, unknown>>
  if (remaining >= invoiceTotal) {
    items = lineRows.map((l) => ({
      description: String(l.description ?? "Item"),
      quantity: String(l.quantity ?? "1"),
      unit_price_minor: -toBigInt(l.unit_price_minor),
      // Mirror each line's own tax rate so an export (0) reverses at 0 and a
      // domestic-VAT line reverses its VAT exactly.
      tax_rate_bp_override: Number(l.tax_rate_bp ?? 0),
      line_kind: ((l.line_kind as LineKind | undefined) ?? "goods") as LineKind,
      hs_code: (l.hs_code as string | null) ?? null,
      customs_description: (l.customs_description as string | null) ?? null,
      country_of_origin: (l.country_of_origin as string | null) ?? null,
      product_source: (l.product_source as string | null) ?? null,
      external_id: (l.external_id as string | null) ?? null,
    }))
  } else {
    items = buildAdjustmentReversalItems(
      lineRows.map((l) => ({
        unit_price_minor: toBigInt(l.unit_price_minor),
        quantity: (l.quantity as string | number | undefined) ?? "1",
        tax_rate_bp: Number(l.tax_rate_bp ?? 0),
        line_kind: (l.line_kind as LineKind | undefined) ?? "goods",
      })),
      remaining,
      (fresh.scope as string | null) ?? null,
    )
  }

  await issueOrParkAutoCreditNote({ ...mctx, logger: ctx.logger }, {
    source: "cancel",
    original_document_id: doc.id,
    amount_minor: remaining,
    full_reversal: remaining >= invoiceTotal,
    order_id: orderId,
    issuer_profile_id: (fresh.issuer_profile_id as string | null) ?? null,
    counterparty,
    currency,
    items,
    reason: `Auto-generated on Shopify order ${orderId} cancellation`,
    order_label: String(fresh.shopify_order_number ?? orderId),
  })
}

export async function onShopifyOrderCancelled(
  event: Partial<OrderCancelledPayload> & {
    entityId?: string
    orderId?: string
    data?: { orderId?: string; id?: string; cancel_reason?: string }
  },
  ctx: OrderCancelledCtx,
): Promise<OrderCancelledResult> {
  // Unwrap the kernel event envelope OR the bare normalized order (whose id
  // field is `orderId`) — mirror `onShopifyOrderCreated`'s `event.data ?? event`
  // so wrapped, bare-normalized, and unit-call shapes all resolve. (Previously
  // read only `event.id`, which the normalized order never carries → real
  // cancellations no-op'd.)
  const src = (event.data ?? event) as {
    orderId?: string
    id?: string
    cancel_reason?: string
  }
  const orderId = String(event.entityId ?? src.orderId ?? src.id ?? "")
  const cancelReason = src.cancel_reason ?? event.cancel_reason ?? null

  // A cancelled order has nothing left to invoice: close any park it still has (e.g. one waiting
  // on a customer email), so it neither keeps retrying nor reads as a stuck invoice.
  await resolveOpenParks({ db: ctx.db, emit: ctx.emit }, orderId, "order_cancelled")

  const docs = await findDocumentsByShopifyOrderId(ctx.db, orderId)
  if (docs.length === 0) {
    return { status: "noop", reason: "no_invoice_yet" }
  }
  const actor = await ctx.getUserId()
  let anyAttention = false
  for (const doc of docs) {
    const log = [
      ...doc.lifecycle_log,
      {
        event: "shopify_order_cancelled",
        actor,
        ts: new Date().toISOString(),
        shopify_order_id: orderId,
        cancel_reason: cancelReason,
      },
    ]
    // PRIMARY, durable effect — record the lifecycle event.
    await ctx.db.update("documents", doc.id, { lifecycle_log: log })
    // Kernel audit trail — every cancelled document, mirroring the shopify_order_cancelled
    // lifecycle_log entry just written above (not gated on needsReview: the audit trail
    // records the cancellation regardless of whether it also raises an attention item).
    await ctx.emit({
      entity: "document",
      action: "cancelled",
      entityId: doc.id,
      data: {
        document_id: doc.id,
        type: doc.type,
        number: doc.number,
        status: doc.status,
        reason: cancelReason,
      },
    })
    const needsReview =
      doc.status === "issued" ||
      doc.status === "paid" ||
      doc.status === "overdue"
    if (needsReview) {
      anyAttention = true
      // Emit the attention-raising event (manifest rule `detail:order_cancelled`
      // -> attention for `invoicing:documents:write` holders). Runs in the handler
      // transaction alongside the lifecycle write above. `entity: "detail"`
      // anchors the item to the document detail tab (`invoicing:detail`); see
      // shopify-order-updated.ts for why the emit entity is the tab-type name.
      await ctx.emit({
        entity: "detail",
        action: "order_cancelled",
        entityId: doc.id,
        data: {
          document_id: doc.id,
          document_number: doc.number,
          document_status: doc.status,
          shopify_order_id: orderId,
          cancel_reason: cancelReason,
        },
      })
    }
  }
  // Auto-issue the reversing credit note(s). Best-effort and gated on the issue
  // pipeline being present (it is on the real kernel event ctx; absent in db-only
  // unit ctxs). A failure here must NOT unwind the lifecycle event we just recorded.
  if (hasIssuePipeline(ctx)) {
    try {
      await autoIssueCancelCreditNotes(ctx, docs, orderId)
    } catch {
      // Credit-note issuance is best-effort; the cancellation record stands.
    }
  }
  return {
    status: "ok",
    document_id: docs[0]!.id,
    attention_emitted: anyAttention,
  }
}
