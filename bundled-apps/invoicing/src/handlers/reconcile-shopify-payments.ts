// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scheduled reconciliation job — corrects Shopify-synced invoices' payment
// status against the AUTHORITATIVE Shopify order `financial_status`.
//
// `onShopifyOrderPaid` (shopify-order-paid.ts) already reconciles payment at
// ISSUE time (a paid checkout settles the invoice's payment_status/paid_at
// inline). This job is the safety net for everything that flow can miss:
// backlog invoices issued before that reconciliation existed, an order whose
// financial_status flipped to "paid" AFTER issuance (e.g. a delayed bank
// transfer), or any drift between Liaison's copy and Shopify's ledger. It
// runs as SYSTEM (ungated — no approval prompts): it only ever tightens
// `payment_status`/`status` toward what Shopify already reports as settled,
// never touches money, and never issues/voids a document.
//
// Runs as manifest job `reconcile-shopify-payments` on a 10-minute cadence.
//
// When it flips an invoice to `payment_status="paid"` (a late settlement — a
// delayed bank transfer paid AFTER issue), it ALSO re-renders that invoice's PDF
// inline so it stops reading "Total due" and shows "Amount paid". The render uses
// `ensureDocumentPdf(..., link:false)` (fast — no host cross-tx link-write) and is
// BOUNDED per run by a render budget: late settlements are rare, so the budget is
// effectively never hit, but if a backlog ever exceeds it the job simply STOPS
// early and leaves the rest un-flipped, so the next tick re-selects and finishes
// them (nothing is lost). The bound + `link:false` keep the job well inside its
// execution timeout — the earlier timeout was worker-pool contention with the
// one-time `rerender-settled-pdfs` backfill (since removed), never these renders.

import type { IssueCtx } from "../issue"
import { civilDateOf, type TimeSurface } from "../issue-date"
import { ensureDocumentPdf } from "../mutations"

/** Max PDF re-renders per reconcile run (defensive bound — real late-settlement runs flip a
 *  handful at most). On hitting it the job leaves the remaining flips for the next tick. */
const MAX_RERENDERS_PER_RUN = 40

export interface ReconcileCandidateRow {
  id: string
  issuer_profile_id: string | null
  type: string
  number: string | null
  currency: string
  grand_total_minor: string
  scope: "goods" | "software" | null
  status: string
  payment_status: string
  shopify_order_id: string | null
  external_refs: Record<string, unknown> | null
  lifecycle_log: Array<Record<string, unknown>>
}

export interface ReconcileDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      // orderBy/offset keep the shape compatible with IssueDb.findMany so the ctx can be handed to
      // the shared ensureDocumentPdf (which reads document_lines ordered by position).
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
    },
  ): Promise<unknown[]>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  /** A re-render of a document whose first render never succeeded records its legal original. */
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
}

export interface ReconcileCrossAppEnvelope {
  status: "completed" | "pending_approval" | "error"
  result?: unknown
  error?: { code: string; message: string; retryable?: boolean }
  approval_id?: string
}

export interface ReconcileCtx extends TimeSurface {
  db: ReconcileDb
  executeTool(target: string, args: Record<string, unknown>): Promise<ReconcileCrossAppEnvelope>
  /** PDF render bridge (present on the kernel-injected job ctx). Used to re-render a late-settled
   *  invoice inline so it reads "Amount paid". Optional so the pure unit ctx can omit it. */
  pdf?: IssueCtx["pdf"]
  /** Kernel audit trail channel (declared manifest event `document:paid`). Present on the
   *  kernel-injected job ctx; optional so the pure unit ctx can omit it. */
  emit?(event: {
    entity: string
    action: string
    entityId?: string
    data?: unknown
    metadata?: Record<string, unknown>
  }): Promise<void>
}

export interface ReconcileError {
  order_id: string
  message: string
}

export interface ReconcileResult {
  scanned: number
  marked_paid: number
  marked_payment_only: number
  skipped_refunded: number
  skipped_unpaid: number
  /** Late-settled invoices whose PDF was re-rendered as "Amount paid" this run. */
  pdf_rerendered: number
  errors: ReconcileError[]
}

const REFUNDED_FINANCIAL_STATUSES = new Set(["refunded", "partially_refunded", "voided"])

// A LOCAL payment_status that a refund has already set. Reconcile must never
// downgrade one of these back to "paid": the refund webhook is authoritative and
// leaves status="issued" (nothing shipped-state changed), so the refunded doc
// stays a reconcile candidate. If reconcile runs before Shopify propagates the
// refund, orders_get can still report financial_status=PAID — without this guard
// reconcile clobbers the refund and the invoice shows "paid" with no reversal.
const LOCALLY_REFUNDED_STATUSES = new Set(["refunded", "partial"])

function toCandidateRow(row: unknown): ReconcileCandidateRow {
  const r = row as Record<string, unknown>
  return {
    id: String(r.id),
    issuer_profile_id: (r.issuer_profile_id as string | null) ?? null,
    type: String(r.type ?? "invoice"),
    number: (r.number as string | null) ?? null,
    currency: String(r.currency ?? "EUR"),
    grand_total_minor: String(r.grand_total_minor ?? "0"),
    scope: (r.scope as "goods" | "software" | null) ?? null,
    status: String(r.status ?? "draft"),
    payment_status: String(r.payment_status ?? "unpaid"),
    shopify_order_id: (r.shopify_order_id as string | null) ?? null,
    external_refs: (r.external_refs as Record<string, unknown> | null) ?? null,
    lifecycle_log: (r.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? [],
  }
}

/** Prefer the top-level indexed column; fall back to the JSON snapshot. */
function resolveOrderId(doc: ReconcileCandidateRow): string | null {
  if (doc.shopify_order_id) return doc.shopify_order_id
  const fromRefs = doc.external_refs?.shopify_order_id
  return typeof fromRefs === "string" && fromRefs.length > 0 ? fromRefs : null
}

function toGid(orderId: string): string {
  return orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`
}

interface OrderFacts {
  financialStatus: string | null
  fulfillmentStatus: string | null
  processedAt: string | null
  createdAt: string | null
}

/**
 * `shopify:orders_get` returns financial/fulfillment facts BOTH at the top
 * level and nested under `.attributes` (see shopify-order-paid.ts's
 * ShopifyOrderFetch vs. the deferred-dispatch variants_get shape) — check
 * top-level first, then `.attributes`. Shopify values are UPPERCASE; compare
 * case-insensitively throughout.
 */
function extractOrderFacts(result: unknown): OrderFacts {
  const r = (result as Record<string, unknown>) ?? {}
  const attrs = (r.attributes as Record<string, unknown> | undefined) ?? {}
  const financialStatus =
    (r.financialStatus as string | undefined) ??
    (attrs.financialStatus as string | undefined) ??
    null
  const fulfillmentStatus =
    (r.fulfillmentStatus as string | undefined) ??
    (attrs.fulfillmentStatus as string | undefined) ??
    null
  const processedAt =
    (r.processedAt as string | undefined) ?? (attrs.processedAt as string | undefined) ?? null
  const createdAt =
    (r.createdAt as string | undefined) ?? (attrs.createdAt as string | undefined) ?? null
  return { financialStatus, fulfillmentStatus, processedAt, createdAt }
}

/**
 * Compute the desired {status, payment_status} for one invoice given
 * its order's facts, per the reconciliation rule. Returns null when the order
 * is not (yet, or no longer relevantly) in a state this job should touch.
 */
function computeDesiredState(
  doc: ReconcileCandidateRow,
  facts: OrderFacts,
): { status: string; payment_status: string } | null {
  const financial = (facts.financialStatus ?? "").trim().toLowerCase()
  if (financial !== "paid") return null // refunded/voided/pending/etc. — caller buckets the reason

  const fulfillment = (facts.fulfillmentStatus ?? "").trim().toLowerCase()
  const shipsPhysically = doc.scope !== "software"
  const isFulfilled = fulfillment === "fulfilled"
  // Two INDEPENDENT axes on the invoice list:
  //   - payment_status = "paid" (Shopify says the order is paid).
  //   - status         = FULFILLMENT: "fulfilled" once the order has shipped
  //     (or a software/digital line with nothing to ship), else "issued" (a
  //     paid-but-unshipped physical order stays "issued" so it remains in
  //     Boxtal's to-prepare ship queue, and flips to "fulfilled" on a later
  //     run once Shopify reports it shipped).
  // Only ever reached for a PAID order, so a "fulfilled" invoice is always paid
  // and never sits in the overdue/dunning scope (which is issued + unpaid).
  const status = !shipsPhysically || isFulfilled ? "fulfilled" : "issued"

  return { status, payment_status: "paid" }
}

/**
 * Readable internal entry point — the manifest job wraps this in the
 * kernel-shaped `(payload, ctx)` handler below. Scans issued Shopify invoices,
 * looks up each unique order's authoritative financial/fulfillment status via
 * `shopify:orders_get`, and reconciles `payment_status`/`status`/`paid_at`
 * only where they differ. Idempotent: a second run with unchanged Shopify
 * state makes no writes.
 */
export async function reconcileShopifyPayments(
  ctx: ReconcileCtx,
  opts?: { now?: Date; maxRerenders?: number },
): Promise<ReconcileResult> {
  const now = opts?.now ?? new Date()

  const rows = await ctx.db.findMany("documents", {
    where: { type: "invoice", status: "issued" },
    limit: 500,
  })
  // `channel: "shopify"` is a derived/read-side concept (see reads.ts
  // toDocumentHeader) rather than a stored column — a Shopify-synced invoice
  // is identified by carrying an order id, top-level or in external_refs.
  const candidates = rows.map(toCandidateRow)

  const result: ReconcileResult = {
    scanned: candidates.length,
    marked_paid: 0,
    marked_payment_only: 0,
    skipped_refunded: 0,
    skipped_unpaid: 0,
    pdf_rerendered: 0,
    errors: [],
  }
  let renderBudget = opts?.maxRerenders ?? MAX_RERENDERS_PER_RUN

  const byOrderId = new Map<string, ReconcileCandidateRow[]>()
  for (const doc of candidates) {
    const orderId = resolveOrderId(doc)
    if (!orderId) continue
    const bucket = byOrderId.get(orderId)
    if (bucket) bucket.push(doc)
    else byOrderId.set(orderId, [doc])
  }

  for (const [orderId, docs] of byOrderId) {
    let envelope: ReconcileCrossAppEnvelope
    try {
      envelope = await ctx.executeTool("shopify:orders_get", { id: toGid(orderId) })
    } catch (err) {
      result.errors.push({
        order_id: orderId,
        message: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (envelope.status !== "completed") {
      const message =
        envelope.status === "error"
          ? (envelope.error?.message ?? envelope.error?.code ?? "orders_get failed")
          : `orders_get returned status "${envelope.status}"`
      result.errors.push({ order_id: orderId, message })
      continue
    }

    const facts = extractOrderFacts(envelope.result)
    const financial = (facts.financialStatus ?? "").trim().toLowerCase()

    if (REFUNDED_FINANCIAL_STATUSES.has(financial)) {
      result.skipped_refunded += docs.length
      continue
    }

    const desired = computeDesiredState(docs[0]!, facts)
    if (!desired) {
      result.skipped_unpaid += docs.length
      continue
    }

    for (const doc of docs) {
      // Never re-mark a locally-refunded document paid — the refund webhook is
      // authoritative and may not yet be reflected in Shopify's orders_get.
      if (LOCALLY_REFUNDED_STATUSES.has(doc.payment_status)) {
        result.skipped_refunded += 1
        continue
      }
      // Per-document desired state — scope varies per document within an
      // order (a split goods+software order), so recompute per doc.
      const docDesired = computeDesiredState(doc, facts)!
      const statusChanged = doc.status !== docDesired.status
      const paymentChanged = doc.payment_status !== docDesired.payment_status
      if (!statusChanged && !paymentChanged) continue

      // Render-budget bound: a payment flip re-renders the PDF, so once the budget is spent DON'T
      // flip this doc — leave it un-reconciled so the next tick re-selects it and flips+renders it
      // together. This never loses a doc (its payment_status stays unchanged) and keeps the run
      // inside its timeout even on an unusually large backlog of late settlements.
      if (paymentChanged && ctx.pdf && renderBudget <= 0) continue

      // The order's own instant, as the issuer's date. An issuer whose zone the host does not know
      // stays un-reconciled and is reported: the next tick flips it once the zone is fixed.
      const [issuer] = (await ctx.db.findMany("issuer_profiles", {
        where: { id: doc.issuer_profile_id },
        limit: 1,
      })) as Array<{ timezone?: string | null }>
      const paid = await civilDateOf(
        ctx,
        issuer ?? {},
        facts.processedAt || facts.createdAt || now.toISOString(),
      )
      if (!paid.ok) {
        result.errors.push({
          order_id: orderId,
          message: paid.error.error.message ?? paid.error.error.code ?? "",
        })
        continue
      }

      const patch: Record<string, unknown> = {
        payment_status: docDesired.payment_status,
        paid_at: paid.date,
      }
      if (statusChanged) patch.status = docDesired.status
      patch.lifecycle_log = [
        ...doc.lifecycle_log,
        {
          event: "marked_paid",
          actor: "system",
          ts: now.toISOString(),
          source: "shopify_reconcile",
        },
      ]

      await ctx.db.update("documents", doc.id, patch)

      // Kernel audit trail — mirrors the marked_paid lifecycle_log entry just written above.
      // Optional: absent on the pure unit ctx that doesn't care about the audit trail.
      if (ctx.emit) {
        await ctx.emit({
          entity: "document",
          action: "paid",
          entityId: doc.id,
          data: {
            document_id: doc.id,
            type: doc.type,
            number: doc.number,
            status: (patch.status as string | undefined) ?? doc.status,
            currency: doc.currency,
            grand_total_minor: doc.grand_total_minor,
            paid_at: paid.date,
            payment_status: docDesired.payment_status,
          },
        })
      }

      if (statusChanged) result.marked_paid += 1
      else result.marked_payment_only += 1

      // Re-render the now-settled invoice so its PDF reads "Amount paid" (the row was just flipped
      // to payment_status="paid"; ensureDocumentPdf re-reads it fresh). link:false persists
      // pdf_file_id via the in-tx update (no host cross-tx link-write). Best-effort: a render
      // failure is recorded but never unwinds the payment reconciliation. Guarded by the budget
      // above so the total renders per run stay bounded.
      if (paymentChanged && ctx.pdf) {
        renderBudget -= 1
        try {
          const rendered = await ensureDocumentPdf({ db: ctx.db, pdf: ctx.pdf }, doc.id, {
            force: true,
            link: false,
          })
          if (rendered.ok) result.pdf_rerendered += 1
          else
            result.errors.push({
              order_id: orderId,
              message: `pdf re-render failed for ${doc.id}: ${rendered.error.code}`,
            })
        } catch (err) {
          result.errors.push({
            order_id: orderId,
            message: `pdf re-render threw for ${doc.id}: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }
    }
  }

  return result
}

/**
 * Manifest `jobs.reconcile-shopify-payments` handler. The kernel invokes job
 * handlers as `(payload, ctx)`; `reconcileShopifyPayments` keeps the readable
 * `(ctx, opts)` shape for its unit tests, so this kernel-shaped wrapper flips
 * to the internal call signature (mirrors overdueScanJobHandler).
 */
export async function reconcileShopifyPaymentsJobHandler(
  _payload: unknown,
  ctx: ReconcileCtx,
  opts?: { now?: Date },
): Promise<ReconcileResult> {
  return reconcileShopifyPayments(ctx, opts)
}
