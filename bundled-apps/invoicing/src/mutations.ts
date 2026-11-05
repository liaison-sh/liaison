// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E6 — Mutating tools (drafts + invoice issuance + lifecycle).
//
// Each tool exported here is registered in the manifest with an appropriate
// `gated`, `trustBoundary`, `approvalCard.summary`, and `editableFields`.
// Threshold-gated tools (invoice.issue, invoice.create_and_issue, po.issue,
// po.create_and_issue) handle the check at handler level — the manifest is
// not gated; the handler explicitly files an approval via `ctx.requestApproval`
// when amount > issuer.invoice_approval_threshold and ctx.approval is unset.
// On post-approval re-entry, the kernel populates `ctx.approval` and the
// handler skips the threshold check — single-approval path.
//
// Two-eyes: enforced inline in the handler. On post-approval re-entry, if
// the issuer profile has `require_two_eyes: true`, reject the mutation when
// the deciding actor is the same as the calling actor.
//
// Drafts are stored as `documents` rows with status='draft'. Their lines
// live in `document_lines` keyed on document_id. Issuance inserts a NEW
// `documents` row (the issued invoice) and then deletes the draft.
//
// The tools live in ./mutations/, one file per domain (shared types and envelopes, db
// helpers, credit coverage, drafts, line normalisation, invoice issuance, quote to invoice
// conversion, payments and refunds, send to customer, quote/proforma/PO issuance, Shopify quotes,
// credit notes, order reissue, customs and contact relationships, issuer profiles, PDFs, post-issue
// update). This index re-exports the public surface that handlers.ts registers and the tests import.

export {
  type DocumentType,
  type DraftInsert,
  type DraftRow,
  type DocumentRowSummary,
  type ErrorEnvelope,
  type PreflightResult,
  type CompletedEnvelope,
  type PendingApprovalEnvelope,
  type MutationResult,
  NOTES_MAX_LENGTH,
  normaliseNotes,
  type MutationsDb,
  type MutationsCtx,
} from "./mutations/shared"
export {
  readDraftOrderId,
} from "./mutations/db-helpers"
export {
  creditedTotalMinor,
  ISSUED_INVOICE_STATUSES,
  isFullyCredited,
  assertNoLiveInvoiceForOrder,
} from "./mutations/credit-coverage"
export {
  type DraftsCreateInput,
  draftsCreate,
  draftsCreateTool,
  draftsCreatePreflight,
  draftsUpdate,
  draftsUpdateTool,
  draftsUpdatePreflight,
  draftsDiscard,
} from "./mutations/drafts"
export {
  liftMisplacedHsCode,
  liftMisplacedCountry,
  liftMisplacedCountryOnLine,
  netLinesForIssuer,
  computeLineFinancials,
} from "./mutations/lines"
export {
  invoiceIssuePreflight,
  invoiceIssue,
  type InvoiceCreateAndIssueInput,
  invoiceCreateAndIssuePreflight,
  invoiceCreateAndIssue,
} from "./mutations/invoice-issue"
export {
  type ConvertToInvoiceResult,
  documentsConvertToInvoicePreflight,
  documentsConvertToInvoice,
} from "./mutations/convert-to-invoice"
export {
  documentsMarkPaidPreflight,
  documentsMarkPaid,
  documentsRecordRefundPreflight,
  documentsRecordRefund,
} from "./mutations/payments"
export {
  documentsSendToCustomerPreflight,
  documentsSendToCustomer,
  sendErrorFromEnvelope,
} from "./mutations/send-to-customer"
export {
  type GatingKind,
  quoteIssue,
  type QuoteCreateAndIssueInput,
  type CreateAndIssueRawInput,
  isUniqueViolation,
  type QuoteCreateAndIssueResult,
  quoteCreateAndIssue,
  quoteCreateAndIssuePreflight,
  quoteIssuePreflight,
  proformaIssuePreflight,
  proformaIssue,
  type ProformaCreateAndIssueInput,
  proformaCreateAndIssuePreflight,
  proformaCreateAndIssue,
  poIssue,
  poCreateAndIssue,
} from "./mutations/quote-proforma-po"
export {
  minorToMajorAmount,
  toShopifyDraftLines,
  type SplitPostalAddress,
  splitPostalAddress,
} from "./mutations/shopify-quote"
export {
  type CreditNoteCreateAndIssueInput,
  creditNoteCreateAndIssue,
  creditNoteCreateAndIssuePreflight,
  creditNoteIssue,
  creditNoteIssuePreflight,
} from "./mutations/credit-notes"
export {
  type OrderReissueApplyInput,
  type OrderReissueApplyResult,
  orderReissueApplyPreflight,
  orderReissueApply,
} from "./mutations/order-reissue"
export {
  type Relationship,
  type RelationshipSource,
  type ContactRelationshipRow,
  type ProductCustomsOverlayRow,
  type HsCodeLibraryRow,
  normalizeHsCode,
  hsCodesAssign,
  hsCodesLibraryUpsert,
  hsCodesLibraryDelete,
  type HsCodesUnassignField,
  hsCodesUnassign,
  contactRelationshipsSet,
  inferContactRelationshipOnIssue,
} from "./mutations/customs-relationships"
export {
  settingsIssuerProfileCreate,
  settingsIssuerProfileUpdate,
  settingsIssuerProfileDelete,
  settingsIssuerProfileWritePreflight,
} from "./mutations/issuer-profiles"
export {
  type DocumentRenderCtx,
  ensureDocumentPdf,
  documentsRetryPdf,
} from "./mutations/pdf"
export {
  type DocumentsUpdateInput,
  documentsUpdate,
  documentsUpdatePreflight,
  documentsUpdatePreview,
} from "./mutations/documents-update"
