// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Seed rows and the issue-pipeline ctx shared by the real-engine credit-note
// tests of the Shopify order handlers (shopify-order-cancelled.test.ts and
// shopify-refund-credit-note.test.ts): they run the ACTUAL
// creditNoteCreateAndIssue pipeline against the in-memory mock db.

import type { MutationsCtx } from "../mutations"
import type { MockDb } from "../test-db"
import { testTime } from "../test-time"

export const ISSUER_ROW = {
  id: "iss-1",
  legal_name: "Acme SAS",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue Test",
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

/** An issued, unpaid USD export invoice for Shopify order ORD-1; `over` replaces any field. */
export function invoiceRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "invoice",
    scope: "goods",
    status: "issued",
    payment_status: "unpaid",
    number: "INV-2026-0001",
    number_int: 1,
    year_of_issue: 2026,
    issuer_profile_id: "iss-1",
    counterparty_contact_id: "contact-1",
    counterparty_name: "Jane Buyer",
    counterparty_address: "10 Main St",
    counterparty_vat_id: null,
    counterparty_email: "jane@example.com",
    counterparty_country: "US",
    currency: "USD",
    subtotal_minor: "0",
    tax_total_minor: "0",
    grand_total_minor: "0",
    tax_treatment: "eu_export_non_eu",
    incoterm: "DAP",
    shopify_order_id: "ORD-1",
    external_refs: {},
    lifecycle_log: [{ event: "issued" }],
    ...over,
  }
}

export function lineRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    position: 1,
    description: "Item",
    quantity: "1.000",
    unit_price_minor: "0",
    discount_minor: "0",
    line_kind: "goods",
    tax_rate_bp: 0,
    subtotal_minor: "0",
    tax_minor: "0",
    total_minor: "0",
    hs_code: "854389",
    country_of_origin: "FR",
    customs_description: "Electronic controller",
    product_source: "shopify",
    external_id: "gid://shopify/ProductVariant/1",
    ...over,
  }
}

/**
 * The issue-pipeline half of the kernel-injected event ctx, backed by `db`:
 * numbering through an in-mock-db `__sequences` table, stub PDF render, message
 * post, approval request and tool call. The caller adds `db` typed as its
 * handler's narrower db interface.
 */
export function issuePipelineCtx(db: MockDb): {
  getUserId(): Promise<string>
  emit(): Promise<void>
  time: MutationsCtx["time"]
  pdf: MutationsCtx["pdf"]
  messages: MutationsCtx["messages"]
  requestApproval: MutationsCtx["requestApproval"]
  executeTool: MutationsCtx["executeTool"]
} {
  let idSeq = 0
  return {
    getUserId: async () => "system",
    // The kernel always injects `emit` alongside the rest of the issue pipeline
    // (creditNoteCreateAndIssue's kernel audit trail calls it unconditionally).
    // Without it, the SECOND credit note in a split-order full refund never
    // gets created: the first credit note's document row is written by
    // issueDocument, but the following `await ctx.emit(...)` throws (emit is
    // undefined), and that throw escapes the whole autoIssueRefundCreditNotes
    // loop, silently dropping every target still queued behind it.
    emit: async () => {},
    time: testTime(),
    pdf: {
      async render() {
        return {
          file_id: `pdf-${++idSeq}`,
          byte_size: 1024,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: {
      async post() {
        return { message_id: `msg-${++idSeq}` }
      },
    },
    requestApproval: async () => ({ approval_id: `appr-${++idSeq}` }),
    executeTool: async () => ({ status: "completed", result: {} }),
  }
}
