// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Documents whose issue was interrupted after its commit (job `resume-interrupted-issues`).
//
// A sandboxed run holds no transaction across its calls: an issue commits its number, document
// and lines in one `ctx.db.batch` (issue.ts), then renders the PDF, posts it and (for a paid
// Shopify order) emails it as later steps. A run that dies in between leaves an issued, numbered
// document with `pdf_status: "pending"` and nothing after it. The order's redelivery would only
// find the document and stop (one invoice per order), so this job, woken for an org only while a
// document is pending, finishes what the dead run owed: it parks the render, and, for the paid
// order auto-flow (the only path that emails on its own), the email after it. The `deferred-retry`
// job then runs both parks the usual way (render first: the email waits for the PDF).
//
// Only documents pending for longer than any run can last are touched, so a run still in flight
// is never raced.

import { park } from "../deferred"
import type { MutationsCtx } from "../mutations"

/** Longer than the longest run that issues (a 120 s tool), with margin. */
export const INTERRUPTED_AFTER_MS = 10 * 60_000
/** Documents looked at per sweep. */
const SWEEP_LIMIT = 20

type Row = Record<string, unknown>

/** When the row last changed: a pending PDF is owed since then. */
function changedAtMs(doc: Row): number {
  const raw = doc.updated_at ?? doc.updatedAt ?? doc.created_at ?? doc.createdAt
  const at = raw instanceof Date ? raw.getTime() : Date.parse(String(raw ?? ""))
  return Number.isNaN(at) ? Number.NaN : at
}

/** Issued by the paid-order auto-flow, which emails the invoice itself. */
function autoEmailedOrderInvoice(doc: Row): boolean {
  if (doc.type !== "invoice" || typeof doc.shopify_order_id !== "string") return false
  const log = (doc.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? []
  return log.some((e) => e.event === "marked_paid" && e.source === "shopify_order_paid")
}

export async function parkInterruptedIssues(
  ctx: Pick<MutationsCtx, "db">,
  now: Date = new Date(),
): Promise<{ parked: number }> {
  const pending = (await ctx.db.findMany("documents", {
    where: { pdf_status: "pending" },
    orderBy: { updatedAt: "asc" },
    limit: SWEEP_LIMIT,
  })) as Row[]
  let parked = 0
  for (const doc of pending) {
    const at = changedAtMs(doc)
    if (Number.isNaN(at) || now.getTime() - at < INTERRUPTED_AFTER_MS) continue
    if (typeof doc.number !== "string" || doc.number === "") continue
    const id = String(doc.id)
    const eventId = typeof doc.shopify_order_id === "string" ? doc.shopify_order_id : id
    await park(
      { db: ctx.db },
      {
        event_id: eventId,
        event_payload_json: { document_id: id },
        status: "render_failed",
        reason: "issue_interrupted",
        blocked_on: { kind: "pdf_render", document_id: id },
      },
    )
    if (autoEmailedOrderInvoice(doc)) {
      const issuer = (await ctx.db.findOne("issuer_profiles", String(doc.issuer_profile_id))) as
        | Row
        | null
      if (
        issuer?.auto_email_enabled &&
        typeof issuer.shopify_shop_id === "string" &&
        typeof doc.counterparty_email === "string" &&
        doc.counterparty_email !== ""
      ) {
        await park(
          { db: ctx.db },
          {
            event_id: eventId,
            event_payload_json: {
              id: doc.shopify_order_id,
              shop_id: issuer.shopify_shop_id,
              customer: { email: doc.counterparty_email },
            },
            status: "email_failed",
            reason: "issue_interrupted",
            blocked_on: { kind: "email_send", document_id: id },
          },
        )
      }
    }
    // Marked last: a sweep that dies before this parks again next time (a park is refreshed, never
    // doubled), and once marked the document is not pending any more, so the job stops waking.
    await ctx.db.update("documents", id, { pdf_status: "failed" })
    parked++
  }
  return { parked }
}

/** Manifest `jobs.resume-interrupted-issues` handler (kernel `(payload, ctx)` shape). */
export async function resumeInterruptedIssuesJobHandler(
  _payload: unknown,
  ctx: Pick<MutationsCtx, "db">,
  opts?: { now?: Date },
): Promise<{ parked: number }> {
  return parkInterruptedIssues(ctx, opts?.now)
}
