// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D4 — Document state machines per spec §3.
//
// Pure transition table. Tools that mutate a document call `transition(doc, event)`
// and persist `next` only when status === "ok"; an `invalid_transition` result
// is the source-of-truth signal to refuse the operation.
//
// Overdue is computed (`status='issued' AND due_at < NOW()`), not stored —
// it does not appear in this table.

export type DocumentType = "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"

export interface DocumentForTransition {
  type: DocumentType
  status: string
}

export type TransitionResult = { status: "ok"; next: string } | { status: "invalid_transition" }

// Map keyed by `type:status:event`. Lookups failing fall back to invalid_transition.
// Exported so the manifest test can assert every PRODUCIBLE status (the right-hand values) is a valid
// documents.status enum value — a drift here makes the transition's UPDATE fail the CHECK constraint
// (e.g. 'invoiced' / 'pending_approval' were missing, so convert_to_invoice + submit_for_approval
// could never complete: handler_outcome_unknown 422 on the gated execution).
export const TABLE: Record<string, string> = {
  // Invoice
  "invoice:draft:issue": "issued",
  "invoice:draft:submit_for_approval": "pending_approval",
  "invoice:pending_approval:approve_issue": "issued",
  "invoice:pending_approval:reject": "draft",
  "invoice:issued:mark_paid": "paid",
  "invoice:issued:mark_refunded": "refunded",
  "invoice:paid:mark_refunded": "refunded",

  // Quote
  "quote:draft:send": "sent",
  "quote:sent:accept": "accepted",
  "quote:accepted:convert_to_invoice": "invoiced",
  // A quote lives in `sent` from the moment it is issued (a Shopify draft order is
  // exactly that: an open offer). Converting it is the normal next step, so `sent`
  // converts directly without a detour through `accepted`.
  "quote:sent:convert_to_invoice": "invoiced",
  "quote:sent:reject": "rejected",
  "quote:sent:expire": "expired",

  // Proforma
  "proforma:draft:send": "sent",
  "proforma:sent:convert_to_invoice": "invoiced",
  "proforma:sent:close": "closed",

  // Purchase order
  "purchase_order:draft:send": "sent",
  "purchase_order:sent:mark_received": "received",
  "purchase_order:sent:cancel": "cancelled",
  "purchase_order:draft:cancel": "cancelled",

  // Credit note — issues straight to 'issued' (create_and_issue path only,
  // no draft→issue step); it is NOT payable, so there is no mark_paid /
  // mark_refunded transition for it.
  "credit_note:draft:issue": "issued",
}

export function transition(doc: DocumentForTransition, event: string): TransitionResult {
  const next = TABLE[`${doc.type}:${doc.status}:${event}`]
  if (next === undefined) {
    return { status: "invalid_transition" }
  }
  return { status: "ok", next }
}
