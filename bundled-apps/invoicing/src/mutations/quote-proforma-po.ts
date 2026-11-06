// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: quote, proforma and purchase order issuance (issue from a draft with
// threshold gating, and the generic create and issue path).

import {
  type Counterparty,
  type DraftLine,
  type DraftLineInput,
  issueDocument,
  counterpartyCompletenessError,
  taxCountryOf,
} from "../issue"
import type { ClassifyInput } from "../tax"
import {
  type IssuerProfileRow,
  findIssuerProfile,
  deleteDraftRow,
  getDraft,
  resolveIssuerProfileOrError,
} from "./db-helpers"
import {
  checkTwoEyes,
  counterpartyFromRow,
  computeLineFinancials,
  buildIssueInputFromDraft,
  normaliseDraftLines,
  netLinesForIssuer,
} from "./lines"
import {
  type MutationsCtx,
  type DraftRow,
  type DocumentType,
  type ErrorEnvelope,
  type MutationResult,
  type MutationsDb,
  type PreflightResult,
  toBigInt,
  normaliseNotes,
  lineAmountsError,
  toPreflightResult,
  lineDiscountError,
  normaliseCustomerReference,
} from "./shared"
import { quoteCreateViaShopifyDraftOrder } from "./shopify-quote"
import { asHandlerSummary, issueCard } from "../approval-cards"
import { type BuyerVatFacts, checkBuyerVat, needsHumanBuyerDecision } from "../buyer-vat"
import { issueDateParts } from "../issue-date"
import { planTax } from "../tax-plan"

// ── Quote / Proforma / PO issuance (E7) ──────────────────────────────────

/**
 * Read-only validation shared by `issueFromDraftWithGating` and the stage-time preflight exports
 * of the tools that funnel through it: the draft is of the expected type, carries lines, its
 * issuer exists and its recipient snapshot is complete. ONE copy, called from both sides, so the
 * staged refusal and the executed refusal can never drift apart.
 */
async function preflightIssueFromDraft(
  ctx: MutationsCtx,
  draft: DraftRow,
  expectedType: DocumentType,
): Promise<
  | { ok: true; issuer: IssuerProfileRow; counterparty: Counterparty; buyer: BuyerVatFacts | null }
  | { ok: false; error: ErrorEnvelope }
> {
  if (draft.type !== expectedType) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_type",
          message: `expected draft.type=${expectedType}, got ${draft.type}`,
        },
      },
    }
  }
  if (!draft.lines || draft.lines.length === 0) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "empty_document",
          message: `cannot issue a ${expectedType} with no line items: add at least one line first (pass \`items\` to drafts_create, or \`lines\` to drafts_update) before issuing`,
        },
      },
    }
  }
  const issuer = await findIssuerProfile(ctx.db, draft.issuer_profile_id)
  if (!issuer) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "issuer_not_found",
          message: `issuer_profile ${draft.issuer_profile_id} not found`,
        },
      },
    }
  }
  const twoEyesErr = await checkTwoEyes(ctx, issuer)
  if (twoEyesErr) return { ok: false, error: twoEyesErr }

  // Use the same counterparty issueDocument will persist below so the classifier — and
  // therefore the grand total — is identical at gate time and at persistence time.
  const counterparty = counterpartyFromRow(draft, issuer)
  const draftIncompleteErr = counterpartyCompletenessError(counterparty)
  if (draftIncompleteErr) {
    return { ok: false, error: { status: "error", error: draftIncompleteErr } }
  }
  if (expectedType !== "purchase_order") {
    const buyer = await checkDraftBuyer(ctx, draft, issuer, counterparty)
    if (!buyer.ok) return buyer
    return { ok: true, issuer, counterparty: buyer.counterparty, buyer: buyer.buyer }
  }
  return { ok: true, issuer, counterparty, buyer: null }
}

/**
 * The intra-EU business-buyer guard (buyer-vat.ts) on a saved draft about to be issued: the
 * consumer override the draft recorded is honoured, and a VAT number an earlier document for the
 * same buyer carries is filled in on the counterparty that gets issued.
 */
export async function checkDraftBuyer(
  ctx: MutationsCtx,
  draft: DraftRow,
  issuer: IssuerProfileRow,
  counterparty: Counterparty,
): Promise<{ ok: true; counterparty: Counterparty; buyer: BuyerVatFacts } | { ok: false; error: ErrorEnvelope }> {
  const r = await checkBuyerVat(ctx, {
    issuerCountry: issuer.country,
    taxCountry: taxCountryOf(counterparty),
    counterparty: { ...counterparty, customer_kind: counterparty.customer_kind ?? draft.customer_kind ?? null },
    buyerIsConsumer: draft.external_refs?.buyer_is_consumer === true,
    excludeDocumentId: draft.id,
  })
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    counterparty: r.facts.vat_id && !counterparty.vat_id ? { ...counterparty, vat_id: r.facts.vat_id } : counterparty,
    buyer: r.facts,
  }
}

async function issueFromDraftWithGating(
  ctx: MutationsCtx,
  draft: DraftRow,
  expectedType: DocumentType,
  toolName: string,
  gatingKind: GatingKind,
): Promise<MutationResult<{ document_id: string; number: string }>> {
  const pre = await preflightIssueFromDraft(ctx, draft, expectedType)
  if (!pre.ok) return pre.error
  const { issuer, counterparty, buyer } = pre
  const gatingClassifyInput: ClassifyInput = {
    issuer_country: issuer.country,
    counterparty_country: counterparty.country,
    has_vat_id: !!counterparty.vat_id,
  }
  const { grand: total } = computeLineFinancials(draft.lines, gatingClassifyInput)
  const threshold = pickThreshold(issuer, gatingKind)
  // A consumer the agent declared against business evidence is decided by a person (buyer-vat.ts).
  const humanBuyer = needsHumanBuyerDecision(buyer)
  const mustGate = computeMustGate(gatingKind, total, threshold) || humanBuyer
  if (!ctx.approval && mustGate) {
    const approval = await ctx.requestApproval({
      tool_name: toolName,
      ...asHandlerSummary(
        issueCard({
          kind: toolName.replace(/^invoicing:/, ""),
          type: expectedType,
          fromDraft: true,
          buyer,
          customer: counterparty.legal_name,
          country: counterparty.country,
          currency: draft.currency,
          lines: draft.lines,
          totalMinor: total,
          orderNumber: draft.shopify_order_number ?? null,
          poNumber: draft.po_number ?? null,
          dueAt: draft.due_at ?? null,
          issuerName: issuer.legal_name,
          draftId: draft.id,
        }),
      ),
      current_payload: { draft_id: draft.id },
      editable_fields: ["lines"],
      // An auto-approve policy the org set for this tool may approve it: then carry on. Never a
      // consumer declared against evidence: that one is a person's call.
      auto_approvable: gatingKind === "conditional_po" && !humanBuyer,
    })
    if (!approval.auto_approved) {
      return { status: "pending_approval", approval_id: approval.approval_id }
    }
  }
  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) return when.error
  const issueInput = buildIssueInputFromDraft(draft, issuer, counterparty, when)
  const result = await issueDocument(ctx, issueInput)
  await deleteDraftRow(ctx.db, draft.id)
  return {
    status: "completed",
    document_id: result.document_id,
    number: result.number,
  }
}

/**
 * How a create/issue path decides whether to park an approval card.
 *   always              -- every call gates (legal issuance an agent must not self-serve)
 *   conditional_invoice -- gates above the issuer's invoice threshold
 *   conditional_po      -- gates above the issuer's purchase-order threshold
 *   none                -- never gates. Reserved for calls whose approval already happened
 *                          somewhere else: the Shopify draft-order sync mirrors a decision a
 *                          human already made in Shopify, so parking a second card there
 *                          would strand the quote behind an approval nobody expects.
 */
export type GatingKind = "always" | "conditional_invoice" | "conditional_po" | "none"

function pickThreshold(
  issuer: {
    invoice_approval_threshold_minor?: string | number | null
    po_approval_threshold_minor?: string | number | null
  },
  gatingKind: GatingKind,
): bigint | null {
  let raw: string | number | null | undefined
  if (gatingKind === "conditional_invoice")
    raw = issuer.invoice_approval_threshold_minor
  else if (gatingKind === "conditional_po")
    raw = issuer.po_approval_threshold_minor
  else return null
  if (raw == null) return null
  return toBigInt(raw)
}

function computeMustGate(
  gatingKind: GatingKind,
  total: bigint,
  threshold: bigint | null,
): boolean {
  if (gatingKind === "always") return true
  if (gatingKind === "none") return false
  // A purchase order is an outbound commitment: an unset threshold means threshold 0 (always approve).
  if (gatingKind === "conditional_po") return threshold == null || total > threshold
  return threshold != null && total > threshold
}

export async function quoteIssue(
  ctx: MutationsCtx,
  input: { draft_id: string },
): Promise<MutationResult<{ document_id: string; number: string }>> {
  const draft = await getDraft(ctx.db, input.draft_id)
  if (!draft) {
    return {
      status: "error",
      error: { code: "not_found", message: `draft ${input.draft_id} not found` },
    }
  }
  return issueFromDraftWithGating(
    ctx,
    draft,
    "quote",
    "invoicing:quote_issue",
    "always",
  )
}

export interface QuoteCreateAndIssueInput {
  counterparty: Counterparty
  /** When omitted, defaults to the org's sole issuer profile; a typed error is
   *  returned if the org has zero or several (see resolveIssuerProfileOrError). */
  issuer_profile_id?: string | null
  currency: string
  incoterm?: string
  due_at?: string | null
  items: DraftLineInput[]
  /** The Shopify draft order this quote mirrors ("gid://shopify/DraftOrder/123").
   *  Set by the `draft_order:*` sync (and by the Shopify create path once the draft
   *  order exists); it is the idempotency key, so a replayed event returns the
   *  existing quote instead of issuing a second one. */
  shopify_draft_order_id?: string | null
  /** The human draft order reference ("#D12"). */
  shopify_draft_order_name?: string | null
  /** The customer's purchase order number, when they gave one. Printed as a "PO number" line
   *  on the document PDF (except purchase_order documents, which already ARE a purchase
   *  order) and indexed for documents_search. Shared by quote/proforma/po create_and_issue,
   *  which all funnel through createAndIssueGenerically. */
  po_number?: string | null
  /** Free-text notes printed on the document PDF under the totals (contract reference, extra
   *  customs information, a special mention). Non financial: trimmed, blank becomes null, and
   *  refused past NOTES_MAX_LENGTH characters. Stays editable after issue via documents_update. */
  notes?: string | null
  /** The caller's own reference for this customer in another system (e.g. their CRM record id).
   *  Printed on the PDF as a "Customer ref" line and returned by documents_get. Stored on
   *  `external_refs.customer_reference`: trimmed, blank becomes null, refused past
   *  CUSTOMER_REFERENCE_MAX_LENGTH characters. */
  customer_reference?: string | null
  /** INTERNAL, caller scoped, never a manifest param (same pattern as `lines_are_net` and
   *  DocumentsUpdateInput.po_number_source) — labels the `po_number_changed` audit entry
   *  issueDocument appends. Set to "shopify_sync" by the draft-order sync when the quote's PO
   *  number came straight off the draft order; every manifest-exposed caller defaults to
   *  "person" (a human decision, even when relayed by an agent). */
  po_number_source?: "shopify_sync" | "person"
  /** The caller states the intra-EU buyer is a private CONSUMER (EU VAT of the destination, OSS)
   *  although the org's data suggests a business. Shown on the approval card; recorded on
   *  `external_refs.buyer_is_consumer`. Never combined with `counterparty.vat_id`. */
  buyer_is_consumer?: boolean | null
}

/** The loose wire shape every create-and-issue path accepts, before normalisation. */
export type CreateAndIssueRawInput = QuoteCreateAndIssueInput & {
  reason?: string
  declared_value_minor?: bigint
  shopify_order_id?: string | null
  /** The order's HUMAN name ("#1149"), printed on the document and indexed for search. */
  shopify_order_number?: string | null
  shipment_ref?: string | null
  /** INTERNAL, caller scoped (same pattern as DocumentsUpdateInput.po_number_source) — labels
   *  the po_number_changed audit entry issueDocument appends when po_number is set. Not a
   *  manifest param; set by the Shopify draft-order sync when the quote's PO number came
   *  straight off the draft order with no human step in between. */
  po_number_source?: "shopify_sync" | "person"
}

/**
 * Read-only validation shared by `createAndIssueGenerically` and the stage-time preflight exports
 * of the tools that funnel through it: recipient completeness, notes length, the idempotency
 * lookups (a repeat call resolves to the EXISTING document rather than an error) and issuer
 * resolution. ONE copy, called from both sides, so the staged refusal and the executed refusal can
 * never drift apart.
 */
async function preflightCreateAndIssueParams(
  ctx: MutationsCtx,
  type: DocumentType,
  rawInput: CreateAndIssueRawInput,
): Promise<
  | { ok: true; existing: { document_id: string; number: string } }
  | {
      ok: true
      existing?: undefined
      input: Omit<CreateAndIssueRawInput, "items"> & { items: DraftLine[] }
      notes: { value: string | null | undefined }
      customerReference: string | null
      issuer: IssuerProfileRow
      currency: string
      buyer: BuyerVatFacts
    }
  | { ok: false; error: ErrorEnvelope }
> {
  // Recipient completeness — refuse BEFORE idempotency lookups, gating and number allocation, so
  // an incomplete recipient never parks an approval card or consumes a document number. The tool's
  // JSON Schema already requires these fields, so this catches the in-process / cross-app callers
  // that bypass Ajv.
  const counterpartyErr = counterpartyCompletenessError(rawInput.counterparty)
  if (counterpartyErr) {
    return { ok: false, error: { status: "error", error: counterpartyErr } }
  }
  // Free-text notes, validated BEFORE gating so an over-long note never parks an approval card
  // or consumes a document number: trimmed, blank becomes null, over the cap is a typed error.
  const notes = normaliseNotes(rawInput.notes)
  if (!notes.ok) return { ok: false, error: notes.error }
  // A price that is not a plain number ("$1") is refused here, before gating, never read as 0.
  const amountsErr = lineAmountsError(rawInput.items)
  if (amountsErr) return { ok: false, error: amountsErr }
  // A discount below 0 or above its own line is refused here too, naming the line and the range.
  const discountErr = lineDiscountError(rawInput.items)
  if (discountErr) return { ok: false, error: discountErr }
  const customerReference = normaliseCustomerReference(rawInput.customer_reference)
  if (!customerReference.ok) return { ok: false, error: customerReference.error }
  // Wire payloads deliver bigint fields as strings (JSON); coerce at the boundary.
  // items defaults to [] so callers that omit it don't crash on .map().
  const input = {
    ...rawInput,
    items: normaliseDraftLines(rawInput.items ?? []),
  }
  // IDEMPOTENCY (draft order) — a quote and its Shopify draft order are ONE object, so the
  // draft order gid is checked FIRST, before anything else touches the database. Both event
  // producers (webhook and tool) can deliver the same create twice, and the `documents`
  // partial UNIQUE on shopify_draft_order_id is the backstop underneath this read (see the
  // insert-time recovery below): the read converges the common case, the constraint converges
  // the concurrent one.
  if (input.shopify_draft_order_id) {
    const existingQuote = await findByDraftOrderId(ctx.db, input.shopify_draft_order_id)
    if (existingQuote) {
      return {
        ok: true,
        existing: {
          document_id: String(existingQuote.id),
          number: String(existingQuote.number ?? ""),
        },
      }
    }
  }
  // IDEMPOTENCY — when the caller links a shopify_order_id, ONE document per
  // (shopify_order_id, scope, shipment_ref) for this document type (the same
  // pattern the shopify-order-paid handler uses). A repeat call for the same
  // shipment batch (or the same NULL-ref whole-order document) returns the
  // EXISTING document instead of re-issuing, so a looping agent or a retried
  // webhook converges. Distinct shipment_ref values legitimately coexist: one
  // proforma per physical shipment batch of the same order.
  // A replay converges ONLY when it carries the same content. A call for the same key whose
  // lines or currency differ is a request to CHANGE the document, which this tool cannot do:
  // answering "completed" with the untouched document told the caller the change was made when
  // nothing happened. It is refused instead, here, so the stage-time preflight refuses it too and
  // no approval card is parked for a call that could only no-op.
  if (input.shopify_order_id) {
    const wantedRef = input.shipment_ref ?? null
    const existing = (await ctx.db.findMany("documents", {
      where: { shopify_order_id: input.shopify_order_id },
      limit: 50,
    })) as Array<Record<string, unknown>>
    const match = existing.find(
      (r) =>
        r.type === type &&
        ((r.shipment_ref as string | null) ?? null) === wantedRef,
    )
    if (match) {
      const differs = await existingContentDiffers(ctx, match, input)
      if (differs) {
        const number = String(match.number ?? "")
        const label = number || String(match.id)
        return {
          ok: false,
          error: {
            status: "error",
            error: {
              code: "already_exists_different_content",
              message:
                `${type.replace("_", " ")} ${label} (document id ${String(match.id)}) already exists for ` +
                `this order${wantedRef ? ` and shipment_ref "${wantedRef}"` : ""}, with different ${differs}. ` +
                `Nothing was created or changed. To change the amount or the lines, edit ${label} in ` +
                `place: documents_update with id ${String(match.id)} and the full new \`lines\` (an issued ` +
                `${type.replace("_", " ")} stays editable). Only shipment_ref distinguishes a second document ` +
                `for the same shopify_order_id: shopify_order_number, reason and notes do not, so changing ` +
                `them lands on ${label} again. Pass a distinct shipment_ref ONLY for a genuinely separate ` +
                `physical shipment of the same order, never to work around this refusal.`,
              retryable: false,
              body: { document_id: String(match.id), number },
            },
          },
        }
      }
      return {
        ok: true,
        existing: {
          document_id: String(match.id),
          number: String(match.number ?? ""),
        },
      }
    }
  }
  // Killer-path tools may omit `issuer_profile_id` / `currency` (the agent issues
  // a proforma in one call). Resolve the issuer safely: default only when the org
  // has exactly one profile, otherwise a typed ambiguous/none error — never a NULL
  // that 23502s at insert. EUR fallback for the currency.
  const issuerResolution = await resolveIssuerProfileOrError(ctx.db, input.issuer_profile_id)
  if (!issuerResolution.ok) return { ok: false, error: issuerResolution.error }
  const issuer = issuerResolution.issuer
  const currency = input.currency ?? "EUR"
  const twoEyesErr = await checkTwoEyes(ctx, issuer)
  if (twoEyesErr) return { ok: false, error: twoEyesErr }
  // Business or consumer, for an intra-EU buyer: refused with the evidence when the org's data
  // says business and no VAT number was given; a number found on an earlier document is filled in.
  // A purchase order is the supplier's document, and a Shopify draft-order mirror carries the tax
  // Shopify already decided: neither is ours to classify here.
  const buyerCheck =
    type === "purchase_order" || input.shopify_draft_order_id
      ? null
      : await checkBuyerVat(ctx, {
          issuerCountry: issuer.country,
          taxCountry: taxCountryOf(input.counterparty),
          counterparty: input.counterparty,
          buyerIsConsumer: input.buyer_is_consumer,
        })
  if (buyerCheck && !buyerCheck.ok) return { ok: false, error: buyerCheck.error }
  const buyer = buyerCheck?.facts ?? NO_BUYER_FACTS
  if (buyer.vat_id && !input.counterparty.vat_id) {
    input.counterparty = { ...input.counterparty, vat_id: buyer.vat_id }
  }
  return { ok: true, input, notes, customerReference: customerReference.value ?? null, issuer, currency, buyer }
}

const NO_BUYER_FACTS: BuyerVatFacts = {
  applies: false,
  vat_id: null,
  vat_id_source: null,
  prior_document_number: null,
  vies: null,
  vies_name: null,
  vies_address: null,
  vies_name_mismatch: false,
  buyer_is_consumer: false,
  consumer_override_evidence: [],
  vat_candidates: [],
  business_unverified: null,
}

async function createAndIssueGenerically(
  ctx: MutationsCtx,
  type: DocumentType,
  toolName: string,
  gatingKind: GatingKind,
  rawInput: CreateAndIssueRawInput,
): Promise<CreateAndIssueResult> {
  // The issuer-resolution and idempotency lookups below ALSO run at stage time (the preflight
  // exports share this exact code), but they stay here: an issuer profile can be added and a
  // twin document can be issued between staging and approval, so the executed call re-checks.
  const pre = await preflightCreateAndIssueParams(ctx, type, rawInput)
  if (!pre.ok) return pre.error
  if (pre.existing) {
    return completedIssueResult(ctx.db, pre.existing.document_id, pre.existing.number)
  }
  const { input, notes, customerReference, issuer, currency, buyer } = pre

  const genericClassifyInput: ClassifyInput = {
    issuer_country: issuer.country,
    counterparty_country: taxCountryOf(input.counterparty),
    has_vat_id: !!input.counterparty.vat_id,
  }
  // The card states what will be issued, computed from the lines AS TYPED (before netting).
  const taxPlan =
    type === "purchase_order"
      ? null
      : planTax({
          issuerCountry: issuer.country,
          pricesIncludeTax: issuer.prices_include_tax === true,
          taxCountry: genericClassifyInput.counterparty_country,
          hasVatId: genericClassifyInput.has_vat_id,
          lines: input.items,
          linesAreNet: !!input.shopify_draft_order_id,
        })
  // Typed prices are gross under an issuer with prices_include_tax: divide the included tax out
  // BEFORE the threshold gate, so the amount on the approval card is the amount that gets issued.
  // The draft-order sync path (shopify_draft_order_id already set) is excluded: those lines were
  // netted by draftOrderLinesToItems already.
  if (!input.shopify_draft_order_id) {
    input.items = netLinesForIssuer(input.items, issuer, genericClassifyInput)
  }
  const { grand: total } = computeLineFinancials(input.items, genericClassifyInput)
  const threshold = pickThreshold(issuer, gatingKind)
  // A consumer the agent declared against business evidence is decided by a person, below the
  // threshold too (a quote's conditional gate included): buyer-vat.ts.
  const humanBuyer = needsHumanBuyerDecision(buyer)
  const mustGate = computeMustGate(gatingKind, total, threshold) || humanBuyer
  if (!ctx.approval && mustGate) {
    const approval = await ctx.requestApproval({
      tool_name: toolName,
      ...asHandlerSummary(
        issueCard({
          kind: toolName.replace(/^invoicing:/, ""),
          type,
          fromDraft: false,
          customer: input.counterparty.legal_name,
          country: input.counterparty.country,
          tax: taxPlan,
          taxCountry: genericClassifyInput.counterparty_country,
          buyer,
          currency,
          lines: input.items,
          totalMinor: total,
          orderNumber: input.shopify_order_number ?? null,
          draftOrderName: input.shopify_draft_order_name ?? null,
          poNumber: input.po_number ?? null,
          customerReference: input.customer_reference ?? null,
          dueAt: input.due_at ?? null,
          reason: input.reason ?? null,
          declaredValueMinor: input.declared_value_minor,
          issuerName: issuer.legal_name,
        }),
      ),
      // Original wire payload (string money), not the normalised one: it crosses
      // the JSON bridge and is persisted as the approval's re-entry params.
      // Normalised lines carry bigint `unit_price_minor`, which is not
      // JSON-serialisable; the tool re-normalises on re-entry.
      current_payload: rawInput,
      editable_fields: ["items", "declared_value_minor"],
      // An auto-approve policy the org set for this tool may approve it: then carry on. Never a
      // consumer declared against evidence: that one is a person's call.
      auto_approvable: gatingKind === "conditional_po" && !humanBuyer,
    })
    if (!approval.auto_approved) {
      return { status: "pending_approval", approval_id: approval.approval_id }
    }
  }
  const externalRefs: Record<string, unknown> = {}
  if (input.reason) externalRefs.reason = input.reason
  if (buyer.buyer_is_consumer) externalRefs.buyer_is_consumer = true
  if (input.declared_value_minor != null)
    externalRefs.declared_value_minor = input.declared_value_minor.toString()
  // issueDocument mirrors these two onto the top-level indexed columns, which
  // carry the (shopify_order_id, scope, shipment_ref) uniqueness backstop.
  if (input.shopify_order_id) externalRefs.shopify_order_id = input.shopify_order_id
  if (input.shopify_order_number)
    externalRefs.shopify_order_number = input.shopify_order_number
  if (input.shipment_ref) externalRefs.shipment_ref = input.shipment_ref
  // Mirrored onto the top-level shopify_draft_order_id/_name columns by issueDocument.
  if (input.shopify_draft_order_id)
    externalRefs.shopify_draft_order_id = input.shopify_draft_order_id
  if (input.shopify_draft_order_name)
    externalRefs.shopify_draft_order_name = input.shopify_draft_order_name
  if (input.po_number) externalRefs.po_number = input.po_number
  if (customerReference) externalRefs.customer_reference = customerReference
  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) return when.error
  const issueInput = {
    type,
    issuer,
    counterparty: input.counterparty,
    // A quote is a live offer from the moment it exists (a Shopify draft order is exactly
    // that), and `sent` is the status the transition table drives accept / reject / expire /
    // convert_to_invoice from. Every other type is born "issued".
    initial_status: type === "quote" ? "sent" : "issued",
    po_number_source: input.po_number_source ?? "person",
    draft: {
      currency,
      incoterm: input.incoterm ?? "DAP",
      year_of_issue: when.year_of_issue,
      issued_at: when.issued_at,
      due_at: input.due_at ?? null,
      external_refs: externalRefs,
      notes: notes.value ?? null,
      lines: input.items,
    },
  }
  let result: Awaited<ReturnType<typeof issueDocument>>
  try {
    result = await issueDocument(ctx, issueInput)
  } catch (err) {
    // The partial UNIQUE on shopify_draft_order_id fired: another delivery of the same
    // draft-order event won the race between our read above and this insert. Resolve by
    // re-reading rather than surfacing a 23505 the caller cannot act on -- the outcome the
    // caller wanted (one quote for this draft order) is exactly what already exists.
    if (input.shopify_draft_order_id && isUniqueViolation(err)) {
      const raced = await findByDraftOrderId(ctx.db, input.shopify_draft_order_id)
      if (raced) {
        return completedIssueResult(ctx.db, String(raced.id), String(raced.number ?? ""))
      }
    }
    throw err
  }
  return completedIssueResult(ctx.db, result.document_id, result.number)
}

/** What every create-and-issue tool returns once the document exists. Each key is a top-level
 *  output a later step of an approval bundle can cite (`@ref:<approvalId>:pdf_file_id`). */
export interface IssuedDocumentOutputs {
  document_id: string
  number: string
  /** Kernel file id of the document's PDF, to attach to a reply. Null when the PDF did not
   *  render; `pdf_error` then says what to do. */
  pdf_file_id: string | null
  /** "ready", "pending", "failed" or "facturx_failed". */
  pdf_status: string | null
  /** Present only when there is no PDF: the next step to get one. */
  pdf_error?: string
  /** The persisted grand total (tax included, discounts applied) in minor units, as a string. */
  grand_total_minor: string
  /** ISO 4217 currency of the document ("EUR"). */
  currency: string
}

export type CreateAndIssueResult = MutationResult<IssuedDocumentOutputs>

/**
 * The completed result of a create-and-issue call, read back from the PERSISTED document so the
 * total, currency and PDF are exactly what was stored (the issue-time rollup applies discounts;
 * a replay returns the existing document's own values). Shared by the standalone path and the
 * Shopify draft-order path.
 */
export async function completedIssueResult(
  db: MutationsDb,
  documentId: string,
  number: string,
): Promise<{ status: "completed" } & IssuedDocumentOutputs> {
  const rows = (await db.findMany("documents", { where: { id: documentId }, limit: 1 })) as Array<
    Record<string, unknown>
  >
  const row = rows[0] ?? {}
  const pdfFileId =
    typeof row.pdf_file_id === "string" && row.pdf_file_id !== "" ? row.pdf_file_id : null
  const pdfStatus = typeof row.pdf_status === "string" ? row.pdf_status : null
  const shownNumber = number || (typeof row.number === "string" ? row.number : "")
  return {
    status: "completed",
    document_id: documentId,
    number: shownNumber,
    pdf_file_id: pdfFileId,
    pdf_status: pdfStatus,
    ...(pdfFileId
      ? {}
      : {
          pdf_error:
            `${shownNumber || documentId} was issued, but its PDF did not render ` +
            `(pdf_status ${pdfStatus ?? "unknown"}), so there is no pdf_file_id to attach. Call ` +
            `documents_retry_pdf with id ${documentId}, then documents_get with the same id for ` +
            `the new pdf_file_id. Do not send the customer a reply that promises an attachment ` +
            `until it exists.`,
        }),
    grand_total_minor: row.grand_total_minor == null ? "0" : String(row.grand_total_minor),
    currency: typeof row.currency === "string" ? row.currency : "EUR",
  }
}

/**
 * Whether a create-and-issue call keyed onto an EXISTING document (same order, type and
 * shipment_ref) asks for different content than the document carries. Returns what differs
 * ("currency", "lines") or null for a true replay.
 *
 * The typed prices are compared the way they would have been stored: under an issuer with
 * `prices_include_tax` they are netted first (the draft-order sync excepted, its lines are net
 * already), exactly as createAndIssueGenerically does before issuing, so replaying the same gross
 * figures is still recognised as the same document. Lines compare by description, quantity, net
 * unit price and discount, in order.
 */
async function existingContentDiffers(
  ctx: MutationsCtx,
  doc: Record<string, unknown>,
  input: Omit<CreateAndIssueRawInput, "items"> & { items: DraftLine[] },
): Promise<string | null> {
  if (input.currency && doc.currency && String(doc.currency) !== input.currency) return "currency"
  let items = input.items
  if (!input.shopify_draft_order_id && doc.issuer_profile_id) {
    const issuer = await findIssuerProfile(ctx.db, String(doc.issuer_profile_id))
    if (issuer) {
      items = netLinesForIssuer(items, issuer, {
        issuer_country: issuer.country,
        counterparty_country: input.counterparty.country,
        has_vat_id: !!input.counterparty.vat_id,
      })
    }
  }
  const stored = ((await ctx.db.findMany("document_lines", {
    where: { document_id: String(doc.id) },
    orderBy: { position: "asc" },
    limit: 1000,
  })) as Array<Record<string, unknown>>)
    .slice()
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
  if (stored.length !== items.length) return "lines"
  const minor = (v: unknown): bigint => {
    try {
      return v == null || v === "" ? 0n : BigInt(String(v))
    } catch {
      return -1n
    }
  }
  for (const [i, want] of items.entries()) {
    const have = stored[i]!
    if (String(have.description ?? "").trim() !== String(want.description ?? "").trim()) return "lines"
    if (Number(have.quantity) !== Number(want.quantity)) return "lines"
    if (minor(have.unit_price_minor) !== want.unit_price_minor) return "lines"
    if (minor(have.discount_minor) !== (want.discount_minor ?? 0n)) return "lines"
  }
  return null
}

/** The quote already mirroring this Shopify draft order, if any. */
async function findByDraftOrderId(
  db: MutationsDb,
  draftOrderId: string,
): Promise<Record<string, unknown> | null> {
  const rows = (await db.findMany("documents", {
    where: { shopify_draft_order_id: draftOrderId },
    limit: 1,
  })) as Array<Record<string, unknown>>
  return rows[0] ?? null
}

/** True for a Postgres unique-violation surfaced through the sandbox bridge. The bridge
 *  flattens the driver error, so the code can arrive as `err.code` (23505), on a nested
 *  `cause`, or only inside the message text. */
export function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur)
    const rec = cur as { code?: unknown; message?: unknown; cause?: unknown }
    if (rec.code === "23505" || rec.code === "unique_violation") return true
    if (
      typeof rec.message === "string" &&
      (rec.message.includes("23505") ||
        /duplicate key value violates unique constraint/i.test(rec.message))
    )
      return true
    cur = rec.cause
  }
  return false
}

export type QuoteCreateAndIssueResult = MutationResult<
  IssuedDocumentOutputs & {
    shopify_draft_order_id?: string | null
    shopify_draft_order_name?: string | null
  }
>

/**
 * Create a quote.
 *
 * Three paths, decided by the issuer profile:
 *
 *  1. **Sync** (`shopify_draft_order_id` already on the input): the caller IS the draft-order
 *     sync, mirroring a draft order that already exists in Shopify. Never gates: the human
 *     decision happened in Shopify, and a second approval card here would strand the quote.
 *  2. **Shopify** (issuer mapped to a shop, no draft order yet): the quote is created AS a
 *     Shopify draft order, then mirrored back by the sync. The Shopify tool carries its own
 *     kernel gate, so its `pending_approval` envelope is passed through untouched.
 *  3. **Standalone** (no shop mapping): today's local quote, gated only above the issuer's
 *     invoice approval threshold. A quote commits nobody to anything, so a blanket gate on
 *     every quote was pure friction.
 */
export async function quoteCreateAndIssue(
  ctx: MutationsCtx,
  input: QuoteCreateAndIssueInput,
): Promise<QuoteCreateAndIssueResult> {
  if (input.shopify_draft_order_id) {
    return createAndIssueGenerically(
      ctx,
      "quote",
      "invoicing:quote_create_and_issue",
      "none",
      input,
    )
  }
  const issuerResolution = await resolveIssuerProfileOrError(ctx.db, input.issuer_profile_id)
  if (!issuerResolution.ok) return issuerResolution.error
  const shopId = issuerResolution.issuer.shopify_shop_id
  if (shopId) {
    // The draft order is created in Shopify first, so the business-buyer guard runs here too.
    const buyerCheck = await checkBuyerVat(ctx, {
      issuerCountry: issuerResolution.issuer.country,
      taxCountry: taxCountryOf(input.counterparty),
      counterparty: input.counterparty,
      buyerIsConsumer: input.buyer_is_consumer,
    })
    if (!buyerCheck.ok) return buyerCheck.error
    // A consumer the agent declared against business evidence is decided by a person before the
    // Shopify draft order exists (buyer-vat.ts).
    if (!ctx.approval && needsHumanBuyerDecision(buyerCheck.facts)) {
      const approval = await ctx.requestApproval({
        tool_name: "invoicing:quote_create_and_issue",
        ...asHandlerSummary(
          issueCard({
            kind: "quote_create_and_issue",
            type: "quote",
            fromDraft: false,
            customer: input.counterparty.legal_name,
            country: input.counterparty.country,
            buyer: buyerCheck.facts,
            currency: input.currency ?? "EUR",
            lines: input.items,
            issuerName: issuerResolution.issuer.legal_name,
          }),
        ),
        current_payload: input,
        editable_fields: ["items"],
      })
      if (!approval.auto_approved) return { status: "pending_approval", approval_id: approval.approval_id }
    }
    const vat = buyerCheck.facts.vat_id
    const withVat = vat && !input.counterparty.vat_id ? { ...input, counterparty: { ...input.counterparty, vat_id: vat } } : input
    return quoteCreateViaShopifyDraftOrder(ctx, withVat, issuerResolution.issuer)
  }
  return createAndIssueGenerically(
    ctx,
    "quote",
    "invoicing:quote_create_and_issue",
    "conditional_invoice",
    input,
  )
}

/**
 * STAGE-TIME preflight for the gated `proforma_issue` tool (manifest `preflight`). A gated call
 * must not be parked for a human when the data it needs is missing: a draft that does not
 * resolve, is not a proforma, has NO LINE ITEMS, or has an incomplete recipient is refused here,
 * before the approval request exists.
 */
/**
 * STAGE-TIME preflight for the gated `quote_create_and_issue` tool: the same checks as its
 * handler (recipient, notes, amounts, issuer, the intra-EU business-buyer guard), refused before
 * the approval request exists.
 */
export async function quoteCreateAndIssuePreflight(
  ctx: MutationsCtx,
  input: QuoteCreateAndIssueInput,
): Promise<PreflightResult> {
  return toPreflightResult(await preflightCreateAndIssueParams(ctx, "quote", input))
}

/** quote_issue's stage-time check: the same as proforma_issue's (see below). */
export async function quoteIssuePreflight(ctx: MutationsCtx, input: { draft_id: string }): Promise<PreflightResult> {
  const draft = await getDraft(ctx.db, input.draft_id)
  if (!draft) return { error: { code: "not_found", message: `draft ${input.draft_id} not found` } }
  return toPreflightResult(await preflightIssueFromDraft(ctx, draft, "quote"))
}

export async function proformaIssuePreflight(
  ctx: MutationsCtx,
  input: { draft_id: string },
): Promise<PreflightResult> {
  const draft = await getDraft(ctx.db, input.draft_id)
  if (!draft) {
    return { error: { code: "not_found", message: `draft ${input.draft_id} not found` } }
  }
  return toPreflightResult(await preflightIssueFromDraft(ctx, draft, "proforma"))
}

export async function proformaIssue(
  ctx: MutationsCtx,
  input: { draft_id: string },
): Promise<MutationResult<{ document_id: string; number: string }>> {
  const draft = await getDraft(ctx.db, input.draft_id)
  if (!draft) {
    return {
      status: "error",
      error: { code: "not_found", message: `draft ${input.draft_id} not found` },
    }
  }
  return issueFromDraftWithGating(
    ctx,
    draft,
    "proforma",
    "invoicing:proforma_issue",
    "always",
  )
}

export interface ProformaCreateAndIssueInput extends QuoteCreateAndIssueInput {
  reason: string
  declared_value_minor?: bigint
  /** The Shopify order this proforma covers, when any. Keys idempotency together
   *  with shipment_ref: the same (order, shipment_ref) pair returns the existing
   *  proforma instead of issuing a duplicate. */
  shopify_order_id?: string | null
  /** The order's HUMAN name ("#1149"), printed and indexed. Not part of the idempotency key. */
  shopify_order_number?: string | null
  /** Physical shipment batch reference. Distinct values allow ONE proforma per
   *  shipment batch of the same order while the legal invoice stays unique.
   *  NULL keeps the historical whole-order behavior. */
  shipment_ref?: string | null
}

/**
 * STAGE-TIME preflight for the gated `proforma_create_and_issue` tool (manifest `preflight`).
 * A gated call must not be parked for a human when the data it needs is missing: an incomplete
 * recipient, an over-long note, or an AMBIGUOUS issuer profile (several configured and no
 * `issuer_profile_id` passed) is refused here, before the approval request exists.
 */
export async function proformaCreateAndIssuePreflight(
  ctx: MutationsCtx,
  input: ProformaCreateAndIssueInput,
): Promise<PreflightResult> {
  return toPreflightResult(await preflightCreateAndIssueParams(ctx, "proforma", input))
}

export async function proformaCreateAndIssue(
  ctx: MutationsCtx,
  input: ProformaCreateAndIssueInput,
): Promise<CreateAndIssueResult> {
  return createAndIssueGenerically(
    ctx,
    "proforma",
    "invoicing:proforma_create_and_issue",
    "always",
    input,
  )
}

export async function poIssue(
  ctx: MutationsCtx,
  input: { draft_id: string },
): Promise<MutationResult<{ document_id: string; number: string }>> {
  const draft = await getDraft(ctx.db, input.draft_id)
  if (!draft) {
    return {
      status: "error",
      error: { code: "not_found", message: `draft ${input.draft_id} not found` },
    }
  }
  return issueFromDraftWithGating(
    ctx,
    draft,
    "purchase_order",
    "invoicing:po_issue",
    "conditional_po",
  )
}

export async function poCreateAndIssue(
  ctx: MutationsCtx,
  input: QuoteCreateAndIssueInput,
): Promise<CreateAndIssueResult> {
  return createAndIssueGenerically(
    ctx,
    "purchase_order",
    "invoicing:po_create_and_issue",
    "conditional_po",
    input,
  )
}
