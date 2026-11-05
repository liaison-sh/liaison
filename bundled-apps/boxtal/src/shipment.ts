// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shipment orchestration: quote (free), draft (cross-app invoice read →
// resolver + customs), draft mutations, and the gated create_shipment.
//
// Gating contract (verified vs Shopify `refunds_create`): the kernel gates
// UPSTREAM in execute-tool.ts — on a first (un-approved) gated call it creates
// the approval request and returns the K4 pending_approval envelope; the
// handler body never runs on the first call. So `createShipment` is a single
// straight-line body (reserve → POST → finalize/markUncertain) with NO
// first-call/re-entry branch — the kernel guarantees it only runs post-approval.

import { type BoxtalFacade, getClientOrError } from "./lib/get-client"
import {
  type BoxtalAddress,
  BoxtalApiError,
  type BoxtalCreateDraft,
  type NormalizedOrder,
} from "./lib/boxtal-v3-client"
import type { CotationInput, CotationParty, Offer } from "./lib/boxtal-v1-client"
import { defaultSleep, retryDelayMs } from "./lib/backoff"
import {
  resolvePackages,
  type CatalogPack,
  type CatalogPackComponent,
  type CatalogProfile,
  type Parcel,
  type ResolverLine,
} from "./resolver"
import {
  type ArticleOverride,
  buildCustomsArticles,
  type CustomsBasis,
  categoryToCustomsBasis,
  contentCategoryNumeric,
  type CustomsArticle,
  type CustomsDocLine,
  type CustomsPatch,
  overrideUnitValue,
  type PrepCategory,
  requiresCustoms,
  resolvePrepCategory,
} from "./customs"
import {
  DECLARED_CURRENCY,
  deriveShopifyOrderRate,
  type FxConversion,
} from "./fx"
import { toShopifyOrderGid } from "./shopify-ref"
import {
  type CachedShipTo,
  type ShipToCacheEntry,
  type ShopifyOrderAddress,
  shipToCacheOf,
  shopifyOrderMetaOf,
  warmPrepMetaForDocument,
} from "./prep-meta"
import {
  type AddressCheck,
  type AddressChoiceRecord,
  type AddressSources,
  addressChoiceOf,
  applyAddressChoice,
  resolveRecipient,
  type VerifiedAddress,
} from "./address-check"
import { numericOrderId, orderKeyForShopifyOrder } from "./order-state"
import { buildQueueFacts } from "./queue-facts"
import { buildPrintSnapshot, carrierFamilyOf } from "./print-record"
import { summarizeProducts } from "./draft-cache"
import {
  unshippableMessage,
  unshippableReason,
  type UnshippableReason,
} from "./order-shippability"
import {
  finalizeCreated,
  isLiveShipment,
  markUncertain,
  reserveCreate,
} from "./link-store"
import {
  clearDraftOverride,
  type DraftOverride,
  loadDraftOverride,
  saveDraftOverride,
} from "./draft-store"
import {
  assembleAddress,
  normalizeRegion,
  partyFromConfig,
  type PostalParty,
  validateParty,
  validateRecipientPhone,
} from "./address"
import { filterOffersByAllowlist, filterOffersByPickupPoint } from "./carriers"
import {
  type LabelFormat,
  loadCarrierAllowlist,
  loadExcludePickupPointServices,
  loadLabelFormat,
  loadPackagingPolicy,
} from "./settings"
import { resolveStageOffer, type ResolvedStageOffer } from "./prep-selection"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { isParcelLine, unresolvedLinesBlockLabel } from "./shippable-lines"
import { ToolError } from "@liaison/app-sdk"
import { grossOfExcludedTax } from "./money"
import { withAttributeShortCodes } from "./product-attributes"
import { loadVariantProfiles } from "./profiles"
import { findShipmentByRef } from "./shipment-lookup"
import { countryIsoFromName, namesCountry } from "./country-names"

/**
 * Extract Boxtal's human-readable validation detail from an error response body
 * so a 422 surfaces WHY the shipment was rejected (the v3 API returns
 * `{ messages: [{ severity, text }] }`; some errors use `{ message }`). Falls
 * back to a truncated raw body. Without this, agents/users get an opaque
 * "rejected (422)" with no actionable field — surfaced by the M0.3 live run.
 */
export function summarizeBoxtalError(body: string): string {
  if (!body) return ""
  try {
    const parsed = JSON.parse(body) as {
      messages?: Array<{ text?: string }>
      message?: string
    }
    const texts = (parsed.messages ?? []).map((m) => m.text).filter((t): t is string => !!t)
    if (texts.length > 0) return texts.join("; ")
    if (parsed.message) return parsed.message
  } catch {
    // non-JSON body — fall through to the raw slice
  }
  return body.slice(0, 300)
}

type ShipmentCtx = BoxtalToolCtx

const SENDER_CONFIG_KEY = "sender_address"

export interface ShipmentDraft {
  document_ref: string
  /**
   * The identifier to pass back as `draft_id` to the downstream draft tools
   * (shipment_draft_set_package / _set_customs / quote / create_shipment). The
   * Boxtal "draft" is VIRTUAL — re-derived idempotently from the invoice each call
   * — so its identity IS the invoice's `document_ref` (a UUID). We surface it under
   * BOTH `document_ref` AND `draft_id` so a tick can read `draft_id` straight off
   * the shipment_draft_create result and chain it to the next tool WITHOUT having
   * to know that "the document_ref is the draft id". Without this alias a weak tick
   * looks for a `draft_id`/`id` field, finds none, and reports a "draft identifier
   * format / synchronization error" — staging nothing (the auto-fulfill-eu-orders
   * BL-275 runtime-tick failure). `draft_id === document_ref` always. (l710 surface
   * robustness — make the chain self-evident, not a fact the model must remember.)
   */
  draft_id: string
  parcels: Parcel[]
  customsArticles: CustomsArticle[]
  unresolved: Array<{ line: ResolverLine; reason: string }>
  /** What the packing rules could not decide alone and the operator must see before buying: a
   *  footprint no carton takes, an item deeper than every carton, a carton whose tare is assumed.
   *  Empty under a persisted operator carton (the human's parcel is the parcel). */
  packing_warnings: string[]
  /** True when a persisted set_package override supplies the parcel set. An explicit
   *  operator carton makes per-line shipping profiles irrelevant for PARCELS, so on a
   *  customs-free route unresolved lines no longer block create_shipment (they still
   *  block when a customs declaration must derive per-line weights/values). */
  parcel_override: boolean
  recipient: string
  route: string
  content_code: string | null
  /** Recipient ISO country (drives the EU customs-omission decision). */
  recipient_country: string | null
  /** The invoice contact id (recipient phone/address pre-fill source). */
  recipient_contact_id: string | null
  /**
   * Structured recipient address pre-filled from one source (address-check.ts): the
   * order's own ship-to first, else a verified delivery address, else the address
   * copied onto the LINKED CONTACT (`metadata.shipping_address`), else the invoice.
   * Lets a gated create_shipment resolve the street/city/postalCode/phone the
   * Boxtal body requires WITHOUT the operator re-keying an address already on
   * file. `null` when the contact carries no stored address (the operator then
   * supplies it on the approval card / via the create param).
   */
  recipient_address: RecipientAddressInput | null
  /** How the recipient address was chosen and whether it matches the customer's verified delivery
   *  address (address-check.ts). `no_verified` for a customer with none: nothing to show. */
  address_check?: AddressCheck
  /**
   * False for an intra-EU route with no override flag → the create body omits
   * `customsDeclaration` entirely (spec §C.3, "Domestic (EU) shipment").
   */
  customs_required: boolean
  /** The currency every customs article / parcel value is expressed in — always
   *  EUR, because that is what Boxtal declares in (fx.ts). NOT the invoice's
   *  currency, which stays on `lineSummaries`. */
  declared_currency: typeof DECLARED_CURRENCY
  /** The invoice-currency → EUR conversion applied to the declared values, with
   *  its provenance. Null when the invoice is already in EUR (nothing to
   *  convert) or when no rate could be derived — in the latter case the customs
   *  articles are blocked with `fx_unavailable`. Surfaced so the approval card
   *  can show the operator what rate the declaration was built at. */
  fx: FxConversion | null
  requote?: boolean
  /** The source invoice's issue date (YYYY-MM-DD or null) — the most operator-useful date on a
   *  shipment draft (a draft has no creation timestamp of its own; it is re-derived from the
   *  invoice each call). Surfaced for the create_shipment approval card. */
  invoice_issued_at: string | null
  /** The anchor document's display number and the store order it ships, so an approval card can
   *  say WHICH order a label is bought for (the draft id alone is a UUID nobody can check). */
  document_number: string | null
  order_name: string | null

  /** The org's persisted ship-from party (sender_address app config), surfaced so the
   *  create_shipment approval card can show a real From line without a DB read of its own
   *  (summarizers are pure; this rides in via the summarizerContext hydration). Null when the
   *  sender address was never configured. */
  sender: {
    name: string | null
    company: string | null
    street: string | null
    city: string | null
    postalCode: string | null
    countryIsoCode: string | null
  } | null
  /** The row's prep-grid category (prep_state.category; defaults "sale" when no row exists yet).
   *  Drives the customs declaration `reason` (see `customs_basis`) — a repair return or a gift
   *  is declared differently than a commercial sale even on the same physical parcel. */
  category: PrepCategory
  /** The Boxtal customs-declaration `reason` derived from `category` (categoryToCustomsBasis).
   *  Overrides the old is_return-only SALE/RETURN toggle at create time when the row carries an
   *  explicit category (repair/gift also get their own basis, not just outbound-vs-return). */
  customs_basis: CustomsBasis
  /** The invoicing document's OWN authoritative grand total in minor units (tax INCLUSIVE where the
   *  document is taxed), null when the source carries none — line unit prices are stored NET, so a
   *  sum of them is a subtotal, never a total. */
  document_total_minor: number | null
  /** Per-invoice-line (product_source, external_id, quantity, description, unit price) summary —
   *  ALWAYS populated regardless of whether the route requires a customs declaration
   *  (customsArticles is empty on an intra-EU route). Consumers that need a products summary or a
   *  grand total independent of customs applicability (e.g. the order-prep dashboard) read this
   *  instead of customsArticles. `unit_price_minor` + `currency` mirror the invoice line verbatim
   *  (minor units — never divide/multiply informally). */
  lineSummaries: Array<{
    external_id: string | null
    description: string
    /** Compact display code for the products summary: the line's shipping
     *  profile `short_code` when set, else initials derived from the
     *  description ("Hard Cover" -> "HC"). */
    label: string
    /** Invoicing line kind ("goods" | "software" | "shipping") — the products
     *  summary lists goods only; customs consumers keep every line. */
    line_kind: string
    quantity: number
    unit_price_minor: number
    currency: string
    /** The invoice line id, and its own HS code and origin (the print record's lines). */
    line_id?: string
    hs_code?: string | null
    country_of_origin?: string | null
  }>
  /** FULL invoice line totals (id, sku, invoice quantity) regardless of any batch
   *  subset — the denominator for partial-shipment remaining-quantity checks. */
  invoice_lines: Array<{ line_id: string; external_id: string | null; quantity: number }>
  /** Present only on a PARTIAL batch draft (a `lines` subset was requested): the
   *  subset's full-field lines, ready to become the batch proforma's items. */
  batch_lines?: Array<{
    line_id: string
    description: string
    quantity: number
    /** NET unit price, as the invoice stores it. */
    unit_price_minor: number
    /** The invoice line's tax rate, so the proforma can declare the same net value. */
    tax_rate_bp?: number | null
    currency: string
    hs_code: string | null
    country_of_origin: string | null
    customs_description: string | null
    external_id: string | null
  }>
}

/** Derive a compact 2-4 char product code from a free-text line description:
 *  initials of the first significant words ("Black Silicone Skin" -> "BSS",
 *  "Tessera 2" -> "T2"); single-word names take their first 3 letters uppercase. */
export function deriveShortCode(description: string): string {
  const head = (description.split(/\s+—\s+|\s+-\s+|[.,(]/)[0] ?? description).trim()
  const words = head.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).slice(0, 4)
  if (words.length === 0) return "?"
  if (words.length === 1) return (words[0] ?? "").slice(0, 3).toUpperCase()
  return words
    .map((w) => (/^\d+$/.test(w) ? w : (w[0] ?? "").toUpperCase()))
    .join("")
    .slice(0, 4)
}

// — quote (free read) —

export interface QuoteResult {
  offers: Offer[]
  /** Present when the v1 cotation API returned a typed `<error>` (e.g. an
   *  invalid postal code) — carries the verbatim Boxtal message so the UI/agent
   *  can surface the real reason rather than a generic tool failure. */
  error?: { code: string; message: string }
}

/** An offer enriched with a normalized, opt-in insurance cost. */
export interface OfferWithInsurance extends Offer {
  /** Insurance cost (excl. tax) when `insurance_value` was requested; `null`
   *  otherwise. Insurance is OPT-IN — we never silently insure by default. */
  insurancePriceExclTax: number | null
}

/**
 * Surface the already-parsed insurance cost on an offer, opt-in only.
 *
 * When the caller requests coverage (`insurance_value` present and positive),
 * the offer's parsed `insurance_ht` is normalized to `insurancePriceExclTax`.
 * When `insurance_value` is omitted, the result carries `null` — insurance is
 * never applied by default (a money boundary).
 */
export function buildOfferWithInsurance(
  offer: Offer,
  opts: { insurance_value?: number | null },
): OfferWithInsurance {
  const wantsInsurance =
    opts.insurance_value !== undefined &&
    opts.insurance_value !== null &&
    Number(opts.insurance_value) > 0
  return {
    ...offer,
    insurancePriceExclTax: wantsInsurance ? offer.insurance_ht : null,
  }
}

/**
 * Map any party-type vocabulary to the FRENCH value the live v1 cotation requires.
 * Callers may pass the v3 address vocabulary ("BUSINESS"/"RESIDENTIAL"), the French
 * value directly, or omit it — Boxtal v1 400s on anything but "entreprise"/"particulier".
 */
function cotationPartyType(raw: string | undefined, fallback: "entreprise" | "particulier"): string {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "entreprise" || v === "business") return "entreprise"
  if (v === "particulier" || v === "residential" || v === "private") return "particulier"
  return fallback
}

/**
 * Normalize a cotation input for the live v1 API: coerce party types to the French
 * vocabulary, and — when the caller omits the sender (the create-shipment UI's "Get
 * quotes" sends an empty `from`; the ship-from is org config, not per-shipment) —
 * enrich `from` from the persisted sender address. The recipient (`to`) is per-shipment
 * and stays the caller's; a missing `to.type` defaults to a consumer ("particulier").
 */
async function enrichCotation(ctx: ShipmentCtx, input: CotationInput): Promise<CotationInput> {
  let from = input.from as Partial<CotationParty> | undefined
  if (!from || !String(from.country ?? "").trim()) {
    const sender = await loadSenderParty(ctx)
    if (sender) {
      from = {
        country: sender.countryIsoCode ?? "",
        postalCode: sender.postalCode ?? "",
        city: sender.city ?? "",
        type: sender.type,
      }
    }
  }
  const to = (input.to ?? {}) as Partial<CotationParty>
  return {
    ...input,
    from: {
      country: from?.country ?? "",
      postalCode: from?.postalCode ?? "",
      city: from?.city ?? "",
      type: cotationPartyType(from?.type, "entreprise"),
      ...(from?.state ? { state: from.state } : {}),
    },
    to: {
      country: to.country ?? "",
      postalCode: to.postalCode ?? "",
      city: to.city ?? "",
      type: cotationPartyType(to.type, "particulier"),
      ...(to.state ? { state: to.state } : {}),
    },
  }
}

/**
 * When the caller passes a `draft_id`, default the route (`to`), `parcels`, and
 * `content_code` from the resolved draft so the agent does not re-key the
 * destination it already has on the draft. The destination COUNTRY is the field
 * a weak model most often drops when hand-building `to`, which silently fell the
 * quote back to a domestic route (a wrong, often non-shippable carrier set for an
 * export). The caller's explicit fields always win; only ABSENT fields are filled.
 */
async function enrichFromDraft(ctx: ShipmentCtx, input: CotationInput): Promise<CotationInput> {
  if (!input.draft_id) return input
  // A quote prices the route (country, postal code, city), which the invoice's address gives;
  // the order's ship-to (the phone a label buy needs) is not read for it.
  const draft = await shipmentDraftCreate(ctx, { document_ref: input.draft_id, orderShipTo: false })
  const addr = draft.recipient_address
  const to = (input.to ?? {}) as Partial<CotationParty>
  const filledTo: CotationParty = {
    country: String(to.country ?? "").trim() || addr?.countryIsoCode || draft.recipient_country || "",
    postalCode: String(to.postalCode ?? "").trim() || addr?.postalCode || "",
    city: String(to.city ?? "").trim() || addr?.city || "",
    type: to.type ?? "particulier",
    ...(to.state ? { state: to.state } : {}),
  }
  const parcels =
    input.parcels && input.parcels.length > 0
      ? input.parcels
      : draft.parcels.map((p) => ({
          weight: p.weight,
          length: p.length,
          width: p.width,
          height: p.height,
        }))
  return {
    ...input,
    to: filledTo,
    parcels,
    content_code: input.content_code ?? draft.content_code ?? undefined,
    value:
      input.value ??
      (draft.customsArticles.length > 0
        ? draft.customsArticles.reduce((s, a) => s + a.quantity * a.unitValue.value, 0)
        : undefined),
  }
}

/** Expand `{quantity: N, ...dims}` parcel entries into N identical parcels (cap
 *  20 total) — the natural way a model expresses "5 cartons of 19 kg". Without
 *  this the quantity field was silently ignored and the quote priced ONE parcel. */
export function expandParcelQuantities(
  parcels: CotationInput["parcels"],
): CotationInput["parcels"] {
  if (!parcels) return parcels
  const MAX_PARCELS = 20
  const out: NonNullable<CotationInput["parcels"]> = []
  for (const p of parcels) {
    const { quantity, ...dims } = p as { quantity?: unknown } & (typeof parcels)[number]
    const n =
      typeof quantity === "number" && Number.isFinite(quantity) && quantity >= 1
        ? Math.min(Math.floor(quantity), MAX_PARCELS)
        : 1
    for (let i = 0; i < n && out.length < MAX_PARCELS; i++) out.push({ ...dims })
  }
  return out
}

/** Dominant content category across the org's shipping profiles — the direct
 *  (no-draft) quote default. Boxtal's cotation 400s without `code_contenu`, and
 *  a weak model reliably omits the optional param, so a catalog-derived default
 *  turns "opaque HTTP 400" into a working quote for the org's usual goods. */
async function defaultContentCode(ctx: ShipmentCtx): Promise<string | null> {
  const rows = await loadVariantProfiles(ctx.db)
  const counts = new Map<string, number>()
  for (const r of rows) {
    const c = typeof r.content_category === "string" && r.content_category ? r.content_category : null
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [c, n] of counts) if (n > bestCount) (best = c), (bestCount = n)
  return best ? contentCategoryNumeric(best) : null
}

export async function quote(ctx: ShipmentCtx, input: CotationInput): Promise<QuoteResult> {
  const client = await getClientOrError(ctx)
  if ("error" in client) {
    return { offers: [], error: client.error }
  }
  const fromDraft = await enrichFromDraft(ctx, input)
  fromDraft.parcels = expandParcelQuantities(fromDraft.parcels)
  if (!fromDraft.content_code) {
    const fallback = await defaultContentCode(ctx)
    if (fallback) fromDraft.content_code = fallback
    else
      return {
        offers: [],
        error: {
          code: "content_code_required",
          message:
            "Direct quotes need a content_code (Boxtal rejects a cotation without one) and no product shipping profile carries a content category to default from. Pick a code with list_content_categories and pass it as content_code.",
        },
      }
  }
  const enriched = await enrichCotation(ctx, fromDraft)
  // Return leg: enrichment resolved the OUTBOUND route (from = org ship-from,
  // to = customer/draft recipient); a return ships the opposite way, so swap
  // the fully-built parties (each keeps its own type — the customer stays
  // "particulier", the org "entreprise"). Parcels/content/value are the same
  // goods travelling back and stay untouched.
  const routed = input.is_return ? { ...enriched, from: enriched.to, to: enriched.from } : enriched
  try {
    const offers = await client.v1.quote(routed)
    // Two org offer policies applied at THIS single chokepoint so they cover the
    // quote tool, quote_batch, the prep-dashboard cheapest, AND create_shipment's
    // execution/stage-time offer_code re-validation — a policy-excluded offer can be
    // neither surfaced nor shipped:
    //   1. Carrier allowlist: when set, only allowed carriers survive (empty =
    //      pass-through). See filterOffersByAllowlist. `ignore_allowlist:true`
    //      bypasses it for THIS quote only (ad-hoc "what else is out there" market
    //      look) by treating the allowlist as empty. The allowlist is an advisory
    //      GUIDELINE, not a hard gate: create_shipment's pre-buy re-quotes set
    //      ignore_allowlist so a gated, human-approved buy is never refused merely
    //      for shipping a non-allowlisted carrier (the approval is the guardrail).
    //   2. Pickup-point exclusion (default ON): relay / access-point delivery
    //      services are dropped so a door-to-door order is never quoted at a relay
    //      cheapest. `include_pickup_point:true` bypasses it for this call (the
    //      "customer wants a relay" case); the policy off is also pass-through.
    const allow = input.ignore_allowlist === true ? [] : await loadCarrierAllowlist(ctx)
    const excludePickup = (await loadExcludePickupPointServices(ctx)) && input.include_pickup_point !== true
    const allowed = filterOffersByAllowlist(offers, allow)
    return { offers: filterOffersByPickupPoint(allowed, excludePickup) }
  } catch (err) {
    // The v1 cotation `<error>` path throws a BoxtalApiError carrying the
    // verbatim French `<message>`. Surface it as a typed failure (empty offers
    // + the message) instead of letting it bubble into the kernel's generic
    // `tool_error` wrapper, which drops the message (spec §C.2 failure modes).
    if (err instanceof BoxtalApiError) {
      return { offers: [], error: { code: cotationErrorCode(err), message: err.message } }
    }
    throw err
  }
}

/** Boxtal refusing the route itself (an XML `<error>` on a 200, or a 400/404/422
 *  such as "code postal 250 invalide pour le code pays US") is a validation answer
 *  about the input: `cotation_invalid`, a 4xx the caller fixes. An auth refusal,
 *  a throttle, a 5xx or a transport failure stays `cotation_error`, an upstream
 *  fault. */
export function cotationErrorCode(err: BoxtalApiError): "cotation_invalid" | "cotation_error" {
  const s = err.status
  return s === 200 || s === 400 || s === 404 || s === 422 ? "cotation_invalid" : "cotation_error"
}

// — draft —

interface InvoiceResult {
  id: string
  /** The document's display number (INV-2026-0042), when issued. */
  number?: string | null
  currency: string
  /** The Shopify order this invoice was reconciled from, when any
   *  (`documents_get`'s top-level `shopify_order_id`). The only source of a
   *  trustworthy invoice-currency → EUR rate (fx.ts). */
  shopify_order_id?: string | null
  incoterm?: string
  counterparty_country?: string | null
  counterparty_name?: string | null
  counterparty_contact_id?: string | null
  /** Flattened multiline bill-to string snapshotted on the document — the
   *  quote-time fallback when the contact has no structured shipping_address. */
  counterparty_address?: string | null
  counterparty_email?: string | null
  /** Invoicing's customs flag (`requires_hs_code`) — wins the EU determination. */
  requires_hs_code?: boolean | null
  /** The source invoice's issue date (`documents_get`'s DocumentHeader.issued_at) — the most
   *  operator-useful date for a shipment draft (there is no separate "draft created" timestamp;
   *  the draft is virtual, re-derived from the invoice each call). Surfaced on ShipmentDraft so
   *  the create_shipment approval card can show it without an extra fetch. */
  issued_at?: string | null
  /** The document's authoritative grand total in minor units, tax INCLUSIVE (documents_get
   *  serialises the bigint column as a decimal STRING). */
  grand_total_minor?: string | number | null
  lines: Array<{
    id: string
    description: string
    quantity: number
    unit_price_minor: string | number
    /** The line's stored tax rate (basis points); the unit price beside it is NET. */
    tax_rate_bp?: number | null
    hs_code: string | null
    country_of_origin: string | null
    customs_description: string | null
    product_source: string | null
    external_id: string | null
    line_kind?: string | null
  }>
}

/** Coerce a minor-unit money field that may arrive as a decimal STRING (the bridge serialises
 *  bigint columns that way) to a finite number, or null when it is absent/unparseable. */
function toFiniteMinor(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** UUID v-any shape — documents_get resolves only a UUID id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True iff a documents_get envelope FAILED to return a usable invoice (error / null / non-completed) —
 *  i.e. the ref did not resolve to a real document, so a non-UUID ref is worth a search-resolve retry. */
function getEnvelopeMissed(env: { status?: unknown; result?: unknown }): boolean {
  return env.status !== "completed" || env.result == null
}

/**
 * Search-resolve a NON-UUID draft `document_ref` (an invoice NUMBER like "EMB-2026-8201", a human
 * reference, or a Shopify ORDER reference like "#2357") to the invoice's canonical id, via
 * documents_search. The agent — especially a flash-lite ROUTINE TICK executing a terse authored prompt —
 * very commonly hands the NUMBER/order-ref instead of the UUID (BL-228/BL-208, and the l712
 * order-check-prepare-shipment routine-tick crash). documents_get resolves only a UUID and 22P02s
 * ("invalid input syntax for type uuid") on a number — a backend crash that surfaced as "0 of N staged"
 * and failed the whole prepare sweep. Rather than make the tick thread the UUID-vs-number distinction
 * perfectly (l710 doctrine — make the surface robust, don't rely on the weak model getting it right), we
 * search by the ref and return the matching document's id. Returns null when nothing matches (the caller
 * then raises the readable not-found-with-hint error). Never SWALLOWS a real failure — it only
 * auto-resolves a ref that DOES name a real invoice, turning a guaranteed 22P02 crash into the right draft.
 */
async function resolveDocumentRefBySearch(ctx: ShipmentCtx, ref: string): Promise<string | null> {
  const env = await ctx.executeTool("invoicing:documents_search", { query: ref, limit: 10 })
  if (env.status !== "completed" || env.result == null) return null
  const rows = (Array.isArray(env.result) ? env.result : []) as {
    id?: string
    number?: string | null
    status?: string | null
    shopify_order_id?: string | null
  }[]
  if (rows.length === 0) return null
  // Prefer an EXACT match on the number or the shopify_order_id (the two stable references the agent would
  // pass), preferring an ISSUED document; else the first issued; else the first row.
  const exact = rows.find((r) => r.number === ref || r.shopify_order_id === ref)
  const issued = rows.find((r) => r.status === "issued")
  const pick = exact ?? issued ?? rows[0]
  return typeof pick?.id === "string" && pick.id.length > 0 ? pick.id : null
}

/** A documents_search `include_lines` row — the InvoiceResult shape a caller can
 *  hand to shipmentDraftCreate to skip the per-document documents_get execution
 *  (the bulk worklist path: one hydrated search instead of N gets). */
export type PreloadedDocument = InvoiceResult

/** One requested line of a PARTIAL shipment batch: ship `quantity` units of the
 *  invoice line `line_id` now. Omitting `lines` keeps the legacy full-invoice draft. */
export interface PartialLineInput {
  line_id: string
  quantity: number
}

/** Restrict an invoice's lines to a requested batch subset. Throws a readable
 *  error on an unknown line_id, a non-positive quantity, or a quantity above
 *  the invoice line's own quantity (the per-batch remaining check against OTHER
 *  live batches happens at reserve time, where the sibling rows are known). */
function applyLineSubset(doc: InvoiceResult, lines: PartialLineInput[]): InvoiceResult {
  if (lines.length === 0) throw new Error("Partial shipment lines must not be empty; omit lines for a full shipment.")
  const byId = new Map(doc.lines.map((l) => [l.id, l]))
  const subset = lines.map((req) => {
    const line = byId.get(req.line_id)
    if (!line) {
      throw new Error(
        `Unknown invoice line "${req.line_id}" for a partial shipment; valid line ids: ${doc.lines.map((l) => l.id).join(", ")}.`,
      )
    }
    if (!Number.isFinite(req.quantity) || req.quantity <= 0) {
      throw new Error(`Partial shipment quantity for line "${req.line_id}" must be a positive number.`)
    }
    if (req.quantity > line.quantity) {
      throw new Error(
        `Partial shipment quantity ${req.quantity} exceeds the invoice quantity ${line.quantity} for line "${req.line_id}".`,
      )
    }
    return { ...line, quantity: req.quantity }
  })
  // The document's grand total covers the WHOLE invoice, so it does not describe this batch:
  // drop it and let the subset draft fall back to its own line sum.
  return { ...doc, lines: subset, grand_total_minor: null }
}

export async function shipmentDraftCreate(
  ctx: ShipmentCtx,
  input: {
    document_ref: string
    preloaded_document?: PreloadedDocument
    lines?: PartialLineInput[]
    /** false: a worklist resolve that reads the draft's facts, never its recipient for a label,
     *  so it skips the Shopify order read the recipient's ship-to may need. */
    orderShipTo?: boolean
  },
): Promise<ShipmentDraft> {
  const build = { orderShipTo: input.orderShipTo !== false }
  if (input.preloaded_document && input.preloaded_document.id === input.document_ref) {
    const doc = input.lines ? applyLineSubset(input.preloaded_document, input.lines) : input.preloaded_document
    return buildDraftFromDoc(ctx, doc, input.lines ? input.preloaded_document : undefined, build)
  }
  const looksLikeUuid = UUID_RE.test(input.document_ref)
  // TRY documents_get with the ref as-is first (the common, fast path: a UUID resolves directly). If that
  // MISSES (error/null) AND the ref is a NON-UUID, it is almost certainly the invoice NUMBER / order
  // reference the agent passed by mistake (a raw get on a number 22P02s at pg — the l712 tick crash). Then
  // SEARCH-RESOLVE the ref to the invoice's real id and retry the get with that id, so the draft opens
  // instead of crashing. A UUID miss is a genuine not-found (no retry). This is the l710 surface-robustness
  // fix: the tick no longer has to thread the UUID-vs-number distinction perfectly.
  let env: Awaited<ReturnType<typeof ctx.executeTool>>
  // A non-UUID ref reaching the pg id column can 22P02 ("invalid input syntax for type uuid") — depending
  // on the bridge that surfaces as an `{status:"error"}` envelope OR a thrown error. Treat BOTH as a "miss"
  // for a non-UUID ref so the search-resolve retry fires in either case; a UUID miss is a genuine not-found.
  let missed: boolean
  try {
    env = await ctx.executeTool("invoicing:documents_get", { id: input.document_ref })
    missed = getEnvelopeMissed(env)
  } catch (e) {
    if (looksLikeUuid) throw e // a UUID that errored is a real failure — never masked
    env = { status: "completed", result: null } as Awaited<ReturnType<typeof ctx.executeTool>>
    missed = true
  }
  if (missed && !looksLikeUuid) {
    const resolved = await resolveDocumentRefBySearch(ctx, input.document_ref)
    if (resolved && resolved !== input.document_ref) {
      env = await ctx.executeTool("invoicing:documents_get", { id: resolved })
    }
  }
  const refHint = looksLikeUuid
    ? ""
    : `. shipment_draft_create needs the invoice's id (a UUID), not its number/reference "${input.document_ref}"; find the invoice with invoicing__documents_search and pass its id.`
  if (env.status === "pending_approval") {
    throw new Error(`invoicing:documents_get returned pending_approval (${env.approval_id})`)
  }
  if (env.status === "error") {
    // The K4 type guarantees `error:{code,message}`, but a malformed/transient error envelope can arrive
    // with `error` undefined at runtime — reading `env.error.message` then threw a raw TypeError ("cannot
    // read property 'message' of undefined") that surfaced as `handler_outcome_unknown` and false-failed the
    // gated create_shipment ([[BL-208]]). Read the message defensively so we always raise a readable error.
    const errObj = (env as { error?: { message?: unknown } }).error
    const detail =
      typeof errObj?.message === "string"
        ? errObj.message
        : errObj
          ? JSON.stringify(errObj)
          : "unknown error"
    throw new Error(`invoicing:documents_get failed: ${detail}${refHint}`)
  }
  if (env.status !== "completed") {
    // Defensive: an unexpected/missing status would otherwise read `.result`/`.lines` off undefined and
    // crash the same way. Surface it as a clean error instead.
    throw new Error(
      `invoicing__documents_get returned an unexpected envelope (status=${String((env as { status?: unknown }).status)})`,
    )
  }
  // A "completed" envelope can still carry a NULL result: documents_get returns null for an invoice it
  // cannot find (a wrong/foreign ref — e.g. the number instead of the UUID id — or a non-existent id).
  // Reading `doc.id`/`doc.lines` off a null `doc` otherwise threw a raw "cannot read property 'id' of
  // null" TypeError that surfaced as handler_outcome_unknown and false-failed the gated create_shipment
  // ([[BL-208]]). Guard it: raise a readable, recoverable error (with the same UUID-vs-number hint).
  if (env.result == null) {
    // A ToolError (app-sdk) marks this message safe to surface even when boxtal
    // runs untrusted in production: without it the untrusted-prod redaction
    // flattens this to an opaque "Tool execution failed", the agent cannot see
    // WHY the draft failed, and a weak model retries the same doomed call with
    // different id formats for dozens of steps (the token-runaway class). The
    // message is caller-actionable and carries no secrets/internals. refHint (if
    // present) keeps the UUID-vs-number nuance for the number-passed-as-ref case.
    throw new ToolError(
      `No invoicing document found for "${input.document_ref}": a return/shipment draft must be anchored to a document. If you passed an order NUMBER (e.g. #1846), check invoicing__documents_for_orders for its invoice id and pass that. If the order has NO invoice at all (intra-EU orders often do not), create a nominal-value proforma (invoicing__proforma_create_and_issue, line "RETURN FOR REPAIR - NO COMMERCIAL VALUE", value from boxtal__settings_packaging_policy_get) and open the draft from that proforma. Do NOT retry this call with different id formats.${refHint}`,
      { code: "no_anchor_document", retryable: false },
    )
  }
  const doc = env.result as InvoiceResult
  return buildDraftFromDoc(
    ctx,
    input.lines ? applyLineSubset(doc, input.lines) : doc,
    input.lines ? doc : undefined,
    build,
  )
}

/**
 * Resolve the invoice-currency → EUR rate for a non-EUR invoice, from the
 * Shopify order the invoice was reconciled from (the exact rate Shopify itself
 * applied — see fx.ts for why we do not use an FX feed). Returns null when the
 * invoice has no linked order, the order cannot be read, or its totals cannot
 * answer; the caller then blocks the customs articles rather than declaring a
 * foreign amount as EUR. Never throws: an FX lookup failure must degrade to
 * "operator enters the value", not crash the draft.
 */
/** One `shopify:orders_get` per draft build, however many of its readers ask (FX, ship-to). */
function orderReader(
  ctx: ShipmentCtx,
  doc: InvoiceResult,
): () => Promise<{ status?: string; result?: unknown } | null> {
  let read: Promise<{ status?: string; result?: unknown } | null> | null = null
  return () => {
    const orderId = doc.shopify_order_id ?? null
    if (!orderId) return Promise.resolve(null)
    read ??= ctx
      .executeTool("shopify:orders_get", { id: toShopifyOrderGid(orderId) })
      .then((env) => env as { status?: string; result?: unknown })
      .catch(() => null)
    return read
  }
}

async function resolveFxToDeclared(
  readOrder: () => Promise<{ status?: string; result?: unknown } | null>,
  doc: InvoiceResult,
): Promise<FxConversion | null> {
  try {
    const env = await readOrder()
    if (!env) return null
    if (env.status !== "completed" || env.result == null) return null
    const attrs = (env.result as { attributes?: Record<string, unknown> }).attributes
    if (!attrs || typeof attrs !== "object") return null
    return deriveShopifyOrderRate(doc.currency, {
      totalAmount: attrs.totalAmount as string | number | null | undefined,
      totalAmountShop: attrs.totalAmountShop as string | number | null | undefined,
      shopCurrency: attrs.shopCurrency as string | null | undefined,
    })
  } catch {
    return null
  }
}

/**
 * The blocking message for a draft whose customs articles cannot ship. Weight
 * and FX are different defects with different fixes, so the message must name
 * the right one: telling an operator to "resolve the weight" on a US invoice
 * whose value could not be converted sends them looking in the wrong place.
 */
function blockedArticlesMessage(draft: ShipmentDraft): string {
  if (draft.customsArticles.some((a) => a.blocked && a.reason === "fx_unavailable")) {
    const from = draft.fx?.from ?? "the invoice currency"
    return (
      `This invoice is in ${from} and Boxtal declares in ${DECLARED_CURRENCY}, but no conversion rate ` +
      `could be derived (the invoice has no linked Shopify order, or the order carries no ${DECLARED_CURRENCY} total). ` +
      `Set each article's value in ${DECLARED_CURRENCY} with shipment_draft_set_customs (patch.unitValue, a number) before creating the shipment. ` +
      `sending the invoice figure unconverted would over-declare the parcel at customs.`
    )
  }
  return "Some customs articles are missing a weight; resolve them before creating a shipment."
}

async function buildDraftFromDoc(
  ctx: ShipmentCtx,
  doc: InvoiceResult,
  original?: InvoiceResult,
  build: { orderShipTo: boolean } = { orderShipTo: true },
): Promise<ShipmentDraft> {
  // Load the catalog + any persisted operator overrides for this draft, plus the row's prep-grid
  // category (prep_state.category — defaults "sale" when no row exists yet, e.g. the invoice was
  // never touched via prep_set_category).
  //
  // An ORDER-LESS row (prep_add_shipment, e.g. the return-after-repair flow) has no `prep_state`
  // row at all: it records BOTH its category and its structured recipient on `prep_order_state`,
  // anchored by `proforma_document_ref`. Reading only `prep_state` silently declared those parcels
  // as a SALE at customs and dropped the structured address, so the cotation went out with no
  // postal code and came back "No offers". Load it in the SAME round-trip.
  const [profiles, packs, components, override, prepStateRows, orderStateRows, senderParty, packagingPolicy, orderName] =
    await Promise.all([
      // Short codes come from the product attributes first (product-attributes.ts), the
      // profile's own code being the fallback.
      loadVariantProfiles(ctx.db).then((rows) => withAttributeShortCodes(ctx, rows)) as Promise<CatalogProfile[]>,
      ctx.db.findMany("pack", { limit: 1000 }) as Promise<CatalogPack[]>,
      ctx.db.findMany("pack_component", { limit: 1000 }) as Promise<CatalogPackComponent[]>,
      loadDraftOverride(ctx, doc.id),
      ctx.db.findMany("prep_state", { where: { document_ref: doc.id }, limit: 1 }) as Promise<
        Array<{ category?: string | null }>
      >,
      ctx.db.findMany("prep_order_state", {
        where: { proforma_document_ref: doc.id },
        limit: 1,
      }) as Promise<Array<{ category?: string | null; recipient?: unknown }>>,
      loadSenderParty(ctx),
      loadPackagingPolicy(ctx),
      loadOrderName(ctx, doc.id),
    ])
  const orderStateRow = orderStateRows[0] ?? null
  // The order-state row's category wins when it is set; otherwise fall back to the per-document
  // prep_state row exactly as before.
  const category = resolvePrepCategory(orderStateRow?.category ? orderStateRow : prepStateRows[0])

  // Only parcel lines reach the resolver and the customs declaration (shippable-lines.ts): a
  // shipping charge or a text line packs nothing and is not goods, so it must neither come back
  // unresolved nor become a weightless customs article that blocks the label. A real product line
  // is always a parcel line, so goods are never left off a declaration.
  const parcelLines = doc.lines.filter(isParcelLine)
  const resolverLines: ResolverLine[] = parcelLines.map((l) => ({
    id: l.id,
    product_source: l.product_source,
    external_id: l.external_id,
    quantity: l.quantity,
  }))
  const resolved = resolvePackages({ lines: resolverLines, profiles, packs, components, policy: packagingPolicy })

  const profilesByRef: Record<string, { unit_weight: number; short_code: string | null }> = {}
  for (const p of profiles)
    profilesByRef[`${p.product_source}:${p.product_id}`] = {
      unit_weight: p.unit_weight,
      short_code: p.short_code ?? null,
    }

  const docLines: CustomsDocLine[] = parcelLines.map((l) => ({
    id: l.id,
    description: l.description,
    quantity: l.quantity,
    unit_price_minor: BigInt(String(l.unit_price_minor)),
    hs_code: l.hs_code,
    country_of_origin: l.country_of_origin,
    customs_description: l.customs_description,
    product_source: l.product_source,
    external_id: l.external_id,
  }))

  // Determine whether this route needs a customs declaration at all. Intra-EU
  // routes omit it (spec §C.3 / "Domestic (EU) shipment"); the invoice's
  // `requires_hs_code` flag wins when present.
  const senderCountry = await senderCountryOf(ctx)
  const recipientCountry = doc.counterparty_country ?? ""
  const customsRequired = requiresCustoms(
    senderCountry,
    recipientCountry,
    doc.requires_hs_code ?? undefined,
  )

  // Boxtal declares in EUR whatever we send it, so a non-EUR invoice needs a
  // rate BEFORE the articles are built (ticket-10154). Only fetched on the rare
  // non-EUR export — an EUR invoice costs nothing here.
  const readOrder = orderReader(ctx, doc)
  const needsFx =
    customsRequired && String(doc.currency ?? "").toUpperCase() !== DECLARED_CURRENCY
  const fx = needsFx ? await resolveFxToDeclared(readOrder, doc) : null

  // Customs articles are built only when the route requires a declaration; an
  // intra-EU route surfaces zero articles so the create body omits the block.
  const customsArticles = customsRequired
    ? buildCustomsArticles(
        docLines,
        { incoterm: doc.incoterm ?? "DAP", currency: doc.currency },
        profilesByRef,
        {
          ...(override?.customsByLineId
            ? { overrides: toArticleOverrides(override.customsByLineId) }
            : {}),
          fx,
        },
      )
    : []

  // Apply a persisted parcel override (an ad-hoc carton / re-pack) over the
  // resolved set; otherwise use the resolver's parcels.
  const parcels = override?.parcels ?? resolved.parcels

  // Dominant content category from the first profiled line (single per quote).
  const firstCategory = profiles.find((p) => p.content_category)?.content_category ?? null
  const content_code = firstCategory ? contentCategoryNumeric(firstCategory) : null

  // The recipient's address. Every candidate is read, then ONE source names the place
  // (address-check.ts has the precedence): the operator's prep recipient, the order's own ship-to,
  // a verified delivery address from the contact's address book when the order carries none, the
  // address copied onto the contact, the customer's default address, the invoice text. Other
  // sources fill gaps (a phone, a state) only when they name the same place, so a label never
  // carries one address's street with another's postal code or phone.
  const fallback = {
    name: doc.counterparty_name ?? null,
    email: doc.counterparty_email ?? null,
    countryIsoCode: recipientCountry || null,
  }
  const contactId = doc.counterparty_contact_id ?? null
  const [contactAddress, verified, cachedShipTo] = await Promise.all([
    loadContactShippingAddress(ctx, contactId, { name: fallback.name, countryIsoCode: fallback.countryIsoCode }),
    loadVerifiedDeliveryAddresses(ctx, contactId, fallback),
    // The cache serves the worklist only: the label path reads the order or refuses.
    doc.shopify_order_id && !build.orderShipTo
      ? loadCachedShipTo(ctx, doc.id)
      : Promise.resolve<ShipToCacheEntry>({ known: false }),
  ])
  // The order's ship-to. The label path reads the order (one read per build, shared with the FX
  // lookup; the paid path never trusts a cache). A worklist build never reads it and uses the
  // ship-to prep_sync cached, and only to let the order beat a contact copy or a verified
  // address: with neither, the invoice text already describes the order's place, as before.
  // Read, never written: the draft is rebuilt by every quote, rate check and staged booking, and a
  // contact write from here was held for approval in a conversation whose writes park, so each
  // rebuild raised one more identical approval. The prep grid's sync owns the write.
  let shipTo: CachedShipTo | null = null
  // Whether the draft knows what the order says about its address (an address, or none at all).
  let orderKnown = false
  // The label path's order read failed AND the customer has a verified delivery address. The
  // order may ship anywhere, so neither that address nor a cached ship-to (up to 12 h old) may
  // stand in for it: the buy refuses (addressPickBlock) and the operator retries. A customer with
  // no verified address keeps the legacy precedence (contact, then invoice text), unrefused.
  let orderReadFailed = false
  if (doc.shopify_order_id) {
    if (build.orderShipTo) {
      const env = await readOrder()
      const meta = env ? shopifyOrderMetaOf(env) : null
      if (meta) {
        // A read order with no address has none.
        shipTo = meta.ship_to
        orderKnown = true
      } else if (verified.length > 0) orderReadFailed = true
    } else if (contactAddress || verified.length > 0) {
      // The cache tells "the order has no address" apart from "never read" (prep-meta.ts).
      if (cachedShipTo.known) {
        shipTo = cachedShipTo.shipTo
        orderKnown = true
      }
    }
  }
  const orderRead = Boolean(doc.shopify_order_id) && orderKnown
  const shipToAddress = shipTo ? recipientFromShopifyAddress(shipTo.address, fallback) : null
  // The invoice that generated this row already carries the customer's address as a flattened
  // multiline string (street lines + "zip city"); parse it so a quote works even before the
  // contact's structured shipping_address is backfilled.
  const invoiceAddress = parseInvoiceAddress(doc.counterparty_address ?? null, fallback)
  // The order-less row's OWN structured recipient, typed straight into the prep grid by the
  // operator. An order-less proforma has no Shopify order and usually no linked contact, so
  // without it the whole address fell to the free-text parse and shipped without a postal code.
  const prepAddress = recipientFromOrderState(orderStateRow?.recipient, fallback)
  const addressSources: AddressSources = {
    choice: null,
    prep: prepAddress,
    order: shipTo?.source === "order" ? shipToAddress : null,
    orderUnknown: Boolean(doc.shopify_order_id) && !orderRead,
    verified,
    contact: contactAddress,
    customerDefault: shipTo?.source === "customer" ? shipToAddress : null,
    invoice: invoiceAddress,
  }
  let resolvedRecipient = resolveRecipient(addressSources)
  // The order and the verified address differ: the label goes where a person said, as long as
  // neither address changed since the pick. Read only in that case, so a customer with no
  // verified address costs nothing more.
  if (resolvedRecipient.check.state === "differs" && doc.shopify_order_id) {
    const stored = await loadAddressChoice(ctx, doc.shopify_order_id)
    resolvedRecipient = applyAddressChoice(addressSources, resolvedRecipient, stored)
  }
  if (orderReadFailed) resolvedRecipient = { ...resolvedRecipient, check: { ...resolvedRecipient.check, order_read: "failed" } }
  const recipientAddress = resolvedRecipient.address

  return {
    document_ref: doc.id,
    // Surface the SAME id as `draft_id` so the tick chains shipment_draft_create →
    // set_package/quote/create_shipment by reading `draft_id` straight off this
    // result (it === document_ref, the invoice UUID). Closes the "draft identifier
    // format" chaining gap that staged nothing (l710 surface robustness).
    draft_id: doc.id,
    parcels,
    parcel_override: Boolean(override?.parcels),
    customsArticles,
    unresolved: resolved.unresolved,
    packing_warnings: override?.parcels ? [] : resolved.warnings,
    recipient: doc.counterparty_name ?? "",
    route: recipientCountry,
    recipient_country: recipientCountry || null,
    recipient_contact_id: doc.counterparty_contact_id ?? null,
    recipient_address: recipientAddress,
    address_check: resolvedRecipient.check,
    customs_required: customsRequired,
    declared_currency: DECLARED_CURRENCY,
    fx,
    content_code,
    invoice_issued_at: doc.issued_at ?? null,
    document_number: doc.number ?? null,
    order_name: orderName,
    sender: senderParty
      ? {
          name: senderParty.name ?? null,
          company: senderParty.company ?? null,
          street: senderParty.street ?? null,
          city: senderParty.city ?? null,
          postalCode: senderParty.postalCode ?? null,
          countryIsoCode: senderParty.countryIsoCode ?? null,
        }
      : null,
    category,
    customs_basis: categoryToCustomsBasis(category),
    // The document's own grand total (tax inclusive) — arrives as a decimal STRING like
    // `quantity` does, so coerce and drop anything non-finite rather than surfacing NaN.
    document_total_minor: toFiniteMinor(doc.grand_total_minor),
    lineSummaries: doc.lines.map((l) => {
      const profile = l.product_source ? profilesByRef[`${l.product_source}:${l.external_id}`] : undefined
      return {
        external_id: l.external_id,
        description: l.customs_description ?? l.description,
        label: profile?.short_code || deriveShortCode(l.description || l.customs_description || "?"),
        line_kind: l.line_kind ?? "goods",
        // Invoicing quantities arrive as decimal STRINGS ("01.000") — the old
        // pass-through is why the products summary read "01.000xWidget 2".
        quantity: Number(l.quantity),
        unit_price_minor: Number(l.unit_price_minor),
        currency: doc.currency,
        line_id: l.id,
        hs_code: l.hs_code ?? null,
        country_of_origin: l.country_of_origin ?? null,
      }
    }),
    invoice_lines: (original ?? doc).lines.map((l) => ({
      line_id: l.id,
      external_id: l.external_id,
      quantity: Number(l.quantity),
    })),
    ...(original
      ? {
          batch_lines: doc.lines.map((l) => ({
            line_id: l.id,
            description: l.description,
            quantity: Number(l.quantity),
            unit_price_minor: Number(l.unit_price_minor),
            tax_rate_bp: l.tax_rate_bp ?? null,
            currency: doc.currency,
            hs_code: l.hs_code ?? null,
            country_of_origin: l.country_of_origin ?? null,
            customs_description: l.customs_description ?? null,
            external_id: l.external_id ?? null,
          })),
        }
      : {}),
    ...(override?.requote ? { requote: true } : {}),
  }
}

/**
 * Read the linked contact's stored shipping address from the kernel contact
 * record (`metadata.shipping_address` — `{ street, city, postalCode, phone,
 * countryIsoCode? }`) via the host `kernel:contacts_read` cross-app call (declared
 * in the manifest's `cross_app_calls`). Returns a `RecipientAddressInput` with the
 * stored structured fields, defaulting the name/country from the invoice. Returns
 * `null` when there is no contact, no stored address, or the read degrades — never
 * throws (a missing address is handled downstream by the create-time hard-fail with
 * a precise `recipient_address_required`, not a crash here).
 */
/** Coerce a jsonb value into a plain object — parses a JSON string (double-encoded upstream), and
 *  returns null for any non-object/array/primitive. Keeps the address read robust to encoding drift. */
function coerceObject(value: unknown): Record<string, unknown> | null {
  let v = value
  if (typeof v === "string") {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

/** Postcodes that carry a space and LEAD the locality line, by country: the generic
 *  "<digit token> <city>" rule cuts them at the space ("1114 BC Amsterdam" became postcode "1114",
 *  city "BC Amsterdam", and Boxtal refused the quote). NL is 4 digits + 2 capital letters; SE, CZ,
 *  SK and GR are 3 + 2 digits. Codes without a space (FR, DE, PL "00-950", PT "1000-001") and codes
 *  that do not lead the line (GB, CA, IE) keep the generic rule. */
const SPACED_LEADING_POSTCODE: Record<string, RegExp> = {
  NL: /^(\d{4} ?[A-Z]{2})(?:\s+(.+))?$/,
  SE: /^(\d{3} ?\d{2})(?:\s+(.+))?$/,
  CZ: /^(\d{3} ?\d{2})(?:\s+(.+))?$/,
  SK: /^(\d{3} ?\d{2})(?:\s+(.+))?$/,
  GR: /^(\d{3} ?\d{2})(?:\s+(.+))?$/,
}
const GENERIC_LEADING_POSTCODE = /^(\d[\dA-Za-z-]*)\s+(.+)$/

/** Split "<postcode> <city>" by the country's postcode shape. Returns null when the text does not
 *  start with a postcode followed by a city. */
function splitLeadingPostcode(text: string, country: string | null): { postalCode: string; city: string } | null {
  const spaced = country ? SPACED_LEADING_POSTCODE[country.toUpperCase()] : undefined
  const m = spaced?.exec(text)
  if (m?.[2]) return { postalCode: m[1]!, city: m[2] }
  const g = GENERIC_LEADING_POSTCODE.exec(text)
  return g ? { postalCode: g[1]!, city: g[2]! } : null
}

/** Split a SINGLE-line, comma-separated postal address into street / postcode / city / region.
 *  Two unambiguous shapes are recognised, both anchored on a part that starts with a digit:
 *    "<street>, <postcode>, <city>[, <region>]"  — a part that is a bare postcode token
 *    "<street>, <postcode> <city>[, <region>]"   — a part that is "<postcode> <city>"
 *  Anything else (no digit-leading part, or nothing before it to be the street) returns null and
 *  the caller keeps its multiline rule. */
function splitSingleLineAddress(line: string, country: string | null): {
  street: string | null
  postalCode: string | null
  city: string | null
  region: string | null
} | null {
  const parts = line
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
  if (parts.length < 2) return null
  const bare = /^\d[\dA-Za-z-]*$/
  // Scan from the END: the locality sits after the street, and a street number ("4 Industriveien")
  // would otherwise be mistaken for the postcode.
  for (let i = parts.length - 1; i >= 1; i--) {
    const part = parts[i]!
    const spacedBare = country ? SPACED_LEADING_POSTCODE[country.toUpperCase()]?.exec(part) : null
    if ((bare.test(part) || (spacedBare && !spacedBare[2])) && parts.length > i + 1) {
      return {
        street: parts.slice(0, i).join(", ") || null,
        postalCode: part,
        city: parts[i + 1]!,
        region: parts.slice(i + 2).join(", ") || null,
      }
    }
    const m = splitLeadingPostcode(part, country)
    if (m) {
      return {
        street: parts.slice(0, i).join(", ") || null,
        postalCode: m.postalCode,
        city: m.city.trim() || null,
        region: parts.slice(i + 1).join(", ") || null,
      }
    }
  }
  return null
}

/** The US order of an address: the ZIP comes LAST, after the city and the
 *  state ("250 W 57th St, New York, NY 10019", or "250 W 57th St\nNew York, NY
 *  10019"). Read with the zip-first rule, the leading street number became the
 *  postal code and Boxtal refused the quote ("code postal 250 invalide pour
 *  US"). Returns null when the address does not end in "<state> <ZIP>". */
function splitUsAddress(lines: string[]): {
  street: string | null
  city: string | null
  state: string
  postalCode: string
} | null {
  const joined = lines.join(", ")
  // "NY 10025" first; then a spelled-out state ("New York 10025"), kept only when it names one.
  const m =
    joined.match(/^(.*?)[,\s]+([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/) ??
    [joined.match(/^(.*?),\s*([A-Za-z][A-Za-z .]*?)\s+(\d{5}(?:-\d{4})?)$/)].find(
      (f) => f != null && normalizeRegion("US", f[2]) != null,
    ) ??
    null
  if (!m) return null
  // Street and city: the city is the part after the last comma before the state.
  const before = m[1]!.trim()
  const comma = before.lastIndexOf(",")
  if (comma === -1) return null
  const city = before.slice(comma + 1).trim()
  if (!city) return null
  return { street: before.slice(0, comma).trim() || null, city, state: m[2]!, postalCode: m[3]! }
}

/** Structured recipient stored on an order-less prep row (`prep_order_state.recipient`), coerced
 *  into the draft's `RecipientAddressInput`. Blank strings are dropped so the per-field merge can
 *  fall through to the next source; a row carrying nothing usable returns null. */
function recipientFromOrderState(
  raw: unknown,
  fallback: { name: string | null; email: string | null; countryIsoCode: string | null },
): RecipientAddressInput | null {
  const r = coerceObject(raw)
  if (!r) return null
  const str = (k: string): string | null => {
    const v = r[k]
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null
  }
  const countryIsoCode =
    str("countryIsoCode") ?? str("country_iso_code") ?? str("country") ?? fallback.countryIsoCode
  const out: RecipientAddressInput = {
    name: str("name") ?? fallback.name,
    company: str("company"),
    email: str("email") ?? fallback.email,
    phone: str("phone"),
    street: str("street"),
    city: str("city"),
    postalCode: normalizePostalCode(str("postalCode") ?? str("postal_code"), countryIsoCode),
    countryIsoCode,
    state: normalizeRegion(countryIsoCode, str("state") ?? str("province")),
  }
  // Nothing postal stored (a row that only ever held a name) -> behave as "no stored recipient"
  // rather than pinning a name that would shadow a better source's.
  if (!out.street && !out.city && !out.postalCode && !out.phone) return null
  return out
}

/** The postcode shape of countries whose code LEADS the locality line, by length or pattern. Only
 *  used to recognise a "<postcode> <city>" line ABOVE an unrecognised last line (below): strict, so
 *  a street number ("12 rue de la Paix") is never taken for a postcode. */
const STRICT_LEADING_POSTCODE: Record<string, RegExp> = (() => {
  const out: Record<string, RegExp> = {}
  const set = (codes: string, re: RegExp) => {
    for (const c of codes.split(" ")) out[c] = re
  }
  set("DE FR IT ES FI EE HR MC LT TR UA RS ME MA DZ MX MY TH ID SA BA", /^\d{5}$/)
  set("AT BE BG CH DK HU LU NO SI LI MK AL CY TN AM GE AU NZ PH ZA IS", /^\d{4}$/)
  set("RO RU IN CN SG", /^\d{6}$/)
  out.PL = /^\d{2}-\d{3}$/
  out.PT = /^\d{4}-\d{3}$/
  out.JP = /^\d{3}-\d{4}$/
  out.NL = /^\d{4} ?[A-Z]{2}$/
  for (const c of ["SE", "CZ", "SK", "GR"]) out[c] = /^\d{3} ?\d{2}$/
  return out
})()

/** Fallback for a last line that is neither a locality nor a listed name of the destination
 *  country ("Germanien", a misspelling, another language): when the line ABOVE it is
 *  "<postcode> <city>" in the destination country's postcode shape, or the last line names any
 *  listed country, the line above is the locality and the last line is the country. Without it,
 *  the country became the city, the postcode line was folded into the street and the quote was
 *  sent with no postal code. */
function dropUnrecognisedCountryLine(lines: string[], iso: string | null): string[] {
  if (lines.length < 2) return lines
  const last = lines[lines.length - 1]!
  if (/\d/.test(last) || splitLeadingPostcode(last, iso)) return lines
  const above = splitLeadingPostcode(lines[lines.length - 2]!, iso)
  if (!above) return lines
  const strict = iso ? STRICT_LEADING_POSTCODE[iso.trim().toUpperCase()] : undefined
  const shaped = strict ? strict.test(above.postalCode) : false
  if (shaped || countryIsoFromName(last) != null) return lines.slice(0, -1)
  return lines
}

/** The country is carried separately (`countryIsoCode`), so a trailing "USA" / "France", as its
 *  own line or as the last comma part of the last line, is noise that would otherwise be read as
 *  the city and hide the real locality. */
function stripTrailingCountry(lines: string[], iso: string | null): string[] {
  const out = [...lines]
  const last = out[out.length - 1]
  if (last == null) return out
  const country = /^(?:country|pays)\s*:\s*(.*)$/i.exec(last)
  if (namesCountry(country ? country[1]! : last, iso)) {
    out.pop()
    return out
  }
  const parts = last.split(",")
  if (parts.length > 1 && namesCountry(parts[parts.length - 1]!, iso)) {
    out[out.length - 1] = parts.slice(0, -1).join(",").trim()
  }
  return out
}

const ADDRESS_LABELS: Array<[RegExp, "street" | "city" | "postalCode" | "region" | "country"]> = [
  [/^(?:street|address(?: line)?(?: ?\d)?|adresse|rue)$/i, "street"],
  [/^(?:city|town|ville|localit[eé])$/i, "city"],
  [/^(?:postal ?code|post ?code|zip(?: ?code)?|code postal|cp)$/i, "postalCode"],
  [/^(?:state|province|region|r[eé]gion|county)$/i, "region"],
  [/^(?:country|pays)$/i, "country"],
]

/** Read an address typed as labelled lines ("City: New York", "Postal Code: 10025",
 *  "State: NY"). Unlabelled lines are street. Null when no city or postal code is labelled, so the
 *  positional rules apply instead. */
function readLabelledLines(
  lines: string[],
): { street: string | null; city: string | null; postalCode: string | null; region: string | null } | null {
  const street: string[] = []
  const found: Partial<Record<"city" | "postalCode" | "region", string>> = {}
  for (const line of lines) {
    const m = /^([^:]{1,24}):\s*(.*)$/.exec(line)
    const field = m ? ADDRESS_LABELS.find(([re]) => re.test(m[1]!.trim()))?.[1] : undefined
    const value = m?.[2]?.trim() ?? ""
    if (!field) street.push(line)
    else if (field === "street") {
      if (value) street.push(value)
    } else if (field !== "country" && value) found[field] = value
  }
  if (!found.city && !found.postalCode) return null
  return {
    street: street.join(", ") || null,
    city: found.city ?? null,
    postalCode: found.postalCode ?? null,
    region: found.region ?? null,
  }
}

/** Parse the invoice's flattened multiline counterparty address ("[company]\n
 *  street\n[street 2]\nzip city[, province]") into the structured recipient
 *  Boxtal needs. The LAST line is the locality: a leading digit-bearing token
 *  is the postal code, the remainder the city. Everything above it is street.
 *  Returns null when no usable street/locality can be extracted. */
export function parseInvoiceAddress(
  raw: string | null,
  fallback: { name: string | null; email: string | null; countryIsoCode: string | null },
): RecipientAddressInput | null {
  const lines = dropUnrecognisedCountryLine(
    stripTrailingCountry(
      (raw ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== ""),
      fallback.countryIsoCode,
    ),
    fallback.countryIsoCode,
  )
  if (lines.length === 0) return null
  const labelled = readLabelledLines(lines)
  if (labelled) {
    if (!labelled.street && !labelled.city) return null
    return {
      name: fallback.name,
      company: null,
      email: fallback.email,
      phone: null,
      street: labelled.street,
      city: labelled.city,
      postalCode: normalizePostalCode(labelled.postalCode, fallback.countryIsoCode),
      countryIsoCode: fallback.countryIsoCode,
      state: normalizeRegion(fallback.countryIsoCode, labelled.region),
    }
  }
  // A document whose address arrives as ONE comma-joined line ("Industriveien 4, 4879, Grimstad")
  // has no trailing locality LINE, so the multiline rule below mis-split it into
  // city="Industriveien 4" / state="4879, Grimstad" and the cotation went out with no postal code.
  // Treat the commas as the separators in that case.
  const us = (fallback.countryIsoCode ?? "").trim().toUpperCase() === "US" ? splitUsAddress(lines) : null
  if (us) {
    return {
      name: fallback.name,
      company: null,
      email: fallback.email,
      phone: null,
      street: us.street,
      city: us.city,
      postalCode: normalizePostalCode(us.postalCode, fallback.countryIsoCode),
      countryIsoCode: fallback.countryIsoCode,
      state: normalizeRegion(fallback.countryIsoCode, us.state),
    }
  }
  const single = lines.length === 1 ? splitSingleLineAddress(lines[0]!, fallback.countryIsoCode) : null
  const locality = single ? "" : (lines[lines.length - 1] ?? "")
  const streetLines = single ? [] : lines.slice(0, -1)
  // "44000 NANTES", "75018 Paris, Île-de-France", "10001 NEW YORK" — a leading
  // postal-code token (digits, possibly with letters/dashes like "SW1A 1AA" is
  // NOT matched: UK codes trail; fall back to city-only then). NL "1114 BC" keeps its letters.
  const m = splitLeadingPostcode(locality, fallback.countryIsoCode)
  const postalCode = single ? single.postalCode : (m?.postalCode ?? null)
  const cityAndRegion = (m?.city ?? locality).split(",")
  const city = single ? single.city : (cityAndRegion[0]?.trim() || null)
  // "19003-2385 Ardmore, Pennsylvania" — the part after the comma is the
  // state/province, which US/CA labels require (full names normalize to codes).
  const region = single ? single.region : (cityAndRegion.slice(1).join(",").trim() || null)
  const street = single ? single.street : (streetLines.join(", ") || null)
  if (!street && !city) return null
  return {
    name: fallback.name,
    company: null,
    email: fallback.email,
    phone: null,
    street,
    city,
    postalCode: normalizePostalCode(postalCode, fallback.countryIsoCode),
    countryIsoCode: fallback.countryIsoCode,
    state: normalizeRegion(fallback.countryIsoCode, region),
  }
}

/** A Shopify address (an order's shippingAddress or a customer's default) as a recipient. */
function recipientFromShopifyAddress(
  a: ShopifyOrderAddress,
  fallback: { name: string | null; email: string | null; countryIsoCode: string | null },
): RecipientAddressInput | null {
  const str = (v: string | null | undefined): string | null => {
    const t = (v ?? "").trim()
    return t === "" ? null : t
  }
  const street = [str(a.address1), str(a.address2)].filter(Boolean).join(", ") || null
  const city = str(a.city)
  const postalCode = str(a.zip)
  if (!street && !city && !postalCode) return null
  const countryIsoCode = str(a.countryCode) ?? fallback.countryIsoCode
  return {
    name: str(a.name) ?? fallback.name,
    company: str(a.company),
    email: str(a.email) ?? fallback.email,
    phone: str(a.phone),
    street,
    city,
    postalCode: normalizePostalCode(postalCode, countryIsoCode),
    countryIsoCode,
    state: normalizeRegion(countryIsoCode, str(a.provinceCode) ?? str(a.province)),
  }
}

/** What prep_sync cached on this document's prep_meta row about the order's ship-to. */
async function loadCachedShipTo(ctx: ShipmentCtx, documentRef: string): Promise<ShipToCacheEntry> {
  try {
    const rows = (await ctx.db.findMany("prep_meta", { where: { document_ref: documentRef }, limit: 1 })) as Array<{
      ship_to?: unknown
    }>
    return shipToCacheOf(rows[0]?.ship_to)
  } catch {
    return { known: false }
  }
}

/** A person's pick between the order's address and the verified one, stored on the order's prep
 *  state (prep_set_address_choice), or null. */
async function loadAddressChoice(ctx: ShipmentCtx, shopifyOrderId: string): Promise<AddressChoiceRecord | null> {
  const id = numericOrderId(shopifyOrderId)
  if (!id) return null
  try {
    const rows = (await ctx.db.findMany("prep_order_state", {
      where: { order_key: orderKeyForShopifyOrder(id) },
      limit: 1,
    })) as Array<{ address_choice?: unknown }>
    return addressChoiceOf(rows[0]?.address_choice)
  } catch {
    return null
  }
}

/**
 * The contact's VERIFIED delivery addresses from the kernel address book
 * (`kernel:contacts_addresses_list`), newest verification first. Unverified, stale and archived
 * rows are left out: an address nobody checked must never outrank the order's own. Empty on any
 * failure (no contact, no grant, an older kernel), which leaves the draft exactly as it was before
 * the address book existed.
 */
async function loadVerifiedDeliveryAddresses(
  ctx: ShipmentCtx,
  contactId: string | null,
  fallback: { name: string | null; email: string | null; countryIsoCode: string | null },
): Promise<VerifiedAddress[]> {
  if (!contactId) return []
  let env: CrossAppEnvelope
  try {
    env = await ctx.executeTool("kernel:contacts_addresses_list", { contactId, role: "delivery" })
  } catch {
    return []
  }
  if (env.status !== "completed") return []
  const list = coerceObject(env.result)?.addresses
  if (!Array.isArray(list)) return []
  const out: VerifiedAddress[] = []
  for (const raw of list) {
    const r = coerceObject(raw)
    if (!r) continue
    const str = (k: string): string | null => {
      const v = r[k]
      return typeof v === "string" && v.trim() !== "" ? v.trim() : null
    }
    const id = str("id")
    if (!id || r.role !== "delivery" || r.verified !== true || r.stale === true || r.archived === true) continue
    const street = [str("street1"), str("street2")].filter(Boolean).join(", ") || null
    const countryIsoCode = str("countryIso2")?.toUpperCase() ?? fallback.countryIsoCode
    out.push({
      id,
      address: {
        name: str("name") ?? fallback.name,
        company: str("company"),
        email: str("email"),
        phone: str("phone"),
        street,
        city: str("city"),
        postalCode: normalizePostalCode(str("postalCode"), countryIsoCode),
        countryIsoCode,
        state: normalizeRegion(countryIsoCode, str("region")),
      },
      verified_at: str("verifiedAt"),
      verified_by_name: str("verifiedByName"),
      verification_source: str("verificationSource"),
    })
  }
  return out.sort((a, b) => (b.verified_at ?? "").localeCompare(a.verified_at ?? ""))
}

async function loadContactShippingAddress(
  ctx: ShipmentCtx,
  contactId: string | null,
  fallback: { name: string | null; countryIsoCode: string | null },
): Promise<RecipientAddressInput | null> {
  if (!contactId) return null
  let env: { status?: string; result?: unknown }
  try {
    env = (await ctx.executeTool("kernel:contacts_read", { contactId })) as {
      status?: string
      result?: unknown
    }
  } catch {
    return null
  }
  if (env.status !== "completed" || env.result == null) return null
  const contact = (env.result as { contact?: Record<string, unknown> }).contact
  // `metadata` is normally a jsonb object, but be defensive: a JSON string (double-encoded upstream)
  // is parsed, and any non-object shape is treated as "no metadata".
  const meta = coerceObject(contact?.metadata)
  const addr = coerceObject(meta?.shipping_address)
  if (!addr) return null
  const str = (k: string): string | null => {
    const v = addr[k]
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null
  }
  const street = str("street")
  const city = str("city")
  const postalCode = str("postalCode") ?? str("postal_code")
  // No usable address fields → behave as "no stored address".
  if (!street && !city && !postalCode) return null
  const countryIsoCode =
    str("countryIsoCode") ?? str("country_iso_code") ?? str("country") ?? fallback.countryIsoCode
  return {
    name: str("name") ?? fallback.name,
    company: str("company"),
    email: str("email"),
    phone: str("phone"),
    street,
    city,
    postalCode: normalizePostalCode(postalCode, countryIsoCode),
    countryIsoCode,
    state: normalizeRegion(countryIsoCode, str("state") ?? str("province") ?? str("province_code")),
  }
}

/** Read the org's ship-from country from the persisted sender config (default FR). */
async function senderCountryOf(ctx: ShipmentCtx): Promise<string> {
  const sender = await loadSenderParty(ctx)
  return sender?.countryIsoCode?.trim() || "FR"
}

/** Load the persisted sender (ship-from) party from app config. */
/** The kernel contact's TOP-LEVEL email (not metadata.shipping_address —
 *  usually unpopulated). Used to auto-fill the counterparty email Boxtal
 *  hard-requires on both parties. Null on any failure. */
async function loadContactEmail(ctx: ShipmentCtx, contactId: string | null): Promise<string | null> {
  if (!contactId) return null
  try {
    const env = (await ctx.executeTool("kernel:contacts_read", { contactId })) as {
      status?: string
      result?: unknown
    }
    if (env.status !== "completed" || env.result == null) return null
    const contact = (env.result as { contact?: Record<string, unknown> }).contact
    const email = contact?.email
    return typeof email === "string" && email.trim() !== "" ? email.trim() : null
  } catch {
    return null
  }
}

async function loadSenderParty(ctx: ShipmentCtx): Promise<PostalParty | null> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: SENDER_CONFIG_KEY },
    limit: 1,
  })) as Array<{ value: unknown }>
  if (!rows[0]) return null
  return partyFromConfig(rows[0].value)
}

/**
 * Map persisted customs overrides (`CustomsPatch` keyed by line id)
 * onto `buildCustomsArticles`' `ArticleOverride` shape (description/value/weight).
 */
function toArticleOverrides(
  byLineId: Record<string, CustomsPatch>,
): Record<string, ArticleOverride> {
  const out: Record<string, ArticleOverride> = {}
  for (const [lineId, patch] of Object.entries(byLineId)) {
    const o: ArticleOverride = {}
    if (patch.description !== undefined) o.description = patch.description
    if (patch.unitWeight != null) o.unitWeight = patch.unitWeight
    // The tool schema sends unitValue as a NUMBER; reading only `.value` dropped every
    // agent-set value, so an fx_unavailable article stayed blocked after set_customs.
    const unitValue = overrideUnitValue(patch.unitValue)
    if (unitValue !== undefined) o.unitValue = unitValue
    if (patch.tariffNumber != null) o.tariffNumber = patch.tariffNumber
    if (patch.originCountry != null) o.originCountry = patch.originCountry
    out[lineId] = o
  }
  return out
}

/**
 * One carton in a set_package call. Two shapes, so the agent NEVER has to re-key
 * (and risk inventing) a named pack's dimensions:
 *   • `{ pack }` — a REFERENCE to a named pack in the catalog (its id OR its
 *     name, e.g. "STUDIO-BOX"). The handler resolves the pack's
 *     length/width/height/gross_weight server-side from the pack definition,
 *     so the parcel dims come from the authoritative catalog row, not the model.
 *   • `{ length, width, height, weight }` — an ad-hoc carton (the operator
 *     supplies raw dims for a one-off box not in the catalog).
 * Either shape may carry `quantity` (N identical cartons, expanded like a quote
 * parcel). A `{ pack }` ref wins when present; raw dims are the fallback.
 */
export type SetPackageOverrideItem =
  | { pack: string; length?: number; width?: number; height?: number; weight?: number; quantity?: number }
  | (Parcel & { quantity?: number })

/**
 * The `override` a set_package call carries: ONE carton, or an ARRAY of cartons for
 * a MIXED multi-carton shipment (e.g. 6 master cartons + 1 + 2). The persisted parcel
 * set is multi-parcel end-to-end — every colis reaches the Boxtal API (packages[]) —
 * so the single-carton shape is just the common case, never a limit.
 */
export type SetPackageOverride = SetPackageOverrideItem | SetPackageOverrideItem[]

/** True when a carton references a named pack (vs supplying raw ad-hoc dims). */
function isPackRef(o: SetPackageOverrideItem): o is { pack: string } {
  return typeof (o as { pack?: unknown }).pack === "string" && (o as { pack: string }).pack.trim() !== ""
}

/**
 * Resolve a named-pack REFERENCE to a concrete `Parcel`, reading the pack's dims
 * from the catalog (the authoritative source). Matches by pack id first, then by
 * a case-insensitive exact name match (so "STUDIO-BOX" / "studio-box" both
 * resolve). Throws a precise, recoverable error when the ref names no pack — so
 * a typo surfaces as "no pack 'X' (available: …)" the agent can self-correct
 * from, NOT a silent fallthrough that ships the wrong (auto-resolved) parcels.
 */
async function resolvePackRef(ctx: ShipmentCtx, ref: string): Promise<Parcel> {
  const packs = (await ctx.db.findMany("pack", { limit: 1000 })) as CatalogPack[]
  const needle = ref.trim().toLowerCase()
  const match =
    packs.find((p) => p.id === ref) ??
    packs.find((p) => String(p.name).trim().toLowerCase() === needle)
  if (!match) {
    const names = packs.map((p) => p.name).join(", ") || "(none)"
    throw new Error(
      `no pack "${ref}" in the catalog: list packs with packages_list first; available: ${names}`,
    )
  }
  return {
    length: match.length,
    width: match.width,
    height: match.height,
    weight: match.gross_weight,
  }
}

export function shipmentDraftSetPackage(
  draft: ShipmentDraft,
  input: { override: Parcel | Parcel[] },
): ShipmentDraft {
  const parcels = Array.isArray(input.override) ? input.override : [input.override]
  return { ...draft, parcels, parcel_override: true, requote: true }
}

export function shipmentDraftSetCustoms(
  draft: ShipmentDraft,
  input: { index: number; patch: Partial<CustomsArticle> },
): ShipmentDraft {
  const customsArticles = draft.customsArticles.map((a, i) =>
    i === input.index ? { ...a, ...input.patch } : a,
  )
  return { ...draft, customsArticles }
}

/**
 * Persisting parcel override — stores the override against `document_ref` so the
 * gated create path (which re-derives the draft from the invoice) picks it up,
 * then returns the recomputed draft reflecting the override.
 */
export async function shipmentDraftSetPackagePersist(
  ctx: ShipmentCtx,
  input: { draft_id: string; override: SetPackageOverride },
): Promise<ShipmentDraft> {
  // ONE carton or a whole mixed set: normalize to an array so a multi-carton load
  // (e.g. 6 master cartons + 1 + 2) is a single call. Each carton resolves the same
  // two ways as before — a `{ pack }` REFERENCE reads its dims from the catalog
  // (never the model), raw dims are the ad-hoc fallback — and may carry a `quantity`
  // (N identical cartons), expanded exactly like a quote parcel. The persisted set is
  // multi-parcel, so every colis reaches the Boxtal API (packages[]).
  const items = Array.isArray(input.override) ? input.override : [input.override]
  if (items.length === 0) {
    throw new Error(
      "set_package needs at least one carton: pass a carton object, or an array of cartons for a mixed multi-carton shipment.",
    )
  }
  const withQuantity: Array<Parcel & { quantity?: number }> = []
  for (const item of items) {
    const dims: Parcel = isPackRef(item)
      ? await resolvePackRef(ctx, item.pack)
      : { length: item.length, width: item.width, height: item.height, weight: item.weight }
    withQuantity.push({ ...dims, quantity: (item as { quantity?: number }).quantity })
  }
  const parcels = expandParcelQuantities(withQuantity) as Parcel[]
  await saveDraftOverride(ctx, input.draft_id, { parcels, requote: true })
  return shipmentDraftCreate(ctx, { document_ref: input.draft_id })
}

/**
 * Persisting customs override — stores a per-line patch (keyed by the article's
 * stable `line_id`) so the create path applies it. `index` indexes the current
 * draft's customs articles.
 */
export async function shipmentDraftSetCustomsPersist(
  ctx: ShipmentCtx,
  input: { draft_id: string; index: number; patch: CustomsPatch },
): Promise<ShipmentDraft> {
  // Refuse a value we cannot read rather than persist it and leave the article
  // silently unchanged (and still blocked).
  if (input.patch.unitValue !== undefined) {
    const value = overrideUnitValue(input.patch.unitValue)
    if (value === undefined || value <= 0) {
      throw new ToolError(
        `set_customs unitValue must be a positive number in ${DECLARED_CURRENCY} (e.g. 1 for 1.00 ${DECLARED_CURRENCY}).`,
        { code: "invalid_unit_value", retryable: false },
      )
    }
  }
  const draft = await shipmentDraftCreate(ctx, { document_ref: input.draft_id })
  const target = draft.customsArticles[input.index]
  if (!target) {
    throw new Error(`customs article index ${input.index} out of range`)
  }
  await saveDraftOverride(ctx, input.draft_id, {
    customsByLineId: { [target.line_id]: input.patch },
  })
  return shipmentDraftCreate(ctx, { document_ref: input.draft_id })
}

// — gated create_shipment —

export interface CreateResult {
  boxtal_order_id?: string
  order_status?: string
  tracking_number?: string | null
  /** kernel.files id of the imported label PDF (parented on the shipment row),
   *  or null when the label was not yet available at create time — Boxtal
   *  generates documents asynchronously; get_documents fetches them later. A
   *  sequenced bundle step referencing `label_file_id` fails its cascade when
   *  this is null (the reply is cancelled and the agent re-invoked), which is
   *  the safe outcome: never send a "label attached" mail without the label. */
  label_file_id?: string | null
  error?: {
    code: string
    message: string
    /** Optional payload patch the kernel applies to the approval when the failed
     *  execution reverts it to pending, so the re-staged card reflects reality
     *  (e.g. `price_increased` re-stages at the NEW quoted_price_ttc). */
    restage_payload_patch?: Record<string, unknown>
  }
}

/** Structured recipient address supplied on the draft / approval surface. */
export interface RecipientAddressInput {
  name?: string | null
  company?: string | null
  email?: string | null
  phone?: string | null
  street?: string | null
  city?: string | null
  postalCode?: string | null
  countryIsoCode?: string | null
  /** State/province code or full name — required by US/CA carrier labels
   *  (normalized to the 2-letter code before the Boxtal body is built). */
  state?: string | null
}

/**
 * Models routinely hand back Shopify-shaped address keys (`zip`, `address1`/
 * `address2`, `countryCode`, a full `country` name) instead of the schema's
 * `postalCode` / `street` / `countryIsoCode`. Be liberal: fold the common
 * aliases onto the canonical fields before any validation, so a CORRECT
 * address in the wrong dialect never dies at execution with
 * `recipient_address_required` (observed in prod on an approved return label).
 * Canonical fields always win when both are present.
 */
export function normalizeRecipientAddress(
  a?: RecipientAddressInput | null,
): RecipientAddressInput | undefined {
  if (!a || typeof a !== "object") return undefined
  const r = a as Record<string, unknown>
  const s = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null
  const streetAlias = [s(r.address1), s(r.address2)].filter(Boolean).join(", ")
  const countryAlias = s(r.countryCode) ?? s(r.country_code)
  const countryIsoCode =
    s(r.countryIsoCode) ??
    (countryAlias && countryAlias.length === 2 ? countryAlias.toUpperCase() : null)
  return {
    name: s(r.name),
    company: s(r.company),
    email: s(r.email),
    phone: s(r.phone),
    street: s(r.street) ?? (streetAlias !== "" ? streetAlias : null),
    city: s(r.city),
    postalCode: normalizePostalCode(
      s(r.postalCode) ?? s(r.zip) ?? s(r.postal_code) ?? s(r.postcode),
      countryIsoCode,
    ),
    countryIsoCode,
    // Shopify dialects: `province`/`provinceCode`; also accept `region`.
    state: normalizeRegion(
      countryIsoCode,
      s(r.state) ?? s(r.provinceCode) ?? s(r.province_code) ?? s(r.province) ?? s(r.region),
    ),
  }
}

/** Boxtal's cotation 400s a US ZIP+4 ("19003-2385", the form Shopify often
 *  stores) — truncate to the 5-digit ZIP it accepts. A 4-digit US code is a ZIP
 *  whose leading zero a spreadsheet or a number coercion dropped ("2501" is
 *  02501). Anything else is not a US ZIP (a street number such as "250" read as
 *  the postcode) and is dropped, so the address reads as missing its postal
 *  code instead of reaching Boxtal as an invalid one. Other countries pass
 *  through unchanged. */
export function normalizePostalCode(
  postal: string | null,
  countryIsoCode: string | null,
): string | null {
  if (!postal) return postal
  if ((countryIsoCode ?? "").trim().toUpperCase() === "US") {
    const v = postal.trim()
    const m = v.match(/^(\d{5})(?:-\d{4})?$/)
    if (m) return m[1] ?? v
    if (/^\d{4}$/.test(v)) return `0${v}`
    return null
  }
  return postal
}

export interface CreateShipmentInput {
  draft_id: string
  /**
   * The carrier offer to buy. OPTIONAL for an outbound shipment: when omitted, the
   * operator's persisted prep-dashboard choice (prep_select_offer) is staged, falling
   * back to the cached cheapest offer — so the row's offer dropdown drives the label
   * buy (see resolveStageOffer). Always pass it explicitly for a return (the prep
   * dashboard is outbound-only) or when staging outside the dashboard flow.
   */
  offer_code?: string
  /**
   * Include relay / pickup-point offers when re-validating the chosen offer against
   * the live route, bypassing the org exclusion policy for this buy (the "customer
   * wants a relay" case). Auto-set when the resolved offer is itself a relay service
   * the operator deliberately chose, so a dashboard-selected relay offer stages
   * without the caller also passing this.
   */
  include_pickup_point?: boolean
  /** Threaded into the counterparty contact phone (overrides the supplied address phone). */
  recipient_phone?: string
  /**
   * Structured COUNTERPARTY address; pre-filled on the draft from invoice +
   * contact. For an outbound shipment this is the recipient (us → customer); for
   * a return (`is_return`) it is the SENDER (customer → us) and the addresses are
   * swapped internally.
   */
  recipient_address?: RecipientAddressInput
  /**
   * Reverse (return) shipment: parcel ships customer→us. Swaps sender/recipient
   * (sender = counterparty, recipient = org ship-from), sets the customs reason
   * to RETURN, and stamps the link row `kind='return'`.
   */
  is_return?: boolean
  /** Free-text return reason, persisted on the return row (shown in returns_list). */
  return_reason?: string
  /** Who initiated the return (defaults to `agent` — returns are agent-driven). */
  created_by?: "agent" | "user"
  /**
   * The merchant ORDER reference to stamp on the Boxtal shipment (`external_id`,
   * what boxtal:search / boxtal:track read back). Defaults to the linked order
   * name ("#3332"). Pass explicitly only for a shipment with no linked order.
   */
  external_id?: string
  /**
   * Label geometry to ask Boxtal for. Defaults to the org setting
   * (settings_label_format_set), which itself defaults to PDF_A4.
   */
  label_format?: LabelFormat
  /**
   * TTC price (EUR unless quoted_currency says otherwise) of the chosen offer,
   * copied from the quote that returned `offer_code`. REQUIRED: the approval
   * card must always show the reviewer what the label costs. Also an execution
   * price oracle: when the pre-buy re-quote succeeds, a live price at or below
   * this executes as-is (the buyer only ever pays less), a raise within 5% is
   * tolerated, and a raise beyond 5% rejects the buy with `price_increased`
   * plus a restage patch so the reverted approval re-stages at the new price.
   */
  quoted_price_ttc?: number
  /** Currency of quoted_price_ttc (defaults to EUR — Boxtal quotes in EUR). */
  quoted_currency?: string
  /** PARTIAL shipment batch: ship only these lines/quantities now. Omit for the
   *  legacy full-invoice shipment. Only valid for outbound shipments. */
  lines?: PartialLineInput[]
  /**
   * Desired carrier collection date (YYYY-MM-DD). This is what SCHEDULES the
   * pickup: Boxtal books the carrier collection for this date and echoes it back
   * as the order's `expectedTakingOverDate`. Omit to fall back to the chosen
   * offer's Boxtal-proposed `collection_date` (captured from the pre-buy
   * re-quote). When neither is available the order is still created but no pickup
   * is booked (label-only) — the failure mode that left on-premise carriers
   * (FedEx/UPS/DHL/Chronopost home) never coming to collect.
   */
  collection_date?: string
}

/** Shared partial-batch guard for create + preflight: given the FULL invoice line
 *  totals and the live sibling rows, reject a request that would ship more units
 *  of a line than remain, or a full request while partial batches are live.
 *  Returns null when the request may proceed. */
function partialBatchBlock(
  stagingKind: "outbound" | "return",
  requested: PartialLineInput[] | undefined,
  invoiceLines: Array<{ line_id: string; quantity: number }>,
  existing: Array<Record<string, unknown>>,
): { code: string; message: string } | null {
  if (stagingKind === "return") {
    // Returns keep the legacy one-live-return rule; a partial return batch is not modeled.
    const liveReturn = existing.some(
      (r) => isLiveShipment(r) && ((r.kind as string | null) ?? "outbound") === "return",
    )
    return liveReturn
      ? {
          code: "duplicate",
          message:
            "A return shipment is already in flight for this invoice: track the existing one instead of staging a second return label.",
        }
      : null
  }
  const liveOutbound = existing.filter(
    (r) => isLiveShipment(r) && ((r.kind as string | null) ?? "outbound") === "outbound",
  )
  const hasLiveFull = liveOutbound.some((r) => (r as { line_quantities?: unknown }).line_quantities == null)
  if (hasLiveFull) {
    return {
      code: "duplicate",
      message:
        "An outbound shipment covering the whole invoice is already in flight, so a reship must open from a DIFFERENT document. (A RETURN on this invoice is not blocked by this: stage it with is_return:true.)",
    }
  }
  if (liveOutbound.length > 0 && (!requested || requested.length === 0)) {
    return {
      code: "duplicate",
      message:
        "Partial batches are already in flight for this invoice: pass `lines` with the remaining quantities to ship the rest (see to_prepare_list's remaining_units), or cancel the live batch first.",
    }
  }
  if (requested && requested.length > 0 && liveOutbound.length > 0) {
    const shipped = new Map<string, number>()
    for (const r of liveOutbound) {
      const lqs = (r as { line_quantities?: Array<{ line_id: string; quantity: number }> | null })
        .line_quantities
      for (const lq of lqs ?? []) shipped.set(lq.line_id, (shipped.get(lq.line_id) ?? 0) + lq.quantity)
    }
    const totals = new Map(invoiceLines.map((l) => [l.line_id, l.quantity]))
    for (const req of requested) {
      const total = totals.get(req.line_id) ?? 0
      const already = shipped.get(req.line_id) ?? 0
      if (req.quantity + already > total) {
        return {
          code: "partial_overship",
          message: `Line "${req.line_id}" has ${total - already} of ${total} units remaining but ${req.quantity} were requested, so reduce the batch quantity.`,
        }
      }
    }
  }
  return null
}

/**
 * Backfill-import a created shipment's LABEL PDF into kernel.files (parented
 * on the shipment row) and return its file id. The label is generated
 * ASYNCHRONOUSLY by Boxtal, so create_shipment's inline import can miss it
 * (label_file_id: null); this tool closes that gap any time later — call it
 * standalone to repair, or as a sequenced middle step between create_shipment
 * and a reply that attaches the label. Idempotence note: each call imports a
 * fresh copy; reuse the returned id rather than re-calling.
 */
export async function importLabelDocument(
  ctx: ShipmentCtx,
  input: { id: string },
  /** Pacing/clock injection, forwarded to the retry loop. The kernel handler
   *  passes nothing (production defaults); tests drive the backoff with a fake
   *  clock so no suite ever waits for wall-clock time. */
  deps: LabelImportDeps = {},
): Promise<{ label_file_id?: string; error?: { code: string; message: string } }> {
  const client = await getClientOrError(ctx)
  if ("error" in client) return { error: client.error }
  const ref = String(input.id ?? "").trim()
  if (!ref) return { error: { code: "invalid_params", message: "id (boxtal order id or shipment row id) is required" } }
  // Resolve the local shipment row — the kernel.files parent. Accept either the
  // Boxtal order id (what get_documents/track take) or the local row id.
  const row = await findShipmentByRef(ctx, ref, { orderIdFirst: true })
  const boxtalOrderId = (row?.boxtal_order_id as string | null) ?? (row ? null : ref)
  if (!row || !boxtalOrderId) {
    return {
      error: {
        code: "not_found",
        message: `No local shipment row matches "${ref}" (need a created shipment to parent the file on): check the id via boxtal search.`,
      },
    }
  }
  if (!ctx.files_importFromUrl) {
    return { error: { code: "unsupported", message: "files_importFromUrl bridge unavailable in this runtime." } }
  }
  // Was 8 (8 x the sandbox-wide 10s fetch cap = 80s inside a 60s tool budget:
  // this is the call site print_pack reaches the loop through). The bounded
  // default carries the arithmetic documented on importLabelFile.
  const fileId = await importLabelFile(ctx, client, boxtalOrderId, String(row.id), LABEL_IMPORT_ATTEMPTS, deps)
  if (!fileId) {
    return {
      error: {
        code: "label_not_ready",
        message:
          "Boxtal has not served a LABEL document for this order yet (or the import failed, see app logs). Retry in a minute; the label is generated asynchronously after the order.",
      },
    }
  }
  return { label_file_id: fileId }
}

/**
 * Whether unresolved invoice lines (no shipping profile) block staging this draft.
 * An explicit operator carton (persisted set_package override) makes per-line
 * profiles irrelevant for PARCELS — so on a customs-free route the draft is
 * shippable anyway (the warranty-return / unlinked-invoice case, where lines
 * carry no product_source and can never grow a profile). When the route needs a
 * customs declaration the per-line weights/values still derive from profiles,
 * so unresolved lines keep blocking there. Returns the error message, or null.
 */
function unresolvedLinesBlock(draft: ShipmentDraft): string | null {
  if (!unresolvedLinesBlockLabel(draft)) return null
  return draft.parcel_override
    ? "Some invoice lines have no shipping profile and this route requires a customs declaration (per-line weights/values derive from profiles); resolve them before creating a shipment."
    : "Some invoice lines have no shipping profile; either resolve them, or set the carton explicitly with shipment_draft_set_package (sufficient on a customs-free route)."
}

/** Outcome of the batch proforma: its id, or the reason it was not issued (pending approval
 *  included). Never a bare null: a swallowed failure left a partial customs shipment travelling
 *  without its proforma while the caller believed nothing was wrong. */
export type BatchProformaOutcome =
  | { status: "completed"; document_id: string }
  | { status: "pending_approval"; approval_id: string }
  | { status: "error"; code: string; message: string }

/** Issue the customs PROFORMA for a PARTIAL batch: exactly the batch's lines,
 *  linked to the Shopify order and keyed by the shipment row id (shipment_ref)
 *  so re-creates are idempotent on the invoicing side. Best-effort by design (the
 *  label is already bought, so a failure never fails the order), but a failure is
 *  logged and returned to the caller, which surfaces it on the create result. The
 *  recipient is the source invoice's own counterparty snapshot: invoicing requires a
 *  complete `counterparty` object (name, country, address, email). */
export async function issueBatchProforma(
  ctx: ShipmentCtx,
  draft: ShipmentDraft,
  shipmentRef: string,
): Promise<BatchProformaOutcome> {
  const fail = (code: string, message: string): BatchProformaOutcome => {
    ctx.logger?.warn?.("batch proforma not issued", {
      document_ref: draft.document_ref,
      shipment_ref: shipmentRef,
      code,
      err: message,
    })
    return { status: "error", code, message }
  }
  try {
    const docEnv = await ctx.executeTool("invoicing:documents_get", { id: draft.document_ref })
    const doc =
      docEnv.status === "completed"
        ? (docEnv.result as {
            shopify_order_id?: string | null
            shopify_order_number?: string | null
            currency?: string | null
            counterparty_name?: string | null
            counterparty_country?: string | null
            counterparty_address?: string | null
            counterparty_email?: string | null
            counterparty_vat_id?: string | null
            counterparty_contact_id?: string | null
            issuer_profile_id?: string | null
          } | null)
        : null
    if (!doc) {
      return fail(
        "source_document_unreadable",
        `The source invoice ${draft.document_ref} could not be read, so the batch proforma was not issued.`,
      )
    }
    // The batch lines carry the invoice's NET prices, but proforma_create_and_issue reads a typed
    // price as GROSS under an issuer with prices_include_tax and divides the tax out. Send the
    // gross figure for such an issuer (and pin each line to the invoice's own rate), so the
    // proforma stores exactly the invoice's net price instead of netting it a second time.
    const issuerId = doc.issuer_profile_id ?? null
    let inclusive = false
    if (issuerId) {
      const issEnv = await ctx.executeTool("invoicing:settings_issuer_profile_list", {})
      if (issEnv.status !== "completed") {
        return fail(
          "issuer_lookup_failed",
          `The issuer profile of invoice ${draft.document_ref} could not be read, so the batch proforma's prices cannot be declared safely.`,
        )
      }
      const raw = issEnv.result as { items?: Array<{ id?: string; prices_include_tax?: boolean }> } | null
      inclusive = !!(raw?.items ?? []).find((p) => p?.id === issuerId)?.prices_include_tax
    }
    const env = await ctx.executeTool("invoicing:proforma_create_and_issue", {
      ...(issuerId ? { issuer_profile_id: issuerId } : {}),
      counterparty: {
        legal_name: doc.counterparty_name ?? draft.recipient,
        country: doc.counterparty_country ?? draft.recipient_country ?? "",
        address: doc.counterparty_address ?? null,
        email: doc.counterparty_email ?? null,
        ...(doc.counterparty_vat_id ? { vat_id: doc.counterparty_vat_id } : {}),
        ...(doc.counterparty_contact_id ? { contact_id: doc.counterparty_contact_id } : {}),
      },
      // The batch lines carry the invoice's own prices, so the proforma is in its currency.
      ...(doc.currency ? { currency: doc.currency } : {}),
      reason: `Partial shipment batch for invoice ${draft.document_ref}`,
      ...(doc.shopify_order_id ? { shopify_order_id: doc.shopify_order_id } : {}),
      // The HUMAN order reference ("#1149") the customer and customs both read:
      // carried from the source invoice so the batch proforma travelling with the
      // parcel names the order it belongs to, not just an internal document id.
      ...(doc.shopify_order_number ? { shopify_order_number: doc.shopify_order_number } : {}),
      shipment_ref: shipmentRef,
      notes: `Partial shipment batch for invoice ${draft.document_ref}; customs document only, not a request for payment.`,
      items: (draft.batch_lines ?? []).map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_price_minor:
          inclusive && typeof l.tax_rate_bp === "number"
            ? grossOfExcludedTax(l.unit_price_minor, l.tax_rate_bp)
            : l.unit_price_minor,
        ...(typeof l.tax_rate_bp === "number" ? { tax_rate_bp_override: l.tax_rate_bp } : {}),
        ...(l.hs_code ? { hs_code: l.hs_code } : {}),
        ...(l.country_of_origin ? { country_of_origin: l.country_of_origin } : {}),
        ...(l.customs_description ? { customs_description: l.customs_description } : {}),
        ...(l.external_id ? { external_id: l.external_id, product_source: "shopify" } : {}),
      })),
    })
    if (env.status === "pending_approval") return { status: "pending_approval", approval_id: env.approval_id }
    if (env.status === "error") return fail(env.error.code ?? "proforma_failed", env.error.message)
    // The invoicing mutation returns its OWN result envelope inside the cross-app one.
    const res = env.result as
      | {
          status?: string
          document_id?: string
          id?: string
          approval_id?: string
          error?: { code?: string; message?: string }
          document?: { id?: string }
        }
      | null
    if (res?.status === "pending_approval" && res.approval_id) {
      return { status: "pending_approval", approval_id: res.approval_id }
    }
    if (res?.status === "error") {
      return fail(res.error?.code ?? "proforma_failed", res.error?.message ?? "The batch proforma could not be issued.")
    }
    const id = res?.document_id ?? res?.id ?? res?.document?.id ?? null
    if (!id) return fail("proforma_not_issued", "Invoicing accepted the batch proforma but returned no document id.")
    return { status: "completed", document_id: id }
  } catch (err) {
    return fail("invoicing_unavailable", err instanceof Error ? err.message : String(err))
  }
}

/**
 * Resolve whether the order behind `documentRef` may still be shipped.
 *
 * Reads the cached `prep_meta` facts first, and falls back to a LIVE Shopify
 * read when they are missing. The live fallback matters: a guard that trusts an
 * absent cache is bypassed by anything that never synced (a direct
 * `document_ref`, a fresh invoice, the agent). Money is about to be spent here,
 * so an unknown is worth one extra read.
 *
 * Fails OPEN on a read error here: the label buy's own draft build reads the
 * same order and refuses (`order_unreadable`, addressPickBlock) when that read
 * fails, so nothing is bought on an order nobody could read. The queue filter
 * is the everyday defence; this is the one that matters when the facts are
 * known. See order-shippability.ts.
 */
async function resolveOrderUnshippable(
  ctx: BoxtalToolCtx,
  documentRef: string,
): Promise<{ reason: UnshippableReason; orderName: string | null } | null> {
  try {
    const metaRows = (await ctx.db.findMany("prep_meta", {
      where: { document_ref: documentRef },
      limit: 1,
    })) as Array<{
      order_name?: string | null
      shopify_order_id?: string | null
      financial_status?: string | null
      cancelled_at?: string | null
    }>
    const meta = metaRows[0] ?? null
    const cached = unshippableReason(meta)
    if (cached) return { reason: cached, orderName: meta?.order_name ?? null }

    // Cached facts present and clean -> trust them (they are refreshed on sync).
    if (meta?.financial_status || meta?.cancelled_at) return null

    // No facts cached: resolve the order id and read it live.
    let orderId = meta?.shopify_order_id ?? null
    if (!orderId) {
      const docEnv = await ctx.executeTool("invoicing:documents_get", { id: documentRef })
      orderId =
        docEnv.status === "completed" && docEnv.result != null
          ? ((docEnv.result as { shopify_order_id?: string | null }).shopify_order_id ?? null)
          : null
    }
    if (!orderId) return null

    const env = await ctx.executeTool("shopify:orders_get", { id: toShopifyOrderGid(orderId) })
    if (env.status !== "completed" || env.result == null) return null
    const order = env.result as {
      name?: string | null
      attributes?: { financialStatus?: string | null; cancelledAt?: string | null } | null
    }
    const live = unshippableReason({
      financial_status: order.attributes?.financialStatus ?? null,
      cancelled_at: order.attributes?.cancelledAt ?? null,
    })
    return live ? { reason: live, orderName: order.name ?? meta?.order_name ?? null } : null
  } catch {
    return null
  }
}

/**
 * The merchant ORDER reference for a document (the Shopify order name, e.g.
 * "#3332"), cached on prep_meta by prep_sync. This is what Boxtal's `externalId`
 * must carry: the reference the operator, the carrier dispute and the support
 * ticket all quote.
 *
 * Read HERE, at the one call site that needs it, and NOT on the draft. Resolving
 * a draft happens once per candidate on every prep_list, so hanging this lookup
 * off the draft ran it N times over the worklist for a value only the label buy
 * reads -- N redundant queries on the slowest screen in the app, which already
 * takes tens of seconds and 504s at the edge before it can paint.
 */
/** The cached order facts that ride along in the buy-time snapshot (queue-facts.ts). Read from
 *  `prep_meta`, which `warmPrepMetaForDocument` has just filled for this very document. */
async function loadOrderFacts(
  ctx: ShipmentCtx,
  documentRef: string,
): Promise<{ order_name: string | null; order_created_at: string | null; staff_note: string | null }> {
  try {
    const rows = (await ctx.db.findMany("prep_meta", {
      where: { document_ref: documentRef },
      limit: 1,
    })) as Array<{ order_name?: string | null; order_created_at?: string | null; staff_note?: string | null }>
    const row = rows[0]
    return {
      order_name: row?.order_name ?? null,
      order_created_at: row?.order_created_at ?? null,
      staff_note: row?.staff_note ?? null,
    }
  } catch {
    // The snapshot is descriptive, never a gate: a failed read costs dashes in three columns.
    return { order_name: null, order_created_at: null, staff_note: null }
  }
}

async function loadOrderName(ctx: ShipmentCtx, documentRef: string): Promise<string | null> {
  try {
    const rows = (await ctx.db.findMany("prep_meta", {
      where: { document_ref: documentRef },
      limit: 1,
    })) as Array<{ order_name?: string | null }>
    return rows[0]?.order_name ?? null
  } catch {
    // The reference is a nicety on the label, never a reason to fail the buy:
    // createShipment falls back to the document_ref.
    return null
  }
}

export async function createShipment(
  ctx: ShipmentCtx,
  rawInput: CreateShipmentInput,
): Promise<CreateResult> {
  // Alias-tolerant address intake (zip/address1/countryCode dialects) — see
  // normalizeRecipientAddress.
  const input: CreateShipmentInput = {
    ...rawInput,
    recipient_address: normalizeRecipientAddress(rawInput.recipient_address),
  }
  // Explicit pickup date override (operator/agent picks a specific collection
  // day). Must be a plain calendar date; Boxtal schedules the carrier collection
  // for it. Validate cheaply here (no side effect yet) so a malformed date fails
  // fast instead of 422-ing at Boxtal after a row is reserved. An empty/blank
  // value is treated as absent (fall back to the re-quoted offer date).
  let explicitCollectionDate: string | undefined
  if (typeof input.collection_date === "string" && input.collection_date.trim() !== "") {
    const d = input.collection_date.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return { error: { code: "validation", message: "collection_date must be a plain calendar date (YYYY-MM-DD)." } }
    }
    explicitCollectionDate = d
  }
  // Check connectivity FIRST, before reserveCreate reserves a row below — a
  // not-connected org must not consume the document_ref reservation slot.
  const client = await getClientOrError(ctx)
  if ("error" in client) {
    return { error: client.error }
  }
  // Re-derive the draft from the invoice snapshot (the source of truth) — this
  // also folds in any persisted operator overrides (carton, customs edits).
  // A `lines` subset makes this a PARTIAL batch: parcels, customs and the
  // declared total all derive from the subset only.
  const draft = await shipmentDraftCreate(ctx, {
    document_ref: input.draft_id,
    ...(input.lines && !input.is_return ? { lines: input.lines } : {}),
  })

  // NEVER ship a refunded or cancelled order. This is the real invariant: the
  // to-prepare queue also filters these out, but a queue is presentation and can
  // be bypassed by a direct document_ref, a stale UI, or the agent. Checked here,
  // before the reservation and before any outbound POST, so nothing is bought.
  //
  // Prod, 2026-08-05: order #3320 was fully refunded and cancelled yet sat in the
  // worklist; only an unrelated customs-FX failure was keeping it un-preparable.
  // See order-shippability.ts.
  const unshippable = await resolveOrderUnshippable(ctx, draft.document_ref)
  if (unshippable) {
    return {
      error: {
        code: unshippable.reason,
        message: unshippableMessage(unshippable.reason, unshippable.orderName),
      },
    }
  }

  const unresolvedBlocks = unresolvedLinesBlock(draft)
  if (unresolvedBlocks) {
    return { error: { code: "unresolved_lines", message: unresolvedBlocks } }
  }
  if (draft.customsArticles.some((a) => a.blocked)) {
    return { error: { code: "unresolved_lines", message: blockedArticlesMessage(draft) } }
  }
  {
    const held = addressPickBlock(draft, { isReturn: input.is_return === true })
    if (held) return { error: held }
  }
  // Resolve the carrier offer to buy. An explicit offer_code always wins; when it is ABSENT the
  // operator's persisted prep-dashboard choice is staged, falling back to the cached cheapest — so the
  // row's offer dropdown DRIVES the label buy (resolveStageOffer). A return has no prep-dashboard row
  // to read a selection from (the dashboard is outbound-only), so it always needs an explicit code.
  // Back-compat: an EXPLICIT empty string ("") is a caller saying "no offer" and passes straight
  // through (the validation below is skipped for it), the way it did before offer resolution existed.
  const offerProvided = typeof input.offer_code === "string"
  const hasNonEmptyOffer = offerProvided && (input.offer_code as string).trim() !== ""
  const stageSelection: ResolvedStageOffer | null =
    !offerProvided && !input.is_return ? await resolveStageOffer(ctx, draft.document_ref) : null
  const offerCode = hasNonEmptyOffer ? (input.offer_code as string).trim() : stageSelection?.offer_code ?? ""
  if (offerCode === "" && !offerProvided && !input.is_return) {
    return {
      error: {
        code: "offer_required",
        message:
          "No carrier offer to ship: pass offer_code, or choose one on the prep dashboard (prep_select_offer) and run prep_sync so an offer is cached to stage.",
      },
    }
  }
  // A relay offer the operator DELIBERATELY chose (or an explicit include_pickup_point) must survive
  // the org pickup-point exclusion when the offer is re-validated against the live route below.
  const includePickupPoint = input.include_pickup_point === true || stageSelection?.is_pickup_point === true
  // OFFER-CODE ROUTE VALIDATION backstop (BL — the marco-day journey root). The stage-time preflight
  // already rejects a non-quoted offer_code, but enforce it at EXECUTION too so an approved request can
  // never BUY a label on a carrier the quote didn't return for this draft's destination (a wrong/doomed
  // label that would otherwise 422 at Boxtal or — worse — ship the wrong carrier). Re-quote (read-only)
  // and reject before reserving. Only enforced when the quote SUCCEEDS with ≥1 offer (an errored/empty
  // route is a different failure path handled by the agent's re-quote, never silently blocked here).
  //
  // The same re-quote also yields the chosen offer's Boxtal-proposed collection
  // date, which we forward to the order as `expectedTakingOverDate` so the
  // carrier pickup is actually booked (label-only orders never scheduled one).
  let quotedCollectionDate: string | undefined
  let quotedCarrierName: string | null = null
  // Skip validation for an explicit empty offer_code (the back-compat "no offer" pass-through);
  // every resolved or explicit non-empty code is validated against the live route.
  // The LIVE label cost (the price the label is actually bought at) — captured
  // from the pre-buy re-quote and persisted on the shipment row so the ready
  // queue can show the carrier cost, not the customs declared value.
  let liveLabelCost: number | null =
    typeof input.quoted_price_ttc === "number" && input.quoted_price_ttc > 0
      ? input.quoted_price_ttc
      : null
  if (offerCode !== "") {
    // Validate against the leg actually being shipped: a return (is_return)
    // travels customer→us, and its carrier set can differ from the outbound
    // route's — validating a return's offer_code against the outbound quote
    // would reject every legitimately return-quoted offer.
    // Pass the call's own recipient_address as the explicit `to`: a draft whose
    // contact carries no shipping address cannot resolve its destination and the
    // draft-only cotation 400s (observed in prod), silently skipping this
    // validation — the address the label will actually be bought with is the
    // right thing to quote against anyway.
    const addr = input.recipient_address
    const to =
      addr?.postalCode && addr.city && addr.countryIsoCode
        ? {
            city: addr.city,
            postalCode: addr.postalCode,
            country: addr.countryIsoCode,
            type: "particulier",
          }
        : undefined
    const quoted = await quote(ctx, {
      draft_id: input.draft_id,
      is_return: input.is_return,
      ...(to ? { to } : {}),
      ...(includePickupPoint ? { include_pickup_point: true } : {}),
      // The carrier allowlist is an advisory GUIDELINE for routine quoting, not a
      // buy-time gate: create_shipment is gated (human-approved), so an operator who
      // explicitly picked a non-allowlisted carrier must be allowed to ship it.
      // Ignore the allowlist on this re-quote so a non-allowlisted offer_code still
      // validates. The genuine checks stay: the offer must still exist in the raw
      // carrier quote for this route (a fabricated / route-invalid code is still
      // refused below), the relay/pickup-point exclusion still applies, and the
      // price-drift oracle still runs. The human approval is the real guardrail.
      ignore_allowlist: true,
    })
    if (!quoted.error && quoted.offers.length > 0) {
      const offer = quoted.offers.find((o) => o.offer_code === offerCode)
      if (!offer) {
        const available = quoted.offers.map((o) => `${o.offer_code} (${o.carrier} ${o.service})`).join(", ")
        return {
          error: {
            code: "offer_not_quoted",
            message:
              `The offer_code "${offerCode}" was not returned by a quote for this shipment's route. ` +
              `re-quote${input.is_return ? " (with is_return:true, a return prices the reverse leg)" : ""} and pick one of: ${available}.`,
          },
        }
      }
      // Boxtal's own proposed collection date for the chosen offer; forwarded as
      // the order's pickup date unless the caller passed an explicit override.
      quotedCollectionDate = offer.collection_date ?? undefined
      quotedCarrierName = offer.carrier || null
      if (offer.price_ttc > 0) liveLabelCost = offer.price_ttc
      // PRICE ORACLE (the automatic pre-buy re-quote): the approval card showed
      // the reviewer `quoted_price_ttc`; the live re-quote above is the price
      // check. A live price at or below the approved one executes as-is (the
      // buyer only ever pays less than what was approved), and a raise within
      // 5% is tolerated (carrier surcharges jitter). A raise BEYOND 5% must not
      // silently buy at a price nobody reviewed: fail cleanly with the two
      // prices spelled out, and carry a `restage_payload_patch` so the kernel
      // re-stages the reverted approval at the NEW price for a fresh review
      // (see revertToPending). Only runs when the caller supplied a price (a
      // dashboard-resolved offer with no quoted_price_ttc is bought at the live
      // re-quote price by construction).
      if (
        typeof input.quoted_price_ttc === "number" &&
        input.quoted_price_ttc > 0 &&
        offer.price_ttc > 0
      ) {
        const raise = (offer.price_ttc - input.quoted_price_ttc) / input.quoted_price_ttc
        if (raise > 0.05) {
          const livePrice = `${offer.price_ttc.toFixed(2)} ${offer.currency}`
          const risen =
            `The live price for ${offerCode} is now ${livePrice} TTC, up ${(raise * 100).toFixed(0)}% ` +
            `from the ${ctx.approval ? "approved" : "quoted"} ${input.quoted_price_ttc.toFixed(2)}. Nothing was bought. `
          // Only an approved re-run has an approval to re-stage. A direct call (the
          // Ship button, used by someone who may approve) has none, so it is told
          // to re-quote and ship again instead.
          return {
            error: {
              code: "price_increased",
              message: ctx.approval
                ? `${risen}The approval is re-staged at the new price: review and approve again to ship at ${livePrice}.`
                : `${risen}Re-quote this shipment to confirm the new price, then ship it again to buy at ${livePrice}.`,
              restage_payload_patch: { quoted_price_ttc: offer.price_ttc },
            },
          }
        }
      }
    }
  }

  // Assemble the real sender + recipient addresses and HARD-FAIL before any
  // outbound POST when a required structured field is missing — never POST
  // empty addresses (which Boxtal 422s).
  const sender = await loadSenderParty(ctx)
  if (!sender) {
    return { error: { code: "sender_address_required", message: "Set the ship-from (sender) address in Boxtal settings before creating a shipment." } }
  }
  const senderMissing = validateParty(sender)
  if (senderMissing.length > 0) {
    return { error: { code: "sender_address_required", message: `Sender address is incomplete, missing: ${senderMissing.join(", ")}.` } }
  }

  const recipient = buildRecipientParty(draft, input)
  // Boxtal hard-requires a contact email on BOTH parties (422 NotBlank on
  // fromAddress.contact.email for a return, where FROM is the customer). The
  // agent rarely passes one — auto-fill from the linked kernel contact's email,
  // then the org sender email as a last resort (notifications then reach us
  // instead of the customer, but the label buys).
  if (!recipient.email || recipient.email.trim() === "") {
    recipient.email =
      (await loadContactEmail(ctx, draft.recipient_contact_id)) ?? sender.email ?? null
  }
  const recipientMissing = validateParty(recipient)
  if (recipientMissing.length > 0) {
    const code = recipientMissing.length === 1 && recipientMissing[0] === "phone"
      ? "recipient_phone_required"
      : "recipient_address_required"
    return { error: { code, message: `Recipient address is incomplete, missing: ${recipientMissing.join(", ")}.` } }
  }
  // Destination-aware phone rule (US/CA labels 422 at Boxtal/FedEx on a
  // non-North-American phone). The stage-time preflight already rejects this;
  // enforce at execution too so a card staged before the rule existed (or edited
  // since) still fails BEFORE reserving/buying, with the same readable reason.
  {
    const phoneIssue = validateRecipientPhone(recipient.countryIsoCode, recipient.phone)
    if (phoneIssue) {
      return { error: { code: "recipient_phone_invalid", message: phoneIssue } }
    }
  }

  // Partial-batch guard: overship and full-vs-partial conflicts fail HERE with a
  // precise message (reserveCreate's duplicate check is the concurrency backstop).
  {
    const existingRows = (await ctx.db.findMany("shipment", {
      where: { document_ref: draft.document_ref },
      limit: 100,
    })) as Array<Record<string, unknown>>
    const block = partialBatchBlock(
      input.is_return ? "return" : "outbound",
      input.is_return ? undefined : input.lines,
      draft.invoice_lines,
      existingRows,
    )
    if (block) return { error: block }
  }
  const skuByLine = new Map(draft.invoice_lines.map((l) => [l.line_id, l.external_id]))
  const batchLineQuantities =
    input.lines && !input.is_return
      ? input.lines.map((l) => ({
          line_id: l.line_id,
          external_id: skuByLine.get(l.line_id) ?? null,
          quantity: l.quantity,
        }))
      : null

  // Warm the order-facts cache BEFORE reading the order name off it. A document nobody ever
  // prep_synced had no cached facts at all, which cost two real things at this exact moment:
  // the label carried the invoice UUID instead of the order number, and the Ready-to-ship row
  // had no ORDER DATE to sort the print station's oldest-first queue by. Best effort and
  // non-destructive (see warmPrepMetaForDocument) — it must never fail a buy.
  await warmPrepMetaForDocument(ctx, draft.document_ref)

  // Resolved ahead of the reservation (rather than after, as before) so the
  // merchant order reference can be persisted on the row at insert time —
  // otherwise external_id is stored null forever and never backfilled.
  const [labelFormat, orderName] = await Promise.all([
    input.label_format ? Promise.resolve(input.label_format) : loadLabelFormat(ctx),
    loadOrderName(ctx, draft.document_ref),
  ])
  const resolvedExternalId = input.external_id?.trim() || orderName

  // 1. Reserve the document_ref slot BEFORE any outbound POST.
  const reserve = await reserveCreate(ctx, {
    document_ref: draft.document_ref,
    external_id: resolvedExternalId,
    contact_ref: draft.recipient_contact_id,
    offer_code: offerCode,
    recipient_summary: draft.recipient,
    route_summary: draft.route,
    currency: draft.customsArticles[0]?.unitValue.currency ?? "EUR",
    declared_total: draft.customsArticles.reduce((s, a) => s + a.quantity * a.unitValue.value, 0),
    kind: input.is_return ? "return" : "outbound",
    return_reason: input.is_return ? (input.return_reason ?? null) : null,
    created_by: input.is_return ? (input.created_by ?? "agent") : null,
    line_quantities: batchLineQuantities,
  })
  if (!reserve.ok) {
    return { error: { code: "duplicate", message: "A shipment is already in flight for this invoice." } }
  }

  // Outbound ships us→customer (from=org sender, to=counterparty). A return ships
  // customer→us, so swap: from=counterparty, to=org sender. `recipient` here is
  // always the counterparty (customer); `sender` is always the org ship-from.
  const orgAddress = assembleAddress(sender)
  const counterpartyAddress = assembleAddress(recipient)
  // The declared customs reason: is_return is the PHYSICAL direction of the parcel (customer -> us)
  // and always wins over the row's prep-grid category — a return ships back regardless of what
  // category the operator left set on the row (e.g. an operator who forgot to flip the category to
  // "return" before staging a reverse shipment must not have it declared SALE/GIFT/REPAIR at
  // customs). When is_return is false, the row's category (repair/gift/return/sale) decides the
  // basis via customs_basis, defaulting to SALE for an untouched row.
  const reason: CustomsBasis = input.is_return
    ? "RETURN"
    : draft.category !== "sale"
      ? draft.customs_basis
      : "SALE"
  // Explicit override wins; otherwise use Boxtal's proposed date for the offer.
  const expectedTakingOverDate = explicitCollectionDate ?? quotedCollectionDate
  const createDraft = buildCreateDraft(
    draft,
    offerCode,
    {
      fromAddress: input.is_return ? counterpartyAddress : orgAddress,
      toAddress: input.is_return ? orgAddress : counterpartyAddress,
      reason,
    },
    expectedTakingOverDate,
    { externalId: resolvedExternalId, labelFormat },
  )

  let order: NormalizedOrder
  try {
    order = await client.v3.createShippingOrder(createDraft)
  } catch (err) {
    if (err instanceof BoxtalApiError) {
      if (err.status >= 500) {
        // Indeterminate — keep the row so a blind retry is blocked.
        await markUncertain(ctx, reserve.id)
        return { error: { code: "create_uncertain", message: "Boxtal returned a server error; verify the order in the Boxtal dashboard before retrying." } }
      }
      if (err.status === 422 && err.body.includes("Phone")) {
        // Deterministic validation reject — release the reservation so a
        // corrected retry can proceed cleanly (spec §C.5 reserves
        // create_uncertain for INDETERMINATE 5xx only).
        await releaseReservation(ctx, reserve.id)
        return { error: { code: "validation", message: "recipient phone invalid" } }
      }
      if (err.status === 422 && err.body.includes("InvalidPaymentException")) {
        // NOT a problem with this shipment. Boxtal refuses the ORDER when the
        // account cannot pay for it: the deferred-payment ceiling (`encours`) is
        // reached, or the payment method / SEPA mandate is invalid. Its
        // `parameters` are null precisely because no field is at fault, which is
        // how it differs from RequestValidationException.
        //
        // Prod, 2026-08-04: five creates across four carriers and four
        // destinations failed identically here and the operator saw only a raw
        // 422 body, so the cause took two investigations to find. Boxtal had
        // already raised the ceiling once on 2026-07-22 (their ticket #2176069)
        // and ~23 shipments consumed it again.
        await releaseReservation(ctx, reserve.id)
        return {
          error: {
            code: "boxtal_account_payment_blocked",
            message:
              "Boxtal refused the order because the Boxtal ACCOUNT cannot pay for it, not because of anything in this shipment. " +
              "Its deferred-payment ceiling (encours) is reached, or the payment method / SEPA mandate is invalid. " +
              "Nothing was bought and nothing was charged. " +
              "Fix: pay the pending Boxtal invoices (card, instant transfer or PayPal) to free the encours, or ask Boxtal support to raise it, then retry.",
          },
        }
      }
      await releaseReservation(ctx, reserve.id)
      const detail = summarizeBoxtalError(err.body)
      return {
        error: {
          code: "validation",
          message: detail
            ? `Boxtal rejected the shipment (${err.status}): ${detail}`
            : `Boxtal rejected the shipment (${err.status})`,
        },
      }
    }
    await markUncertain(ctx, reserve.id)
    return {
      error: {
        code: "unknown",
        message:
          `Boxtal did not confirm the shipment (${err instanceof Error ? err.message : String(err)}). ` +
          "Check the order in the Boxtal dashboard before retrying, so a second label is not bought.",
      },
    }
  }

  // 2. Finalize + backfill the tracking number: Boxtal's own answer first (the order response,
  // then the parcel tracking read). A carrier that issues it only at first scan gets it from the
  // label right after (DOCUMENT_CREATED webhook, reconcile job: label-tracking.ts).
  let trackingNumber: string | null = order.tracking_number ?? null
  if (!trackingNumber) {
    try {
      const tracking = await client.v3.getTracking(order.id)
      trackingNumber = tracking.tracking_number
    } catch {
      // tracking not ready yet — backfilled later by the webhook
    }
  }
  await finalizeCreated(ctx, reserve.id, {
    boxtal_order_id: order.id,
    tracking_number: trackingNumber,
    label_cost_ttc: liveLabelCost,
    // What is ACTUALLY in this box, frozen at the moment it was bought: cartons and their sizes,
    // weight, unit count, category, and the order it belongs to. Every post-buy queue reads this
    // instead of re-resolving the invoice, so a later amendment cannot rewrite the history of a
    // parcel already on a van. See queue-facts.ts.
    queue_facts: {
      ...buildQueueFacts({ ...draft, products: summarizeProducts(draft) }, await loadOrderFacts(ctx, draft.document_ref), {
        kind: input.is_return ? "return" : "outbound",
        carrierFamily: carrierFamilyOf(offerCode, quotedCarrierName),
      }),
      // The print record's buy-time half (print-record.ts): invoice, the customer and the address
      // the label was printed for, the carrier and the goods lines as they shipped.
      print: buildPrintSnapshot(draft, {
        offerCode,
        carrierName: quotedCarrierName,
        customer: counterpartyAddress,
      }),
      // The address the LABEL is printed for (the recipient, or our own address on a return):
      // a tracking number read off the label is accepted only when the label shows this postcode.
      to_postcode: createDraft.toAddress.location.postalCode || null,
      to_country: createDraft.toAddress.location.countryIsoCode || null,
    },
  })
  // Overrides have been baked into the created order — drop them.
  await clearDraftOverride(ctx, draft.document_ref)

  // PARTIAL batch on a customs route: issue the batch's own PROFORMA covering
  // exactly the shipped subset (the legal invoice is never split — French
  // e-invoicing). Idempotent per (order, scope, shipment_ref) on the invoicing
  // side, keyed by this shipment row's id. Best-effort: a proforma failure must
  // never fail an already-created order; it is retryable by re-issuing manually.
  let batchProformaId: string | null = null
  let batchProformaIssue: Exclude<BatchProformaOutcome, { status: "completed" }> | null = null
  if (batchLineQuantities && draft.customs_required && draft.batch_lines) {
    const outcome = await issueBatchProforma(ctx, draft, String(reserve.id))
    if (outcome.status === "completed") batchProformaId = outcome.document_id
    else batchProformaIssue = outcome
  }

  // Import the LABEL PDF into kernel.files (parented on the shipment row) so a
  // downstream step — a sequenced ticket reply, a manual attach — gets a real
  // attachable file id, not a short-lived signed URL. Best-effort: Boxtal
  // generates documents asynchronously, so try a few reads (each is a network
  // round-trip, natural spacing) and return null when the label is not ready
  // yet — never fail an already-created order over its paperwork.
  const labelFileId = await importLabelFile(ctx, client, order.id, reserve.id)

  const result = {
    boxtal_order_id: order.id,
    order_status: order.order_status,
    tracking_number: trackingNumber,
    label_file_id: labelFileId,
    ...(batchLineQuantities ? { partial_batch: true, batch_proforma_id: batchProformaId } : {}),
    // The order stands, but the parcel's customs proforma did not issue (or awaits approval):
    // say so on the result instead of a silent null id.
    ...(batchProformaIssue
      ? {
          batch_proforma_error:
            batchProformaIssue.status === "pending_approval"
              ? { code: "pending_approval", message: `The batch proforma is waiting for approval (${batchProformaIssue.approval_id}).` }
              : { code: batchProformaIssue.code, message: batchProformaIssue.message },
        }
      : {}),
  }

  // ASYNC OUTPUT (approval sequences): the ORDER is committed, but the label
  // PDF generates asynchronously on Boxtal's side. When this execution runs
  // under an approval and the label is not ready yet, record awaiting_output
  // so the kernel's poll job (manifest `pollHandler`) retrieves it and the
  // sequence cascade resumes with a real `label_file_id` — instead of a
  // dependent reply failing on a null @ref (the prod failure this closes).
  // Best-effort: outside an approval the record calls are no-ops.
  if (labelFileId === null && ctx.approval_recordStarted && ctx.approval_recordAwaitingOutput) {
    try {
      await ctx.approval_recordStarted("boxtal:create_shipment")
      await ctx.approval_recordAwaitingOutput(
        "boxtal:create_shipment",
        JSON.stringify({ shipment_row_id: reserve.id, boxtal_order_id: order.id }),
      )
    } catch {
      // Never fail a created order over approval bookkeeping.
    }
  }

  return result
}

/**
 * Kernel poll target (manifest `pollHandler` on create_shipment). Called on the
 * approval-poll schedule with the external_ref recorded above; returns
 * `{ ready: false }` until the label PDF imports, then `{ ready: true, result }`
 * with the FULL outputs so `@ref` tokens (label_file_id, tracking_number)
 * resolve for the sequence's deferred dependents.
 */
export async function pollCreateShipmentOutput(
  ctx: ShipmentCtx,
  input: { external_ref?: { shipment_row_id?: string; boxtal_order_id?: string } | null },
): Promise<{ ready: boolean; result?: Record<string, unknown> }> {
  const ref = input?.external_ref ?? null
  const rowId = ref?.shipment_row_id
  const orderId = ref?.boxtal_order_id
  if (!rowId || !orderId) return { ready: false }
  const client = await getClientOrError(ctx)
  if ("error" in client) return { ready: false }

  // Already imported (e.g. by a manual import_label_document)? Use it.
  const [row] = (await ctx.db.findMany("shipment", {
    where: { id: rowId },
    limit: 1,
  })) as Array<Record<string, unknown>>
  if (!row) return { ready: false }

  const labelFileId = await importLabelFile(ctx, client, orderId, rowId, 1)
  if (!labelFileId) return { ready: false }

  let trackingNumber = (row.tracking_number as string | null) ?? null
  if (!trackingNumber) {
    try {
      trackingNumber = (await client.v3.getTracking(orderId)).tracking_number
    } catch {
      // tracking still pending — the label is what dependents need
    }
  }
  return {
    ready: true,
    result: {
      boxtal_order_id: orderId,
      order_status: (row.order_status as string | null) ?? "PENDING",
      tracking_number: trackingNumber,
      label_file_id: labelFileId,
    },
  }
}

/** Attempts the label-import loop makes before giving up. THREE, not eight:
 *  see the worst-case arithmetic on importLabelFile. */
export const LABEL_IMPORT_ATTEMPTS = 3

/** Hard wall-clock ceiling on the whole label-import loop. Checked BEFORE each
 *  attempt, so the loop can never start work it has no budget to finish. */
export const LABEL_IMPORT_BUDGET_MS = 35_000

/** Injectable pacing/clock for the label-import loop, so tests drive the
 *  backoff with a fake clock instead of sleeping for real. */
export interface LabelImportDeps {
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
}

/** Fetch the created order's LABEL document and import it into kernel.files
 *  under the shipment row via the binary-safe host bridge. Bounded attempts,
 *  never throws — a missing label at create time is a null, backfilled later
 *  via the import_label_document tool (get_documents always serves fresh URLs
 *  on demand).
 *
 *  WORST-CASE ARITHMETIC (prod, 2026-09: print_pack held a sandbox worker for
 *  37 to 39s and operators saw "Request failed" at 30s).
 *
 *    per Boxtal call   BOXTAL_CALL_BUDGET_MS      10s   (token + request + one
 *                                                        401 refresh, each round
 *                                                        trip capped at 5s)
 *    attempts          LABEL_IMPORT_ATTEMPTS       3
 *    backoff steps     2 x RETRY_CAP_MS            3s   (full jitter, so 3s is
 *                                                        the ceiling, not the mean)
 *    -------------------------------------------------
 *    worst case        3 x 10s + 3s               33s
 *    loop deadline     LABEL_IMPORT_BUDGET_MS     35s   (no attempt starts past it)
 *    tool budget                                  60s   -> 25s of headroom for the
 *                                                        rest of print_pack
 *
 *  The old shape was 8 attempts x the sandbox-wide 10s fetch cap = 80s inside a
 *  60s budget, with no pause between attempts.
 *
 *  A label that is genuinely not generated yet still returns null, so callers
 *  degrade (print_pack reports "Label not available yet"); this never throws. */
export async function importLabelFile(
  ctx: ShipmentCtx,
  client: { v3: { getDocuments(id: string): Promise<Array<{ url?: string; type: string; format: string }>> } },
  boxtalOrderId: string,
  shipmentRowId: string,
  attempts = LABEL_IMPORT_ATTEMPTS,
  deps: LabelImportDeps = {},
): Promise<string | null> {
  if (!ctx.files_importFromUrl) return null
  const sleep = deps.sleep ?? defaultSleep
  const random = deps.random ?? Math.random
  const now = deps.now ?? (() => Date.now())
  const ATTEMPTS = attempts
  const deadlineAt = now() + LABEL_IMPORT_BUDGET_MS
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Pause BEFORE the retry (exponential with full jitter), then re-check the
      // deadline: a slow first attempt must not buy a second one we cannot afford.
      await sleep(retryDelayMs(attempt - 1, random))
    }
    if (now() >= deadlineAt) break
    let label: { url?: string } | undefined
    try {
      const docs = await client.v3.getDocuments(boxtalOrderId)
      label = docs.find((d) => d.type === "LABEL" && d.url)
    } catch {
      continue // transient read failure — try again after the backoff
    }
    if (!label?.url) continue // documents not generated yet
    try {
      const res = JSON.parse(
        await ctx.files_importFromUrl(
          JSON.stringify({
            targetApp: "boxtal",
            targetEntityType: "shipment",
            targetEntityId: shipmentRowId,
            url: label.url,
            filename: `label-${boxtalOrderId}.pdf`,
            mimeType: "application/pdf",
            // Boxtal stamps a spurious /Rotate on label pages (content is
            // authored upright) — every viewer/printer then renders the label
            // sideways. Ask the host import to clear the flag so the stored
            // label prints upright.
            pdfStripRotation: true,
          }),
        ),
      ) as { id?: string }
      return typeof res.id === "string" && res.id ? res.id : null
    } catch (err) {
      // Import failure (e.g. the signed-URL host is not in the app's egress
      // allowlist) is not retryable within this call — surface it in the logs
      // with the reason so the allowlist gets extended knowingly, and fall
      // back to null. The order itself is created and intact.
      ctx.logger?.warn?.("label import failed", {
        boxtal_order_id: boxtalOrderId,
        reason: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
  return null
}

/** The message both the stage-time preflight and the label buy refuse with while a person has
 *  not picked between the order's address and the customer's verified one. */
export const ADDRESS_DIFFERS_MESSAGE =
  "Address differs: a person must pick which address to use. The order's ship-to and the customer's verified delivery address are not the same place; pick one on the To prepare row (Address differs) before the label is staged."

/** The refusal when the label path could not read the order: the label never goes to a guess. */
export const ORDER_UNREADABLE_MESSAGE = "Could not read the order's address from the store; try again."

/** A return opens from the sale invoice, whose To prepare row may be gone once it shipped, so the
 *  pick is made with prep_set_address_choice on that invoice (a person approves an agent's call). */
export const ADDRESS_DIFFERS_RETURN_MESSAGE =
  "Address differs: a person must pick which address to use. The order's ship-to and the customer's verified delivery address are not the same place; pick one with prep_set_address_choice for this invoice (document_ref = the draft_id, choice \"order\" or \"verified\"), then stage the return again."

/** Refuses a label whose order could not be read, and holds one while the order's address and
 *  the verified one differ with no standing pick. */
export function addressPickBlock(
  draft: Pick<ShipmentDraft, "address_check">,
  opts: { isReturn?: boolean } = {},
): { code: string; message: string } | null {
  const check = draft.address_check
  if (check?.order_read === "failed")
    return {
      code: "order_unreadable",
      message: `${ORDER_UNREADABLE_MESSAGE} Nothing was bought: a label only goes to an address read from the order just now.`,
    }
  if (check?.state === "differs" && !check.choice)
    return { code: "address_differs", message: opts.isReturn ? ADDRESS_DIFFERS_RETURN_MESSAGE : ADDRESS_DIFFERS_MESSAGE }
  return null
}

/**
 * STAGE-TIME preflight for the gated `create_shipment` — runs when the agent stages the approval
 * (execute-tool.ts `if (tool.gated && tool.preflight)`), BEFORE the approval request is created, with
 * NO side effects (no reservation, no Boxtal POST). It re-derives the draft from the draft_id so the
 * SAME failures the post-approval handler would hit surface NOW (visible to the agent, who can
 * self-correct) instead of staging a doomed approval that only 422s after the human approves it:
 *
 *  • draft_id does not resolve to a real invoice — the common weak-model mistake is passing a
 *    NON-invoice id as draft_id (a hallucinated id, the approval-request "Request ID", or the other
 *    leg's id). shipmentDraftCreate throws a readable "No invoicing document found for <id>"
 *    ToolError (with the UUID-vs-number hint + proforma-anchor guidance); we catch it and return
 *    it as the preflight error so the agent fixes the id.
 *  • unresolved lines / blocked customs — no shipping profile / missing weight, mirroring createShipment.
 *  • a live (non-CANCELLED) shipment already exists for this document_ref — staging a second create for
 *    the SAME invoice would 422 "duplicate" at execution; reject it at stage time. (This catches the
 *    weak-model error of opening BOTH the return and the reship from the same invoice instead of the
 *    wrong-item doc for the return and the correct-order doc for the reship.)
 *
 * Returns a benign `{ ok: true }` when the draft is genuinely stageable. Throwing here would only fall
 * back to letting staging proceed (execute-tool catches the preflight via normalizeToolErrorResult,
 * not a try/catch), so we RETURN the structured error instead of throwing.
 */
export async function createShipmentPreflight(
  ctx: ShipmentCtx,
  rawInput: CreateShipmentInput,
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  // Same alias-tolerant address intake as createShipment.
  const input: CreateShipmentInput = {
    ...rawInput,
    recipient_address: normalizeRecipientAddress(rawInput.recipient_address),
  }
  let draft: ShipmentDraft
  try {
    draft = await shipmentDraftCreate(ctx, {
      document_ref: input.draft_id,
      ...(input.lines && !input.is_return ? { lines: input.lines } : {}),
    })
  } catch (err) {
    // shipmentDraftCreate raises a readable error when the draft_id is not a resolvable invoice id
    // (the "No invoicing document found for <id>" ToolError / UUID-vs-number class). Surface it so the
    // agent corrects the id at stage time rather than after the human approves a doomed return/reship label.
    return {
      error: {
        code: "draft_unresolved",
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
  const unresolvedBlocks = unresolvedLinesBlock(draft)
  if (unresolvedBlocks) {
    return { error: { code: "unresolved_lines", message: unresolvedBlocks } }
  }
  if (draft.customsArticles.some((a) => a.blocked)) {
    return { error: { code: "unresolved_lines", message: blockedArticlesMessage(draft) } }
  }
  {
    const held = addressPickBlock(draft, { isReturn: input.is_return === true })
    if (held) return { error: held }
  }
  // A live shipment of the SAME KIND already in flight for this invoice → the execution-time
  // reserveCreate would reject it as a duplicate. Catch it at stage time. Keyed on (document_ref, kind),
  // same as reserveCreate: an invoice may legitimately carry ONE outbound leg AND ONE return leg — a
  // warranty/RMA return opens from the ORIGINAL sale invoice, whose outbound shipment (the delivery the
  // customer already received) must NOT block staging the return. What stays rejected is a second
  // shipment of the same kind: two outbounds (a reship must open from the correct-order doc, the return
  // from the wrong-item doc — two DISTINCT ids) or two returns for the same invoice.
  const stagingKind = input.is_return ? "return" : "outbound"
  const existing = (await ctx.db.findMany("shipment", {
    where: { document_ref: draft.document_ref },
    limit: 100,
  })) as Array<Record<string, unknown>>
  {
    const block = partialBatchBlock(
      stagingKind,
      input.is_return ? undefined : input.lines,
      draft.invoice_lines,
      existing,
    )
    if (block) return { error: block }
  }
  // OFFER-CODE ROUTE VALIDATION (BL — the marco-day journey root). The agent must ship on a carrier the
  // quote actually RETURNED for THIS draft's destination route. The weak-model failure mode (the exact
  // declared weakModelRisk) is staging an EU-domestic carrier (e.g. a Colissimo `SOGP-*` offer_code) for
  // an NL/BE/DE EXPORT route the quote only offered international carriers (DPD/UPS/FedEx) for — then
  // FABRICATING "Colissimo services these destinations" to justify it. The tool accepting a non-quoted
  // offer_code as a valid pending request was the enabling defect: a doomed/wrong label that the human
  // would approve. Re-quote the draft (side-effect-free read, same offers the agent already saw) and
  // REJECT at stage time when the requested offer_code is not among the quoted offers for this route, so
  // the agent self-corrects (pick a quoted carrier — or recognize an export route has no domestic option)
  // instead of fabricating coverage. Only enforced when the quote SUCCEEDS with ≥1 offer: a quote error /
  // empty-offer route is a DIFFERENT failure the agent must re-quote, never silently blocked here.
  // PARTY COMPLETENESS AT STAGE TIME: an approval whose execution is doomed
  // (missing address field, missing email/phone) must never reach the human's
  // queue — the prod failure mode was an APPROVED return label 422ing at
  // Boxtal on fromAddress.contact.email, an error only the logs saw. Build the
  // same party execution will use (normalized aliases + contact-email
  // auto-fill) and reject with the precise missing fields so the agent
  // corrects BEFORE staging. The customer's email and phone are on the
  // ticket/contact — the agent has them.
  {
    const recipient = buildRecipientParty(draft, input)
    if (!recipient.email || recipient.email.trim() === "") {
      recipient.email = await loadContactEmail(ctx, draft.recipient_contact_id)
      if (!recipient.email) {
        const sender = await loadSenderParty(ctx)
        recipient.email = sender?.email ?? null
      }
    }
    const missing = validateParty(recipient)
    if (missing.length > 0) {
      return {
        error: {
          code: "recipient_address_required",
          message:
            `Recipient details incomplete, missing: ${missing.join(", ")}. ` +
            `Fill them from the ticket/contact (recipient_address supports name, email, phone, street, city, postalCode, countryIsoCode; recipient_phone also accepted) before staging.`,
        },
      }
    }
    // Destination-aware phone rule at STAGE time: a US/CA label with a
    // non-North-American phone is doomed to a Boxtal/FedEx 422 after approval,
    // so reject before the approval card exists (same model as the missing
    // state above), with the precise fix in the message.
    const phoneIssue = validateRecipientPhone(recipient.countryIsoCode, recipient.phone)
    if (phoneIssue) {
      return { error: { code: "recipient_phone_invalid", message: phoneIssue } }
    }
  }
  // PRICE ON THE CARD: the reviewer must always see what the label costs, so a
  // staging without quoted_price_ttc is rejected here (belt to the schema's
  // `required` braces — old callers and hand-built MCP calls get a readable fix).
  if (typeof input.quoted_price_ttc !== "number" || !Number.isFinite(input.quoted_price_ttc)) {
    return {
      error: {
        code: "quoted_price_required",
        message:
          "Pass quoted_price_ttc: copy offers[].price_ttc for your chosen offer_code from the quote result. The approval card must show the reviewer the label's cost.",
      },
    }
  }
  if (typeof input.offer_code === "string" && input.offer_code.trim() !== "") {
    // Same leg-awareness as the execution backstop: a return's offer_code was
    // quoted on the REVERSE route (is_return), so validate against that quote.
    // Same explicit-`to` as the execution backstop: a draft whose contact has no
    // shipping address 400s the draft-only cotation and silently skipped this
    // validation — quote against the address the label will be bought with.
    const preflightAddr = input.recipient_address
    const preflightTo =
      preflightAddr?.postalCode && preflightAddr.city && preflightAddr.countryIsoCode
        ? {
            city: preflightAddr.city,
            postalCode: preflightAddr.postalCode,
            country: preflightAddr.countryIsoCode,
            type: "particulier",
          }
        : undefined
    const quoted = await quote(ctx, {
      draft_id: input.draft_id,
      is_return: input.is_return,
      ...(preflightTo ? { to: preflightTo } : {}),
      // A deliberately-chosen relay offer must survive the org pickup-point policy at
      // stage-time validation too, or the human never gets to approve it (execution
      // threads the same flag).
      ...(input.include_pickup_point ? { include_pickup_point: true } : {}),
      // Carrier allowlist is advisory, not a buy-time gate (see the execution re-quote
      // above): a non-allowlisted carrier the operator explicitly picked must pass
      // stage-time preflight so the human gets to approve it. Route-validity + relay
      // exclusion still apply.
      ignore_allowlist: true,
    })
    if (!quoted.error && quoted.offers.length > 0) {
      const validCodes = new Set(quoted.offers.map((o) => o.offer_code))
      if (!validCodes.has(input.offer_code)) {
        const available = quoted.offers
          .map((o) => `${o.offer_code} (${o.carrier} ${o.service})`)
          .join(", ")
        return {
          error: {
            code: "offer_not_quoted",
            message:
              `The offer_code "${input.offer_code}" was NOT returned by a quote for this shipment's ` +
              `destination route: do not ship on a carrier the quote didn't offer for this route (and ` +
              `never claim a carrier services a destination the quote contradicts). Re-quote this draft ` +
              `and pick one of the offers actually available for it: ${available}.`,
          },
        }
      }
    }
  }
  return { ok: true }
}

/**
 * Assemble the recipient party: structured fields from the operator-supplied
 * `recipient_address`, with the NAME + COUNTRY defaulted from the invoice
 * snapshot and the PHONE preferring the explicit `recipient_phone` param.
 */
function buildRecipientParty(
  draft: ShipmentDraft,
  input: CreateShipmentInput,
): PostalParty {
  // The agent's explicit `recipient_address` param wins; otherwise fall back to
  // the address pre-filled on the draft from the linked contact's stored address
  // (so a gated create resolves without the operator re-keying an on-file
  // address). Field-by-field so an explicit partial override (e.g. a corrected
  // street) still inherits the rest from the contact pre-fill. BLANK-AWARE: a
  // weak model often passes `recipient_address` with empty-string fields (it
  // "knows" the param exists but has no value) — a bare `??` would keep that "",
  // defeating the pre-fill and re-introducing recipient_address_required at
  // execution. So an empty/whitespace agent field falls through to the contact
  // pre-fill, which falls through to the invoice defaults.
  const a = input.recipient_address ?? {}
  const pre = draft.recipient_address ?? {}
  // First non-blank string across the candidates (null when all blank).
  const pick = (...vals: Array<string | null | undefined>): string | null => {
    for (const v of vals) if (typeof v === "string" && v.trim() !== "") return v
    return null
  }
  return {
    name: pick(a.name, pre.name, draft.recipient),
    company: pick(a.company, pre.company),
    email: pick(a.email, pre.email),
    phone: pick(input.recipient_phone, a.phone, pre.phone),
    street: pick(a.street, pre.street),
    city: pick(a.city, pre.city),
    postalCode: pick(a.postalCode, pre.postalCode),
    countryIsoCode: pick(a.countryIsoCode, pre.countryIsoCode, draft.recipient_country),
    state: normalizeRegion(
      pick(a.countryIsoCode, pre.countryIsoCode, draft.recipient_country),
      pick(a.state, pre.state),
    ),
    type: "BUSINESS",
  }
}

/**
 * Release a reservation after a DETERMINISTIC reject (e.g. 422): delete the
 * in-flight row so it stops holding the `document_ref` uniqueness slot and a
 * corrected retry can reserve again. The MockDb + real bridge both support
 * delete; we fall back to markUncertain only if delete is unavailable.
 */
async function releaseReservation(ctx: ShipmentCtx, rowId: string): Promise<void> {
  await ctx.db.delete("shipment", rowId)
}

// — gated cancel_shipment —

const NON_CANCELLABLE_TRACKING = new Set([
  "SHIPPED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
])

export interface CancelResult {
  order_status?: string
  error?: { code: string; message: string }
}

/**
 * Read-only load of a cancel target: the Boxtal client plus the live order
 * status. ONE copy, called by BOTH the stage-time preflight and the handler, so
 * the connection and order-status reads can never drift apart. A Boxtal API
 * failure still throws here exactly as before; only the preflight classifies a
 * not-found into a typed refusal.
 */
async function loadCancelTarget(
  ctx: ShipmentCtx,
  id: string,
): Promise<
  { error: { code: string; message: string } } | { client: BoxtalFacade; orderStatus: string | null }
> {
  const client = await getClientOrError(ctx)
  if ("error" in client) {
    return { error: client.error }
  }
  const order = await client.v3.getShippingOrder(id)
  return { client, orderStatus: order.order_status ?? null }
}

/**
 * cancel_shipment STAGE-TIME preflight (manifest `preflight`). cancel_shipment is
 * gated, so WHY this exists: a gated call must not be parked for a human when the
 * data it needs is missing. Without it, a cancel aimed at an id Boxtal does not
 * know (or issued while Boxtal is not connected) still files an approval, and the
 * failure only surfaces once a human has clicked approve.
 *
 * Deliberately PARTIAL. The dispatch check stays in the handler and is NOT
 * mirrored here: a carrier can dispatch between staging and approval, so it is a
 * genuine race that only the handler can settle. An already-CANCELLED shipment
 * also passes: the handler treats it as an idempotent no-op SUCCESS, and refusing
 * it here would turn a success into an error. Read-only: no writes, no cancel
 * call.
 */
export async function cancelShipmentPreflight(
  ctx: ShipmentCtx,
  input: { id: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  let target: Awaited<ReturnType<typeof loadCancelTarget>>
  try {
    target = await loadCancelTarget(ctx, input.id)
  } catch (err) {
    if (err instanceof BoxtalApiError && (err.status === 404 || err.status === 410)) {
      return {
        error: {
          code: "shipment_not_found",
          message:
            `Boxtal has no shipping order ${input.id}, so there is nothing to cancel. ` +
            "Re-check the id with boxtal__search or boxtal__get_shipment before staging a cancellation.",
        },
      }
    }
    throw err
  }
  if ("error" in target) return { error: target.error }
  return { ok: true }
}

/**
 * Gated cancel. Pre-checks the live order/tracking status: a shipment that is
 * already dispatched/delivered is refused. An already-CANCELLED shipment is an
 * idempotent no-op success.
 */
export async function cancelShipment(
  ctx: ShipmentCtx,
  input: { id: string },
): Promise<CancelResult> {
  const target = await loadCancelTarget(ctx, input.id)
  if ("error" in target) {
    return { error: target.error }
  }
  const { client } = target
  if (target.orderStatus === "CANCELLED") {
    return { order_status: "CANCELLED" }
  }
  const tracking = await client.v3.getTracking(input.id)
  if (tracking.tracking_status && NON_CANCELLABLE_TRACKING.has(tracking.tracking_status)) {
    return { error: { code: "already_dispatched", message: "Shipment already dispatched/delivered, cannot cancel." } }
  }
  await client.v3.cancel(input.id)
  const rows = (await ctx.db.findMany("shipment", { where: { boxtal_order_id: input.id }, limit: 1 })) as Array<{ id: string }>
  if (rows[0]) {
    await ctx.db.update("shipment", rows[0].id, { order_status: "CANCELLED" })
  }
  return { order_status: "CANCELLED" }
}

/**
 * Map a resolved draft + selected offer into the v3 create draft. Addresses are
 * the REAL assembled sender/recipient (validated by the caller). The customs
 * declaration is attached only when the route requires it (`customs_required`);
 * an intra-EU route omits the block entirely (spec §C.3 / "Domestic (EU)").
 */
function buildCreateDraft(
  draft: ShipmentDraft,
  offerCode: string,
  addresses: { fromAddress: BoxtalAddress; toAddress: BoxtalAddress; reason: CustomsBasis },
  expectedTakingOverDate?: string,
  opts?: { externalId?: string | null; labelFormat?: LabelFormat },
): BoxtalCreateDraft {
  const currency = draft.customsArticles[0]?.unitValue.currency ?? "EUR"
  const declaredTotal = draft.customsArticles.reduce(
    (s, a) => s + a.quantity * a.unitValue.value,
    0,
  )
  // Distribute the declared value across parcels so each carries a non-zero
  // insurable/customs value (Boxtal rejects a 0-value international parcel).
  const perParcel = draft.parcels.length > 0 ? declaredTotal / draft.parcels.length : declaredTotal
  // Only attach customs when the route requires it AND there are articles.
  const attachCustoms = draft.customs_required && draft.customsArticles.length > 0
  return {
    shippingOfferCode: offerCode,
    fromAddress: addresses.fromAddress,
    toAddress: addresses.toAddress,
    packages: draft.parcels.map((p) => ({
      weight: p.weight,
      length: p.length,
      width: p.width,
      height: p.height,
      value: { value: perParcel, currency },
    })),
    content: draft.content_code ? { id: `content:v1:${draft.content_code}`, description: "" } : undefined,
    customsDeclaration: attachCustoms
      ? {
          reason: addresses.reason,
          articles: draft.customsArticles.map((a) => ({
            description: a.description,
            quantity: a.quantity,
            unitWeight: a.unitWeight ?? 0,
            unitValue: a.unitValue,
            originCountry: a.originCountry ?? "",
            tariffNumber: a.tariffNumber ?? undefined,
          })),
        }
      : undefined,
    insured: false,
    labelType: opts?.labelFormat ?? "PDF_A4",
    // The ORDER reference, not the invoice UUID. Boxtal echoes `externalId` back
    // as `external_id` on search/track, and every read tool documents it as "the
    // order this shipment is for" -- so pointing it at the invoicing document id
    // meant the one field built to carry the order number carried something no
    // operator, carrier dispute or support ticket ever quotes (ticket-10202).
    // Falls back to the document_ref when the invoice has no linked order, which
    // keeps a stable, resolvable reference rather than an empty field.
    externalId: opts?.externalId ?? draft.document_ref,
    ...(expectedTakingOverDate ? { expectedTakingOverDate } : {}),
  }
}
