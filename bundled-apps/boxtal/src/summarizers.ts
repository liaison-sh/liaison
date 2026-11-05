// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated-tool approval summarizers (host-side runtime import, TRUSTED bundled app).
// Bundled into the freeze entrypoint via the `export * from "./summarizers"`
// re-export in src/handlers.ts, so the host's `loadTrustedBundleFunction` can
// resolve them from the built bundle (mirrors the shopify bundled-app convention).
//
// An approval summarizer turns a gated tool's params into the human-reviewable
// ApprovalSummary that the kernel records on the approval request AND echoes back
// to the agent inside the BLOCKED envelope. These are pure (no DB / no fetch) so
// they are safe to run synchronously at gate time.
//
// Each gated tool below also declares a manifest `summarizerContext`: the kernel
// runs an UNGATED read of this app (shipment_draft_get / get_shipment) at gate
// time and passes the result as `meta.context` — the third argument. Summarizers
// read it defensively (`meta?.context`) so a card still renders — from params
// alone — if hydration is unavailable, degraded, or not wired for this host tier.

import { sameLocation } from "./address-check"

interface ApprovalSummaryLinkShape {
  label: string
  app: string
  entityType: string
  entityId: string
}

interface ApprovalSummaryShape {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
  links?: ApprovalSummaryLinkShape[]
}

/** Third positional arg the kernel passes to a gated tool's summarizer. */
interface SummarizerMeta {
  connectionIdentifier?: string | null
  context?: unknown
}

// Shape of the shipment_draft_get read result (see src/shipment.ts ShipmentDraft),
// narrowed to the fields the create_shipment card needs.
interface DraftContext {
  draft_id?: string
  document_ref?: string
  recipient?: string
  recipient_country?: string | null
  recipient_address?: {
    name?: string | null
    street?: string | null
    city?: string | null
    postalCode?: string | null
    countryIsoCode?: string | null
    phone?: string | null
  } | null
  sender?: {
    name?: string | null
    company?: string | null
    street?: string | null
    city?: string | null
    postalCode?: string | null
    countryIsoCode?: string | null
  } | null
  parcels?: Array<{ length?: number; width?: number; height?: number; weight?: number }>
  customs_required?: boolean
  customsArticles?: Array<{
    quantity?: number | string
    unitValue?: { value?: number; currency?: string } | null
    tariffNumber?: string | null
  }>
  lineSummaries?: Array<{ label?: string; line_kind?: string; quantity?: number }>
  /** The source invoice's issue date (YYYY-MM-DD) — see shipment.ts ShipmentDraft.invoice_issued_at. */
  invoice_issued_at?: string | null
  /** The anchor document's number and the store order name (shipment.ts ShipmentDraft). */
  document_number?: string | null
  order_name?: string | null
  /** What the packing rules could not decide alone (shipment.ts ShipmentDraft.packing_warnings). */
  packing_warnings?: string[]
  /** Which address the label goes to and whether it is verified (address-check.ts AddressCheck). */
  address_check?: unknown
}

// Shape of the get_shipment read result (see src/reads.ts ShipmentView), narrowed
// to the fields the cancel_shipment / claim_open cards need.
interface ShipmentContext {
  id?: string
  order_status?: string
  tracking_status?: string | null
  recipient_summary?: string | null
  offer_code?: string | null
  /** When the local shipment record was created (see reads.ts ShipmentView.created_at). */
  created_at?: string | null
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null
}

/** Slice an ISO-8601 date/date-time string to its `YYYY-MM-DD` calendar date for a
 *  reviewer-legible summary line — malformed/absent input degrades to null. */
function dateOnly(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1]! : null
}

const ADDRESS_SOURCE_LABEL: Record<string, string> = {
  order: "from the order",
  verified: "the verified address",
  prep_recipient: "typed on the row",
  contact: "copied onto the contact",
  customer_default: "the customer's default address",
  invoice: "from the invoice",
}

const VERIFICATION_SOURCE_LABEL: Record<string, string> = {
  purchase_order: "a purchase order",
  email: "an email",
  phone_call: "a phone call",
  other: "another source",
}

/**
 * The card's one address line: which address the label goes to and whether it is verified.
 * Null for a customer with NO verified address (state no_verified, or a draft from before the
 * address book): their card stays exactly as it was, no new line.
 */
export function addressProvenanceLine(check: unknown): string | null {
  if (!isRec(check)) return null
  const state = str(check.state)
  if (!state || state === "no_verified") return null
  const used = isRec(check.used) ? check.used : null
  const source = str(used?.source)
  const choice = isRec(check.choice) ? check.choice : null
  const pick = str(choice?.pick)
  const where =
    source === "operator_choice"
      ? pick === "verified"
        ? "the verified address, picked by a person"
        : "from the order, picked by a person"
      : ((source && ADDRESS_SOURCE_LABEL[source]) ?? "from the order")
  const verifiedAt = dateOnly(used?.verified_at)
  const proof = verifiedAt
    ? `verified ${verifiedAt} by ${str(used?.verified_by_name) ?? "a person"} from ${
        VERIFICATION_SOURCE_LABEL[str(used?.verification_source) ?? ""] ?? "an unrecorded source"
      }`
    : "not verified"
  const held = state === "differs" && !choice ? "; differs from the verified address, a person must pick" : ""
  return `Address: ${where}, ${proof}${held}`
}

// The Shipments tab is a singleton list surface (`referenceable: false`), so a
// link points at the list, not a specific shipment row.
const SHIPMENTS_LINK: ApprovalSummaryLinkShape = {
  label: "Open shipments in Boxtal",
  app: "boxtal",
  entityType: "shipments",
  entityId: "shipments",
}

/**
 * Summary for boxtal `create_shipment` — stages a carrier label from a resolved draft.
 * Names the draft, the chosen carrier offer, the recipient address fields actually
 * supplied (never fabricating a full address the human still needs to confirm), and
 * whether this is an outbound shipment or a reverse/return label.
 *
 * Hydrated via manifest `summarizerContext` (shipment_draft_get on `draft_id`):
 * when the read succeeds, `meta.context` names the recipient + destination from the
 * draft itself (not just whatever `recipient_address` fields the call happened to
 * pass), and surfaces package count/weight + whether customs is required. Falls
 * back to params-only rendering when the hydration is absent or degraded.
 */
export function summarizeCreateShipment(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const draftId = str(p.draft_id) ?? "(unknown draft)"
  const offerCode = str(p.offer_code) ?? "(no carrier selected)"
  const isReturn = p.is_return === true
  // Same alias tolerance as execution (zip/address1/countryCode dialects): the
  // card must not scream "fields still needed" for an address execution will
  // accept. Inline (not imported): summarizers must stay dependency-free pure
  // functions the host can load standalone from the bundle.
  const rawAddress = isRec(p.recipient_address) ? p.recipient_address : null
  const address = rawAddress
    ? (() => {
        const streetAlias = [str(rawAddress.address1), str(rawAddress.address2)]
          .filter(Boolean)
          .join(", ")
        const countryAlias = str(rawAddress.countryCode) ?? str(rawAddress.country_code)
        return {
          ...rawAddress,
          street: str(rawAddress.street) ?? (streetAlias !== "" ? streetAlias : null),
          postalCode:
            str(rawAddress.postalCode) ??
            str(rawAddress.zip) ??
            str(rawAddress.postal_code) ??
            str(rawAddress.postcode),
          countryIsoCode:
            str(rawAddress.countryIsoCode) ??
            (countryAlias && countryAlias.length === 2 ? countryAlias.toUpperCase() : null),
        } as Record<string, unknown>
      })()
    : null
  const draft = isRec(meta?.context) ? (meta.context as DraftContext) : null

  // One "Name, street, postal city, country" line from whatever address fields
  // exist — used for both the From (sender) and To (recipient) lines.
  const addressLine = (a: {
    name?: unknown
    company?: unknown
    street?: unknown
    city?: unknown
    postalCode?: unknown
    countryIsoCode?: unknown
    phone?: unknown
  }): string | null => {
    const who = [str(a.company), str(a.name)].filter(Boolean).join(" / ")
    const locality = [str(a.postalCode), str(a.city)].filter(Boolean).join(" ")
    const parts = [who || null, str(a.street), locality || null, str(a.countryIsoCode)].filter(Boolean)
    if (parts.length === 0) return null
    const phone = str(a.phone)
    return phone ? `${parts.join(", ")} (${phone})` : parts.join(", ")
  }

  const lines: string[] = []

  // PRICE — the reviewer must ALWAYS see what the label costs before buying.
  // Comes from the required quoted_price_ttc param (copied by the caller from
  // the quote that returned offer_code); execution re-checks it against the
  // live price (>10% drift rejects). A missing price is rendered LOUDLY, never
  // silently omitted. Folded into the carrier line to fit the card's 8-line cap.
  const price = typeof p.quoted_price_ttc === "number" ? p.quoted_price_ttc : Number(p.quoted_price_ttc ?? Number.NaN)
  const currency = str(p.quoted_currency) ?? "EUR"
  if (Number.isFinite(price)) {
    lines.push(`Carrier: ${offerCode}, ${price.toFixed(2)} ${currency} TTC`)
  } else {
    lines.push(`Carrier: ${offerCode}`)
    lines.push("Price: NOT PROVIDED. Deny and ask for a re-stage with quoted_price_ttc")
  }

  // REVERSE label warning goes early so it always survives the 8-line cap.
  if (isReturn) {
    lines.push("REVERSE shipment: a prepaid RETURN label (customer -> us), addresses are swapped")
    const reason = str(p.return_reason)
    if (reason) lines.push(`Return reason: ${reason}`)
  }

  // FROM — the org's persisted ship-from (rides in on the hydrated draft).
  const senderLine = draft?.sender && isRec(draft.sender) ? addressLine(draft.sender) : null
  if (senderLine) lines.push(`From: ${senderLine}`)

  // TO — field by field, as the label buy resolves it (buildRecipientParty): a
  // field the call supplies wins, else the hydrated draft's recipient address
  // fills it. A call naming only part of the address (the name and the phone)
  // still ships to the draft's street, so the card must not list it as missing.
  const draftAddress = draft && isRec(draft.recipient_address) ? draft.recipient_address : null
  if (address || draftAddress) {
    const call = (address ?? {}) as Record<string, unknown>
    const pre = (draftAddress ?? {}) as Record<string, unknown>
    const field = (k: string) => str(call[k]) ?? str(pre[k])
    const merged = {
      company: field("company"),
      street: field("street"),
      city: field("city"),
      postalCode: field("postalCode"),
      name: field("name") ?? str(draft?.recipient),
      countryIsoCode: field("countryIsoCode") ?? str(draft?.recipient_country),
      phone: str(p.recipient_phone) ?? field("phone"),
    }
    const toLine = addressLine(merged)
    if (toLine) lines.push(`To: ${toLine}`)
    const missing = ["street", "city", "postalCode", "countryIsoCode"].filter(
      (f) => !str((merged as Record<string, unknown>)[f]),
    )
    if (missing.length > 0) lines.push(`Address fields still needed before the label is bought: ${missing.join(", ")}`)
    // Which address that is and whether a person verified it. Only once the customer has a
    // verified address; otherwise the card is exactly what it always was. A place typed in the
    // call wins field by field, so the resolved address's provenance describes the label only
    // when the typed address is that same place.
    const provenance = addressProvenanceLine(draft?.address_check)
    if (provenance) {
      const typedPlace = ["street", "city", "postalCode", "countryIsoCode"].some((k) => str(call[k]) != null)
      const loc = (a: Record<string, unknown>) => ({
        street: str(a.street),
        city: str(a.city),
        postalCode: str(a.postalCode),
        countryIsoCode: str(a.countryIsoCode),
      })
      lines.push(
        typedPlace && !sameLocation(loc(merged), loc(pre)) ? "Address: typed in the call, not verified" : provenance,
      )
    }
  } else {
    lines.push("Recipient address: taken from the source invoice (confirm on the approval card before buying)")
  }

  // CONTENTS — compact goods summary from the draft's line summaries ("1x ET2, 1x MP").
  if (draft && isArr(draft.lineSummaries)) {
    const goods = draft.lineSummaries
      .filter((l) => isRec(l) && (str(l.line_kind) ?? "goods") === "goods")
      .map((l) => `${typeof l.quantity === "number" ? l.quantity : "?"}x ${str(l.label) ?? "?"}`)
    if (goods.length > 0) lines.push(`Contents: ${goods.join(", ")}`)
  }

  // PACKAGE — count, dimensions and total weight, when the draft hydrated.
  if (draft && isArr(draft.parcels) && draft.parcels.length > 0) {
    const count = draft.parcels.length
    const totalWeight = draft.parcels.reduce((sum, pk) => sum + (typeof pk.weight === "number" ? pk.weight : 0), 0)
    const first = draft.parcels[0]
    const dims =
      first && typeof first.length === "number" && typeof first.width === "number" && typeof first.height === "number"
        ? `${first.length}x${first.width}x${first.height} cm`
        : null
    const bits = [
      `${count} parcel${count === 1 ? "" : "s"}`,
      ...(dims && count === 1 ? [dims] : []),
      ...(totalWeight > 0 ? [`${totalWeight.toFixed(2)} kg total`] : []),
    ]
    // Several parcels: list each one, so the reviewer sees exactly what is being labelled.
    const each =
      count > 1
        ? draft.parcels
            .map((pk) => {
              const d =
                typeof pk.length === "number" && typeof pk.width === "number" && typeof pk.height === "number"
                  ? `${pk.length}x${pk.width}x${pk.height} cm`
                  : null
              const w = typeof pk.weight === "number" ? `${pk.weight} kg` : null
              return [d, w].filter(Boolean).join(" ")
            })
            .filter((t) => t !== "")
        : []
    lines.push(`Package: ${bits.join(", ")}${each.length > 0 ? ` (${each.join("; ")})` : ""}`)
  }

  // The packing rules' own doubts (no carton fits, an assumed carton tare) travel with the decision.
  const packingWarnings = isArr(draft?.packing_warnings)
    ? draft.packing_warnings.filter((w): w is string => typeof w === "string" && w.trim() !== "")
    : []
  if (packingWarnings.length > 0) lines.push(`Check the packing: ${packingWarnings.join(" ")}`)

  // CUSTOMS — export routes get the declared total + the per-line HS codes.
  if (draft?.customs_required === true) {
    const articles = isArr(draft.customsArticles) ? draft.customsArticles.filter(isRec) : []
    if (articles.length > 0) {
      let declared = 0
      let declaredCurrency: string | null = null
      const hsCodes: string[] = []
      for (const a of articles) {
        const qty = typeof a.quantity === "number" ? a.quantity : Number(a.quantity ?? 1)
        const unit = isRec(a.unitValue) && typeof a.unitValue.value === "number" ? a.unitValue.value : 0
        declared += (Number.isFinite(qty) ? qty : 1) * unit
        declaredCurrency = declaredCurrency ?? (isRec(a.unitValue) ? (str(a.unitValue.currency) ?? null) : null)
        const hs = str(a.tariffNumber)
        if (hs && !hsCodes.includes(hs)) hsCodes.push(hs)
      }
      const valuePart = declared > 0 ? `, declared ${declared.toFixed(2)} ${declaredCurrency ?? ""}`.trimEnd() : ""
      const hsPart = hsCodes.length > 0 ? `, HS ${hsCodes.join(", ")}` : ""
      lines.push(`Customs export: ${articles.length} article${articles.length === 1 ? "" : "s"}${valuePart}${hsPart}`)
    } else {
      lines.push("Customs declaration required (export route)")
    }
  }

  // The source invoice's issue date (a draft has no creation timestamp of its own). Last: the
  // least decisive line is the one the card's line cap drops first.
  const invoiceIssuedAt = dateOnly(draft?.invoice_issued_at)
  if (invoiceIssuedAt) lines.push(`Invoice issued: ${invoiceIssuedAt}`)

  // The draft id IS the source invoice's document id, so the card can deep-link
  // the invoice (the shipment itself does not exist until the approval executes,
  // so a shipments-list link led nowhere useful).
  const invoiceDocId = str(p.draft_id) ?? str(draft?.document_ref)
  const links: ApprovalSummaryLinkShape[] = invoiceDocId
    ? [{ label: "Open invoice", app: "invoicing", entityType: "detail", entityId: invoiceDocId }]
    : [SHIPMENTS_LINK]

  // Name WHAT the label is for: the order and its document, and who receives it. The draft id is a
  // UUID nobody can check against the shipping grid, so it is only the fallback.
  const orderName = str(draft?.order_name)
  const docNumber = str(draft?.document_number)
  const recipientName = str(address?.name) ?? str(draft?.recipient_address?.name) ?? str(draft?.recipient)
  const what = orderName
    ? `order ${orderName}${docNumber ? ` (${docNumber})` : ""}`
    : docNumber
      ? docNumber
      : null
  const title = what
    ? `${isReturn ? "Return label" : "Buy label"} for ${what}${recipientName ? `, ${recipientName}` : ""}, via ${offerCode}`
    : isReturn
      ? `Stage return label for draft ${draftId} via ${offerCode}`
      : `Ship draft ${draftId} via ${offerCode}`

  return Promise.resolve({
    kind: "create_shipment",
    title,
    subtitle: "Pending approval, nothing is shipped or bought yet",
    lines,
    links,
  })
}

/**
 * Summary for boxtal `prep_set_address_choice`: a person picks which address the label goes to
 * when the order's ship-to and the customer's verified delivery address differ. Shows both, and
 * which one the pick ships to. Hydrated with the row's draft (shipment_draft_get).
 */
export function summarizeAddressChoice(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const pick = str(p.choice) === "verified" ? "verified" : "order"
  const draft = isRec(meta?.context) ? (meta.context as DraftContext) : null
  const check = isRec(draft?.address_check) ? draft.address_check : null
  const line = (a: unknown): string => {
    if (!isRec(a)) return "(unknown)"
    const locality = [str(a.postalCode), str(a.city)].filter(Boolean).join(" ")
    const who = [str(a.company), str(a.name)].filter(Boolean).join(" / ")
    return [who || null, str(a.street), locality || null, str(a.countryIsoCode)].filter(Boolean).join(", ") || "(empty)"
  }
  const lines = [
    `Order address: ${line(check?.order_address)}`,
    `Verified address: ${line(check?.verified_address)}`,
    `The label goes to the ${pick === "verified" ? "verified address" : "order's address"}`,
  ]
  const what = str(draft?.order_name) ?? str(draft?.document_number) ?? str(p.document_ref) ?? "this row"
  return Promise.resolve({
    kind: "address_choice",
    title: `Ship ${what} to the ${pick === "verified" ? "verified address" : "order's address"}`,
    subtitle: "The order's address and the customer's verified address differ",
    lines,
  })
}

/**
 * Summary for boxtal `claim_open` — files a carrier money claim against a shipment
 * already in an exception state. Surfaces the claim type, amount, and evidence
 * attachment count so the reviewer sees exactly what is being filed.
 *
 * Hydrated via manifest `summarizerContext` (get_shipment on `shipment_id`): when
 * the read succeeds, `meta.context` names the recipient and the live order/tracking
 * status the claim is being filed against. Falls back to the bare shipment id when
 * hydration is absent or degraded.
 */
export function summarizeClaimOpen(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const shipmentId = str(p.shipment_id) ?? "(unknown shipment)"
  const type = str(p.type) ?? "(unspecified)"
  const amount = typeof p.amount === "number" ? p.amount : Number(p.amount ?? Number.NaN)
  const evidence = isArr(p.evidence_file_ids) ? p.evidence_file_ids.length : 0
  const shipment = isRec(meta?.context) ? (meta.context as ShipmentContext) : null

  const lines = [
    `Claim type: ${type}`,
    `Amount: ${Number.isFinite(amount) ? amount : "(unspecified)"}`,
    `Evidence files attached: ${evidence}`,
  ]
  const recipient = str(shipment?.recipient_summary)
  if (recipient) lines.push(`Recipient: ${recipient}`)
  const trackingStatus = str(shipment?.tracking_status)
  if (trackingStatus) lines.push(`Live tracking status: ${trackingStatus}`)
  const shipmentCreatedAt = dateOnly(shipment?.created_at)
  if (shipmentCreatedAt) lines.push(`Shipment created: ${shipmentCreatedAt}`)

  return Promise.resolve({
    kind: "claim_open",
    title: recipient
      ? `Open ${type} claim for shipment ${shipmentId} (${recipient})`
      : `Open ${type} claim for shipment ${shipmentId}`,
    subtitle: "Pending approval, no claim has been filed yet",
    lines,
    links: [SHIPMENTS_LINK],
  })
}

/**
 * Summary for boxtal `cancel_shipment` — cancels a not-yet-dispatched shipment.
 * Cancellation only stops the shipment; it does not re-address or re-ship, so the
 * card names the shipment being stopped, nothing more (the tool takes no other
 * params).
 *
 * Hydrated via manifest `summarizerContext` (get_shipment on `id`): when the read
 * succeeds, `meta.context` names the recipient and the shipment's live status so
 * the reviewer sees WHAT is being stopped, not just an opaque id. Falls back to
 * the bare shipment id when hydration is absent or degraded.
 */
export function summarizeCancelShipment(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const id = str(p.id) ?? "(unknown shipment)"
  const shipment = isRec(meta?.context) ? (meta.context as ShipmentContext) : null

  const recipient = str(shipment?.recipient_summary)
  const lines = [`Shipment: ${id}`]
  if (recipient) lines.push(`Recipient: ${recipient}`)
  const orderStatus = str(shipment?.order_status)
  if (orderStatus) lines.push(`Current status: ${orderStatus}`)
  const shipmentCreatedAt = dateOnly(shipment?.created_at)
  if (shipmentCreatedAt) lines.push(`Shipment created: ${shipmentCreatedAt}`)

  return Promise.resolve({
    kind: "cancel_shipment",
    title: recipient ? `Cancel shipment ${id} (${recipient})` : `Cancel shipment ${id}`,
    subtitle: "Pending approval, this only stops the shipment (no re-ship)",
    lines,
    links: [SHIPMENTS_LINK],
  })
}

/**
 * settle_orphan_create: an agent proposes how an unfinished label purchase is settled. The card
 * says which outcome, and what each one does to the invoice, from the params alone.
 */
export function summarizeSettleOrphanCreate(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const id = str(p.id) ?? "(unknown shipment)"
  const adopt = p.outcome === "adopt"
  const orderId = str(p.boxtal_order_id)
  const lines = [`Shipment: ${id}`]
  if (adopt) lines.push(`Boxtal order: ${orderId ?? "(missing)"}`)
  const note = str(p.note)
  if (note) lines.push(`Note: ${note}`)
  return Promise.resolve({
    kind: "settle_orphan_create",
    title: adopt
      ? `Link unfinished label purchase ${id} to Boxtal order ${orderId ?? "(missing)"}`
      : `Release unfinished label purchase ${id}`,
    subtitle: adopt
      ? "Pending approval, the Boxtal order is read back and linked, nothing is bought"
      : "Pending approval, confirms no label was bought and frees the invoice for a new label",
    lines,
    links: [SHIPMENTS_LINK],
  })
}

const SENDER_FIELDS = [
  "name",
  "company",
  "email",
  "phone",
  "street",
  "city",
  "postalCode",
  "countryIsoCode",
] as const

/**
 * settings_sender_address_set: the ship-from address printed on every label and
 * used as the carrier's return address. Hydrated with settings_sender_address_get
 * so the card shows each changed field as `old -> new`; without it, the new values.
 */
export function summarizeSenderAddressSet(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const ctxSender = isRec(meta?.context) ? (meta.context as { sender?: unknown }).sender : null
  const current = isRec(ctxSender) ? ctxSender : null
  const lines: string[] = []
  for (const f of SENDER_FIELDS) {
    const next = str(p[f]) ?? ""
    const prev = current ? (str(current[f]) ?? "") : null
    if (prev !== null && prev === next) continue
    lines.push(prev !== null ? `${f}: ${prev || "(empty)"} -> ${next || "(empty)"}` : `${f}: ${next || "(empty)"}`)
  }
  return Promise.resolve({
    kind: "sender_address_set",
    title: `Change the ship-from address to ${[str(p.company) ?? str(p.name), str(p.city)].filter(Boolean).join(", ")}`,
    subtitle: "Printed on every shipping label and used as the return address",
    lines: lines.length > 0 ? lines : ["(no change)"],
  })
}
