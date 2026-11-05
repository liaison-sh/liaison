// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task G1 — Daily overdue-document scan job.
//
// Manifest-declared cron job `jobs.overdue-scan` (every day). Iterates
// issued documents whose `due_at < now()` and `payment_status != 'paid'`,
// emits one attention entry per overdue document.

import { formatMoneyMinor } from "../money"

export interface OverdueDocumentRow {
  id: string
  type: string
  number: string | null
  status: string
  payment_status: string
  due_at: string | null
  grand_total_minor: string | number
  currency: string
  counterparty_contact_id: string | null
}

export interface OverdueScanDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      limit?: number
    },
  ): Promise<unknown[]>
}

export interface OverdueScanCtx {
  db: OverdueScanDb
  // The real SDK channel for attention: emit a declared event mapped by the
  // manifest rule `invoicing:document_overdue` to an attention item.
  emit(event: {
    entity: string
    action: string
    entityId?: string
    data?: unknown
    metadata?: Record<string, unknown>
  }): Promise<void>
}

export interface OverdueScanResult {
  scanned: number
  emitted: number
  /** Past-due invoices found PAID this scan, for which a resolving event was
   *  emitted to clear their stale "overdue" attention row. */
  resolved: number
}

function daysBetween(a: Date, b: Date): number {
  const ms = a.getTime() - b.getTime()
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}

function toOverdueRow(row: unknown): OverdueDocumentRow {
  const r = row as Record<string, unknown>
  return {
    id: String(r.id),
    type: String(r.type ?? "invoice"),
    number: (r.number as string | null) ?? null,
    status: String(r.status ?? "draft"),
    payment_status: String(r.payment_status ?? "unpaid"),
    due_at: (r.due_at as string | null) ?? null,
    grand_total_minor: (r.grand_total_minor as string | number) ?? "0",
    currency: String(r.currency ?? "EUR"),
    counterparty_contact_id:
      (r.counterparty_contact_id as string | null) ?? null,
  }
}

export async function overdueScanJob(
  ctx: OverdueScanCtx,
  opts?: { now?: Date },
): Promise<OverdueScanResult> {
  const now = opts?.now ?? new Date()
  // Fetch issued documents and filter the rest client-side. payment_status
  // and due_at < now both need operator/comparison support the generic
  // bridge lacks; we widen by equality on status='issued' and filter.
  const rows = await ctx.db.findMany("documents", {
    where: { status: "issued" },
    limit: 1000,
  })
  const docs = rows.map(toOverdueRow)

  let emitted = 0
  let resolved = 0
  for (const doc of docs) {
    // Credit notes (and any other non-payable type) are NOT payable and must never enter the
    // overdue scan — they issue straight to 'issued' with no due date, but this is an explicit
    // belt-and-braces type gate rather than relying solely on the absent due_at below.
    if (doc.type !== "invoice") continue
    if (!doc.due_at) continue
    const due = new Date(doc.due_at)
    const overdueDays = daysBetween(now, due)

    // Resolution. An overdue attention row is written once, at scan time, and
    // then NEVER revisited: paying the invoice simply stopped this scan from
    // re-emitting, so the row sat in the feed claiming the invoice was late long
    // after the money arrived. Emit the SAME event with days_overdue 0 for an
    // invoice that WAS overdue and is now paid; the manifest translation's
    // `resolveWhen {days_overdue: 0}` marks that document's row read.
    //
    // Deliberately narrow — only a past-due PAID invoice, never every paid
    // invoice in the ledger — so a large paid history costs no extra events.
    if (doc.payment_status === "paid") {
      if (overdueDays <= 0) continue
      await ctx.emit({
        entity: "detail",
        action: "document_overdue",
        entityId: doc.id,
        data: {
          document_id: doc.id,
          number: doc.number,
          due_at: doc.due_at,
          days_overdue: 0,
          grand_total_minor: String(doc.grand_total_minor),
          grand_total_display: formatMoneyMinor(doc.grand_total_minor, doc.currency),
          currency: doc.currency,
          counterparty_contact_id: doc.counterparty_contact_id,
        },
      })
      resolved += 1
      continue
    }
    if (overdueDays <= 0) continue

    // `entity: "detail"` anchors the attention item to the document detail tab
    // (`invoicing:detail`); the frontend deep-links by opening tab type
    // `<app>:<entity>`. See shopify-order-updated.ts for the full rationale.
    await ctx.emit({
      entity: "detail",
      action: "document_overdue",
      entityId: doc.id,
      data: {
        document_id: doc.id,
        number: doc.number,
        due_at: doc.due_at,
        days_overdue: overdueDays,
        grand_total_minor: String(doc.grand_total_minor),
        // Pre-formatted human amount for the attention summary template: the
        // manifest string interpolation can't run the currency-exponent
        // formatter, so raw minor units (and the word "minor") must never be
        // the value it renders. formatMoneyMinor applies the ISO 4217 exponent
        // (JPY has no minor unit) and appends the code.
        grand_total_display: formatMoneyMinor(doc.grand_total_minor, doc.currency),
        currency: doc.currency,
        counterparty_contact_id: doc.counterparty_contact_id,
      },
    })
    emitted += 1
  }

  return { scanned: docs.length, emitted, resolved }
}

/**
 * Manifest `jobs.overdue-scan` handler. The kernel invokes job handlers as
 * `(payload, ctx)` (see the header of `handlers.ts`), but `overdueScanJob` keeps
 * the readable `(ctx, opts)` signature for its unit tests — bound directly as
 * the manifest handler it would receive the payload as `ctx` and dereference a
 * `db`-less object. This kernel-shaped wrapper flips to the internal shape.
 */
export async function overdueScanJobHandler(
  _payload: unknown,
  ctx: OverdueScanCtx,
  opts?: { now?: Date },
): Promise<OverdueScanResult> {
  return overdueScanJob(ctx, opts)
}
