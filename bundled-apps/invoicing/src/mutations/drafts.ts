// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: drafts (create, update, discard).

import { runItemDraftRefusal } from "../recurring/run-card"
import type { DraftLine, DraftLineInput } from "../issue"
import { type BuyerVatFacts, checkBuyerVat, consumerDeclaredAgainstEvidence } from "../buyer-vat"
import { asHandlerSummary } from "../approval-cards"
import { assertNoLiveInvoiceForOrder } from "./credit-coverage"
import {
  resolveIssuerProfileOrError,
  insertDraftRow,
  getDraft,
  findIssuerProfile,
  updateDraftRow,
  deleteDraftRow,
} from "./db-helpers"
import { liftMisplacedCountry, normaliseDraftLines, netLinesForIssuer } from "./lines"
import {
  type DocumentType,
  type MutationsCtx,
  type DraftRow,
  type DraftInsert,
  type PreflightResult,
  VALID_TYPES,
  normaliseNotesOrThrow,
  toPreflightResult,
} from "./shared"

/**
 * How a draft call runs: `tool` (the agent's call, may park an approval), `direct` (in-app
 * callers, never park) or `preflight` (the stage-time check: every validation the call makes,
 * then stop before any write or approval).
 */
type DraftRunMode = "tool" | "direct" | "preflight"

/** What a `preflight` run returns once every validation passed: the buyer facts it resolved. */
type PreflightPassed = { preflight: "passed"; buyer: BuyerVatFacts | null }

/**
 * Map a draft validation's thrown `code: message` error onto the kernel's preflight contract.
 * An error without a code is not a validation outcome (a fault), so it propagates.
 */
function thrownToPreflight(err: unknown): PreflightResult {
  const message = err instanceof Error ? err.message : String(err)
  const m = /^([a-z][a-z0-9_]*):\s*([\s\S]*)$/.exec(message)
  if (!m) throw err
  return { error: { code: m[1] as string, message: m[2] as string } }
}

// ── Drafts ────────────────────────────────────────────────────────────────

/** The e-invoicing fields a draft carries (kind, operation category, structured billing). */
type DraftEinvoiceInput = Pick<
  DraftInsert,
  | "customer_kind"
  | "operation_category"
  | "billing_line1"
  | "billing_line2"
  | "billing_postcode"
  | "billing_city"
  | "billing_country_code"
>

export interface DraftsCreateInput extends DraftEinvoiceInput {
  type: DocumentType
  counterparty_contact_id: string | null
  /** Counterparty snapshot fields shown in the editor's "Customer" section — persisted onto the
   *  draft `documents` row and carried through to the issued document. */
  counterparty_name?: string | null
  counterparty_address?: string | null
  /** Ship to snapshot. RENDER ONLY: printed as the PDF's SHIP TO block when it differs from the
   *  billing address, and never an input to `classify()`, which keys off counterparty_country. */
  counterparty_shipping_address?: string | null
  counterparty_shipping_name?: string | null
  counterparty_vat_id?: string | null
  counterparty_email?: string | null
  /** Counterparty ISO country — drives the tax treatment at issue (non-EU ⇒ export zero-rated). */
  counterparty_country?: string | null
  tax_treatment?: string | null
  /** When omitted, defaults to the org's sole issuer profile; a typed error is
   *  returned if the org has zero or several (see resolveIssuerProfileOrError). */
  issuer_profile_id?: string | null
  // Optional: when omitted, currency derives from the issuer profile's
  // default_currency (fallback EUR). The drafts_create tool params DO accept
  // `currency` now (manifest) so the agent can match a Shopify order's
  // currency (e.g. USD) when reconciling an order into an invoice.
  currency?: string
  incoterm?: string
  due_at?: string | null
  /** Optional Shopify order id/name to LINK + IDEMPOTENTLY DEDUPE this invoice: the partial UNIQUE
   *  constraint on documents.shopify_order_id rejects a second draft for the same order, so a looping
   *  agent cannot double-bill an order it already invoiced. */
  shopify_order_id?: string | null
  /** The order's HUMAN name ("#1149"), printed on the document and indexed for
   *  search. Set it alongside `shopify_order_id` whenever you know it. */
  shopify_order_number?: string | null
  /** The customer's purchase order number, when they gave one. Printed as a "PO
   *  number" line on the document PDF and indexed for documents_search. */
  po_number?: string | null
  /** Free-text notes printed on the document PDF under the totals (contract reference, extra
   *  customs information, a special mention). Non financial: trimmed, blank becomes null, and
   *  refused past NOTES_MAX_LENGTH characters. Stays editable after issue via documents_update. */
  notes?: string | null
  /** The intra-EU buyer is a private consumer although the org's data suggests a business
   *  (buyer-vat.ts). Recorded on `external_refs.buyer_is_consumer`, read again at issue. */
  buyer_is_consumer?: boolean | null
  items: DraftLineInput[]
}

/**
 * The intra-EU business-buyer guard for a draft's buyer (buyer-vat.ts), thrown as the
 * `code: message` error the draft tools use. Returns the VAT number to store (the caller's, or
 * one an earlier document for the same buyer carries).
 */
async function guardDraftBuyer(
  ctx: MutationsCtx,
  draft: {
    type: DocumentType
    id?: string | null
    issuerCountry: string
    counterparty_country: string | null
    counterparty_contact_id: string | null
    counterparty_name: string | null
    counterparty_email: string | null
    counterparty_address: string | null
    counterparty_vat_id: string | null
    customer_kind: string | null
    buyer_is_consumer: boolean
  },
): Promise<{ vat: string | null; facts: BuyerVatFacts | null }> {
  if (draft.type === "credit_note" || draft.type === "purchase_order") return { vat: draft.counterparty_vat_id, facts: null }
  const r = await checkBuyerVat(ctx, {
    issuerCountry: draft.issuerCountry,
    taxCountry: draft.counterparty_country,
    counterparty: {
      contact_id: draft.counterparty_contact_id,
      legal_name: draft.counterparty_name,
      email: draft.counterparty_email,
      address: draft.counterparty_address,
      vat_id: draft.counterparty_vat_id,
      customer_kind: draft.customer_kind,
    },
    buyerIsConsumer: draft.buyer_is_consumer,
    excludeDocumentId: draft.id ?? null,
  })
  if (!r.ok) throw new Error(`${r.error.error.code}: ${r.error.error.message}`)
  return { vat: r.facts.vat_id ?? draft.counterparty_vat_id, facts: r.facts }
}

/** A draft call parked for a person's decision (see parkConsumerDeclaration). */
export interface DraftParked {
  status: "pending_approval"
  approval_id: string | null
}

/**
 * A draft whose buyer the agent declared a private consumer against business evidence is not
 * written until a person approves it (buyer-vat.ts): the approval card lists the evidence. Null
 * when the call may go on (no such declaration, the call IS the approved one, or the person's own
 * call holds the deciding scope).
 */
async function parkConsumerDeclaration(
  ctx: MutationsCtx,
  toolName: "invoicing:drafts_create" | "invoicing:drafts_update",
  facts: BuyerVatFacts | null,
  customer: string | null,
  payload: unknown,
): Promise<DraftParked | null> {
  if (ctx.approval || !consumerDeclaredAgainstEvidence(facts)) return null
  const evidence = facts?.consumer_override_evidence ?? []
  const approval = await ctx.requestApproval({
    tool_name: toolName,
    ...asHandlerSummary({
      kind: toolName.replace(/^invoicing:/, ""),
      title: `${toolName.endsWith("create") ? "Create" : "Update"} a draft for ${customer ?? "the buyer"} as a PRIVATE CONSUMER`,
      subtitle: "The agent declared this buyer a private consumer",
      lines: [
        "WARNING: the agent declared this buyer a private consumer (consumer VAT, no reverse charge), but the org's data says business.",
        ...evidence.slice(0, 5).map((e) => `- ${e}`),
        "Approve only if you know the buyer is a private person; otherwise reject and add the buyer's VAT number.",
      ],
    }),
    current_payload: payload,
  })
  return approval.auto_approved ? null : { status: "pending_approval", approval_id: approval.approval_id }
}

type DraftCreated = { draft_id: string } & ReturnType<typeof serializeDraftRow>

/**
 * drafts_create as the tool runs it: a consumer declared against business evidence parks an
 * approval card first (parkConsumerDeclaration).
 */
export async function draftsCreateTool(ctx: MutationsCtx, input: DraftsCreateInput): Promise<DraftCreated | DraftParked> {
  const r = await createDraft(ctx, input, "tool")
  if ("preflight" in r) throw new Error("drafts_create: a tool run returned a preflight result")
  return r
}

/**
 * drafts_create's stage-time check (manifest `preflight`): the same createDraft run, stopped
 * before the insert and before any approval is parked, so a call the handler would refuse is
 * refused before a person is asked to decide it. Read-only.
 */
export async function draftsCreatePreflight(ctx: MutationsCtx, input: DraftsCreateInput): Promise<PreflightResult> {
  try {
    const r = await createDraft(ctx, input, "preflight")
    return toPreflightResult({ ok: true, buyer: "preflight" in r ? r.buyer : null })
  } catch (err) {
    return thrownToPreflight(err)
  }
}

/** Create a draft, for in-app callers that hold no approval to park (the tool runs draftsCreateTool). */
export async function draftsCreate(ctx: MutationsCtx, input: DraftsCreateInput): Promise<DraftCreated> {
  const r = await createDraft(ctx, input, "direct")
  if ("status" in r) throw new Error("approval_required: this draft needs a person's approval")
  if ("preflight" in r) throw new Error("drafts_create: a direct run returned a preflight result")
  return r
}

async function createDraft(
  ctx: MutationsCtx,
  input: DraftsCreateInput,
  mode: DraftRunMode,
): Promise<DraftCreated | DraftParked | PreflightPassed> {
  if (!VALID_TYPES.includes(input.type)) {
    throw new Error(`invalid_type: ${input.type}`)
  }
  // Resolve the issuer profile up front — `documents.issuer_profile_id` is NOT
  // NULL, so an absent id must be defaulted (single-issuer org) or turned into a
  // TYPED error BEFORE the insert, never let through as a raw 23502 the agent
  // reads only as "Tool execution failed".
  const issuerResolution = await resolveIssuerProfileOrError(ctx.db, input.issuer_profile_id)
  if (!issuerResolution.ok) {
    throw new Error(
      `${issuerResolution.error.error.code}: ${issuerResolution.error.error.message}`,
    )
  }
  const resolvedIssuer = issuerResolution.issuer
  // `documents.currency` is NOT NULL. An explicit `currency` param wins (the
  // agent sets it to a Shopify order's currency when reconciling); otherwise it
  // derives from the resolved issuer profile's default_currency. (Without a value
  // a draft with no explicit currency 500s with a not-null violation; surfaced by
  // the chaos finance actor.)
  let currency = input.currency
  if (!currency) {
    const rows = await ctx.db.findMany("issuer_profiles", {
      where: { id: resolvedIssuer.id },
      limit: 1,
    })
    const issuerRow = rows[0] as Record<string, unknown> | undefined
    const dc = issuerRow?.default_currency
    if (typeof dc === "string" && dc) currency = dc
  }
  // IDEMPOTENCY — one invoice per Shopify order. When the caller links a shopify_order_id, refuse a
  // SECOND document for an order that already has one: a looping/retrying agent (re-running orders_search
  // and re-issuing each turn) would otherwise double-bill the customer (the bf-batch ~35-duplicate-approval
  // failure). The partial UNIQUE constraint on documents.shopify_order_id is the DB backstop for the race;
  // this pre-check turns the would-be duplicate into a CLEAR, agent-readable error (naming the existing
  // document) so the agent learns the order is already invoiced and stops the loop, instead of a raw 500.
  if (input.shopify_order_id) {
    await assertNoLiveInvoiceForOrder(ctx.db, input.shopify_order_id)
  }
  // BL-44: route a destination country the agent put in the informational `tax_treatment` onto the
  // field of record `counterparty_country` before persisting (it drives the issue-time tax rate).
  const { counterparty_country, tax_treatment } = liftMisplacedCountry({
    counterparty_country: input.counterparty_country ?? null,
    tax_treatment: input.tax_treatment ?? null,
  })
  // Typed prices are gross under an issuer with prices_include_tax: store the NET price the
  // document model expects, so the draft, its preview totals and the issued document agree.
  // EXCEPT credit_note: its items are reversal amounts mirroring an already-net original
  // invoice (credit_note_create_and_issue's own documented contract — "lines commonly carry
  // NEGATIVE unit_price_minor mirroring what is reversed on the original invoice"), never a
  // typed retail price, so dividing included tax out of them here would corrupt the mirrored
  // amount. Applying it anyway would also make the two documented credit-note creation paths
  // (this draft route and the direct credit_note_create_and_issue, which never converts)
  // disagree on the SAME conceptual input under an inclusive issuer.
  const guarded = await guardDraftBuyer(ctx, {
    type: input.type,
    issuerCountry: resolvedIssuer.country,
    counterparty_country,
    counterparty_contact_id: input.counterparty_contact_id ?? null,
    counterparty_name: input.counterparty_name ?? null,
    counterparty_email: input.counterparty_email ?? null,
    counterparty_address: input.counterparty_address ?? null,
    counterparty_vat_id: input.counterparty_vat_id ?? null,
    customer_kind: input.customer_kind ?? null,
    buyer_is_consumer: input.buyer_is_consumer === true,
  })
  const counterpartyVatId = guarded.vat
  // Lines and notes are validated BEFORE any approval is parked: a person must never approve a
  // draft whose lines or notes the insert then refuses.
  const normalisedItems = normaliseDraftLines(input.items ?? [])
  const draftLines =
    input.type === "credit_note"
      ? normalisedItems
      : netLinesForIssuer(normalisedItems, resolvedIssuer, {
          issuer_country: resolvedIssuer.country,
          counterparty_country,
          has_vat_id: !!counterpartyVatId,
        })
  const notes = normaliseNotesOrThrow(input.notes) ?? null
  if (mode === "preflight") return { preflight: "passed", buyer: guarded.facts }
  const parked =
    mode === "tool"
      ? await parkConsumerDeclaration(ctx, "invoicing:drafts_create", guarded.facts, input.counterparty_name ?? null, input)
      : consumerDeclaredAgainstEvidence(guarded.facts) && !ctx.approval
        ? { status: "pending_approval" as const, approval_id: null }
        : null
  if (parked) return parked
  const draft = await insertDraftRow(ctx.db, {
    type: input.type,
    counterparty_contact_id: input.counterparty_contact_id,
    counterparty_name: input.counterparty_name ?? null,
    counterparty_address: input.counterparty_address ?? null,
    counterparty_shipping_address: input.counterparty_shipping_address ?? null,
    counterparty_shipping_name: input.counterparty_shipping_name ?? null,
    counterparty_vat_id: counterpartyVatId,
    counterparty_email: input.counterparty_email ?? null,
    counterparty_country,
    tax_treatment,
    issuer_profile_id: resolvedIssuer.id,
    currency: currency ?? "EUR",
    incoterm: input.incoterm ?? "DAP",
    due_at: input.due_at ?? null,
    // The order link lives on `external_refs` as well as the draft's own column:
    // issuing writes a NEW document row from the draft's external_refs and then
    // deletes the draft, so a link held ONLY in the column would be lost the
    // moment the invoice was issued -- taking the order-number PDF line, the
    // by-order search, and the one-invoice-per-order idempotency check with it.
    external_refs: {
      ...(input.shopify_order_id ? { shopify_order_id: input.shopify_order_id } : {}),
      ...(input.shopify_order_number
        ? { shopify_order_number: input.shopify_order_number }
        : {}),
      ...(input.po_number ? { po_number: input.po_number } : {}),
      ...(input.buyer_is_consumer === true ? { buyer_is_consumer: true } : {}),
      // The evidence a person approved the consumer declaration against, shown again on the
      // issue card.
      ...(consumerDeclaredAgainstEvidence(guarded.facts)
        ? { buyer_is_consumer_evidence: guarded.facts?.consumer_override_evidence ?? [] }
        : {}),
    },
    shopify_order_id: input.shopify_order_id ?? null,
    shopify_order_number: input.shopify_order_number ?? null,
    po_number: input.po_number ?? null,
    // Normalised at the boundary (trim, blank -> null, length cap): the draft is what the
    // issue path copies onto the document, so a bad value must never get this far.
    notes,
    customer_kind: input.customer_kind ?? null,
    operation_category: input.operation_category ?? null,
    billing_line1: input.billing_line1 ?? null,
    billing_line2: input.billing_line2 ?? null,
    billing_postcode: input.billing_postcode ?? null,
    billing_city: input.billing_city ?? null,
    billing_country_code: input.billing_country_code ?? null,
    lines: draftLines,
  })
  // Kernel audit trail — a brand new draft entering the document lifecycle.
  await ctx.emit({
    entity: "document",
    action: "created",
    entityId: draft.id,
    data: {
      document_id: draft.id,
      type: draft.type,
      number: null,
      status: "draft",
    },
  })
  // Return the persisted draft (lines included), not just an opaque id — mirroring drafts_update.
  // A one-shot drafts_create otherwise left the agent with NO tool-backed view of what it created,
  // so it narrated lines/HS-codes from memory and the judge had no evidence the export invoice
  // genuinely "carries" the per-line customs facts (incl. a lifted hs_code). draft_id is kept for
  // backward compatibility; the serialized body adds id/lines/customs facts the caller can read back.
  return { draft_id: draft.id, ...serializeDraftRow(draft) }
}

/**
 * Wire-safe view of a draft: bigint line prices → strings. The sandbox bridge JSON-serialises a
 * handler's return value, and `JSON.stringify` THROWS on a bigint — so returning a raw `DraftRow`
 * (whose `lines[].unit_price_minor` is a bigint from `loadDraftLines`) made drafts_update surface
 * an unparseable "[object Object]", hiding the result so the agent could neither confirm the update
 * nor read back the persisted lines (the export multi-step scenarios stalled here).
 */
function serializeDraftRow(d: DraftRow): Omit<DraftRow, "lines"> & {
  lines: Array<Omit<DraftLine, "unit_price_minor" | "discount_minor"> & { unit_price_minor: string; discount_minor?: string }>
} {
  return {
    ...d,
    lines: d.lines.map(({ unit_price_minor, discount_minor, ...line }) => ({
      ...line,
      unit_price_minor: unit_price_minor.toString(),
      ...(discount_minor == null ? {} : { discount_minor: discount_minor.toString() }),
    })),
  }
}

type DraftUpdated = ReturnType<typeof serializeDraftRow>

/** drafts_update as the tool runs it (see draftsCreateTool). */
export async function draftsUpdateTool(
  ctx: MutationsCtx,
  input: Parameters<typeof draftsUpdate>[1],
): Promise<DraftUpdated | DraftParked> {
  const r = await updateDraft(ctx, input, "tool")
  if ("preflight" in r) throw new Error("drafts_update: a tool run returned a preflight result")
  return r
}

/**
 * drafts_update's stage-time check (manifest `preflight`): the same updateDraft run, stopped
 * before the write and before any approval is parked. Read-only.
 */
export async function draftsUpdatePreflight(
  ctx: MutationsCtx,
  input: Parameters<typeof draftsUpdate>[1],
): Promise<PreflightResult> {
  try {
    const r = await updateDraft(ctx, input, "preflight")
    return toPreflightResult({ ok: true, buyer: "preflight" in r ? r.buyer : null })
  } catch (err) {
    return thrownToPreflight(err)
  }
}

/** Update a draft, for in-app callers that hold no approval to park (the tool runs draftsUpdateTool). */
export async function draftsUpdate(
  ctx: MutationsCtx,
  input: {
    draft_id: string
    patch: Partial<Omit<DraftInsert, "lines">> & { lines?: DraftLineInput[]; buyer_is_consumer?: boolean | null }
  },
): Promise<DraftUpdated> {
  const r = await updateDraft(ctx, input, "direct")
  if ("status" in r) throw new Error("approval_required: this draft change needs a person's approval")
  if ("preflight" in r) throw new Error("drafts_update: a direct run returned a preflight result")
  return r
}

async function updateDraft(
  ctx: MutationsCtx,
  // `lines` is the forgiving WIRE shape (DraftLineInput — unit_price_minor: bigint|string|number),
  // NOT the strict normalised DraftLine: documents_get returns unit_price_minor as a STRING, so the
  // agent's natural read→patch→write round-trip delivers a string here (BL-41). normaliseDraftLines
  // promotes it. Mirrors drafts_create's `items: DraftLineInput[]` and the DraftLineInput doc contract.
  input: {
    draft_id: string
    patch: Partial<Omit<DraftInsert, "lines">> & { lines?: DraftLineInput[]; buyer_is_consumer?: boolean | null }
  },
  mode: DraftRunMode,
): Promise<DraftUpdated | DraftParked | PreflightPassed> {
  const { lines, buyer_is_consumer: buyerIsConsumerPatch, ...header } = input.patch
  let patch: Partial<DraftInsert> = header
  let buyerFacts: BuyerVatFacts | null = null
  // Validated before any approval is parked (see createDraft).
  if ("notes" in header) normaliseNotesOrThrow(header.notes)
  if (lines) normaliseDraftLines(lines)
  if (mode === "preflight" && !(await getDraft(ctx.db, input.draft_id))) {
    throw new Error(`not_found: draft ${input.draft_id}`)
  }
  // A change to who the buyer is re-runs the intra-EU business-buyer guard on the merged draft.
  const BUYER_KEYS = [
    "counterparty_contact_id",
    "counterparty_name",
    "counterparty_address",
    "counterparty_vat_id",
    "counterparty_email",
    "counterparty_country",
    "customer_kind",
    "issuer_profile_id",
    "tax_treatment",
  ] as const
  if (buyerIsConsumerPatch !== undefined || BUYER_KEYS.some((k) => k in header)) {
    const existing = await getDraft(ctx.db, input.draft_id)
    if (!existing) throw new Error(`not_found: draft ${input.draft_id}`)
    const lifted = liftMisplacedCountry(header)
    const pick = <K extends (typeof BUYER_KEYS)[number]>(k: K) =>
      (k in lifted ? lifted[k] : existing[k]) ?? null
    const issuer = await findIssuerProfile(ctx.db, lifted.issuer_profile_id ?? existing.issuer_profile_id)
    const refs = { ...(lifted.external_refs ?? existing.external_refs ?? {}) }
    const consumer =
      buyerIsConsumerPatch !== undefined ? buyerIsConsumerPatch === true : refs.buyer_is_consumer === true
    let facts: BuyerVatFacts | null = null
    if (issuer) {
      const guarded = await guardDraftBuyer(ctx, {
        type: lifted.type ?? existing.type,
        id: existing.id,
        issuerCountry: issuer.country,
        counterparty_country: pick("counterparty_country"),
        counterparty_contact_id: pick("counterparty_contact_id"),
        counterparty_name: pick("counterparty_name"),
        counterparty_email: pick("counterparty_email"),
        counterparty_address: pick("counterparty_address"),
        counterparty_vat_id: pick("counterparty_vat_id"),
        customer_kind: pick("customer_kind"),
        buyer_is_consumer: consumer,
      })
      facts = guarded.facts
      buyerFacts = facts
      const vat = guarded.vat
      if (vat && !pick("counterparty_vat_id")) patch = { ...patch, counterparty_vat_id: vat }
      const parked =
        mode === "preflight"
          ? null
          : mode === "tool"
            ? await parkConsumerDeclaration(ctx, "invoicing:drafts_update", facts, pick("counterparty_name"), input)
            : consumerDeclaredAgainstEvidence(facts) && !ctx.approval
              ? { status: "pending_approval" as const, approval_id: null }
              : null
      if (parked) return parked
    }
    const hadEvidence = "buyer_is_consumer_evidence" in refs
    if (consumer) refs.buyer_is_consumer = true
    else delete refs.buyer_is_consumer
    if (consumer && consumerDeclaredAgainstEvidence(facts)) refs.buyer_is_consumer_evidence = facts?.consumer_override_evidence ?? []
    else delete refs.buyer_is_consumer_evidence
    if (buyerIsConsumerPatch !== undefined || lifted.external_refs || hadEvidence || "buyer_is_consumer_evidence" in refs) {
      patch = { ...patch, external_refs: refs }
    }
  }
  if (lines) {
    const normalised = normaliseDraftLines(lines, "patch.lines")
    // A drafts_update line replacement is typed input exactly like drafts_create's `items` (the
    // manifest documents ONE rule for typed prices on quote/proforma/PO lines, with no carve-out
    // for update): under an issuer with `prices_include_tax`, the price the caller put in the
    // patch is gross and must be net-of-tax before it reaches `document_lines`, the same as at
    // create time. Without this, a drafts_update that sets a NEW price under an inclusive issuer
    // stored the gross figure untouched — issueDocument never re-derives it (netLinesForIssuer
    // only runs at the create/issue boundary), so the issued document, its PDF and any later
    // partial-reversal allocation were silently wrong.
    const existing = await getDraft(ctx.db, input.draft_id)
    if (!existing) {
      throw new Error(`not_found: draft ${input.draft_id}`)
    }
    const lifted = liftMisplacedCountry(header)
    const issuerProfileId = lifted.issuer_profile_id ?? existing.issuer_profile_id
    const issuer = await findIssuerProfile(ctx.db, issuerProfileId)
    const counterpartyCountry =
      "counterparty_country" in lifted ? lifted.counterparty_country : existing.counterparty_country
    const counterpartyVatId =
      patch.counterparty_vat_id ??
      ("counterparty_vat_id" in lifted ? lifted.counterparty_vat_id : existing.counterparty_vat_id)
    // credit_note items are reversal amounts, never typed retail prices — see the matching
    // comment in draftsCreate. Skip the conversion so this agrees with drafts_create and with
    // the direct credit_note_create_and_issue tool.
    const resolvedType = lifted.type ?? existing.type
    const netLines =
      issuer && resolvedType !== "credit_note"
        ? netLinesForIssuer(normalised, issuer, {
            issuer_country: issuer.country,
            counterparty_country: counterpartyCountry,
            has_vat_id: !!counterpartyVatId,
          })
        : normalised
    patch = { ...patch, lines: netLines }
  }
  if (mode === "preflight") return { preflight: "passed", buyer: buyerFacts }
  return serializeDraftRow(await updateDraftRow(ctx.db, input.draft_id, patch))
}

export async function draftsDiscard(
  ctx: MutationsCtx,
  input: { draft_id: string },
): Promise<{ ok: true }> {
  // A month-end run's draft is taken out through its run, never deleted under it.
  const draft = (await ctx.db.findOne("documents", input.draft_id)) as Record<string, unknown> | null
  const runRefusal = await runItemDraftRefusal(ctx, draft, "drafts_discard")
  if (runRefusal) throw new Error(`${runRefusal.error.code}: ${runRefusal.error.message}`)
  await deleteDraftRow(ctx.db, input.draft_id)
  return { ok: true }
}
