// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The NOMINAL PROFORMA: the shipping document for a parcel that is not a sale.
//
// A repaired unit going back to its owner and a sample going to a dealer both cross a border with
// no commercial invoice behind them. Customs still needs a document, so the app issues a proforma
// at the org's nominal value (packaging policy `nominal_proforma_value_minor`) through the invoicing app and re-anchors the row's draft, parcels, customs articles and
// quote on it.
//
// ONE LINE PER PHYSICAL ITEM, always. `buildDraftFromDoc` (shipment.ts) derives the parcels from the
// anchor document's LINES via resolvePackages, and one customs article per line. A single "1x
// repair" summary line would therefore resolve to ONE parcel for a three-item return and a
// customs declaration that lists nothing that is actually in the box. So each item gets its own
// line with its real quantity and its catalog reference, and the nominal value is SPLIT across the
// lines rather than being the value of a fictional single item.
//
// CORRELATION. A gated issue can come back `pending_approval`, i.e. the document does not exist yet
// and will appear later with an id the app never saw. The row therefore stamps the request with a
// correlation reference that survives the approval: `shipment_ref = "prep:<order_key>"`, which
// invoicing mirrors onto an indexed column and RETURNS on documents_search. (The human-readable
// `[prep:<order_key>]` token also rides in `reason`, where it shows on the approval card and on the
// document, but `reason` lands in `external_refs` and is not returned by documents_search, so it
// cannot be the match key.)

import type { BoxtalToolCtx } from "./ctx"
import { loadPackagingPolicy } from "./settings"

/** Categories that ship on an app-issued nominal proforma rather than a sale invoice. */
export type NominalCategory = "repair" | "gift"

/** House customs wording, one per category. Printed on every line of the document. */
export const NOMINAL_WORDING: Record<NominalCategory, string> = {
  repair: "RETURN AFTER REPAIR - NO COMMERCIAL VALUE",
  gift: "SAMPLE - NO COMMERCIAL VALUE",
}

/** Short label that opens the document's `reason`, before the correlation token. */
export const NOMINAL_REASON_LABEL: Record<NominalCategory, string> = {
  repair: "RETURN AFTER REPAIR",
  gift: "SAMPLE",
}

export const PREP_PROFORMA_REF_PREFIX = "prep:"

/** The correlation reference stamped on the proforma request and returned by documents_search. */
export function prepProformaShipmentRef(orderKey: string): string {
  return `${PREP_PROFORMA_REF_PREFIX}${orderKey}`
}

/** The human-readable correlation token carried in `reason` (approval card + document). */
export function prepProformaToken(orderKey: string): string {
  return `[prep:${orderKey}]`
}

export interface ProformaItem {
  /** Catalog id (Shopify variant gid or bare id) so issue-time customs enrichment can fill in. */
  external_id?: string | null
  product_source?: string | null
  name: string
  quantity: number
  hs_code?: string | null
  customs_description?: string | null
  country_of_origin?: string | null
}

export interface ProformaLine {
  description: string
  quantity: number
  unit_price_minor: number
  hs_code?: string
  customs_description?: string
  country_of_origin?: string
  product_source?: string
  external_id?: string
}

/**
 * Split the nominal total across the item lines.
 *
 * Every line carries its REAL quantity (the declaration has to match what is in the box), so the
 * split works on unit prices: one minor unit per unit shipped, and the remainder loaded onto the
 * first line's unit price. When the remainder does not divide evenly by the first line's quantity,
 * the few units left over go on a final handling line of quantity 1 rather than distorting an
 * item's declared unit value.
 *
 * When more than `total` units ship (100+ units on one nominal document, which no real return is),
 * the split degrades to one minor unit per unit and the document totals that instead: a nominal
 * document must never declare a ZERO unit value, which customs reads as a missing value.
 */
export function splitNominal(
  quantities: number[],
  total: number,
): { unitPrices: number[]; handlingMinor: number } {
  const qs = quantities.map((q) => Math.max(1, Math.floor(q)))
  const unitPrices = qs.map(() => 1)
  const shipped = qs.reduce((s, q) => s + q, 0)
  if (qs.length === 0 || shipped >= total) return { unitPrices, handlingMinor: 0 }
  const remainder = total - shipped
  const firstQty = qs[0]!
  const perUnit = Math.floor(remainder / firstQty)
  unitPrices[0] = 1 + perUnit
  return { unitPrices, handlingMinor: remainder - perUnit * firstQty }
}

/** The document lines for a nominal proforma: one per physical item, plus a handling remainder.
 *  `totalMinor` is the org's nominal declared value. */
export function buildNominalLines(
  items: ProformaItem[],
  category: NominalCategory,
  totalMinor: number,
): ProformaLine[] {
  const wording = NOMINAL_WORDING[category]
  const { unitPrices, handlingMinor } = splitNominal(
    items.map((i) => i.quantity),
    totalMinor,
  )
  const lines: ProformaLine[] = items.map((item, i) => {
    const quantity = Math.max(1, Math.floor(item.quantity))
    return {
      description: `${quantity}x ${item.name}: ${wording}`,
      quantity,
      unit_price_minor: unitPrices[i] ?? 1,
      ...(item.hs_code ? { hs_code: item.hs_code } : {}),
      ...(item.customs_description ? { customs_description: item.customs_description } : {}),
      ...(item.country_of_origin ? { country_of_origin: item.country_of_origin } : {}),
      ...(item.external_id
        ? { external_id: item.external_id, product_source: item.product_source ?? "shopify" }
        : {}),
    }
  })
  if (handlingMinor > 0) {
    lines.push({
      description: `Handling: ${wording}`,
      quantity: 1,
      unit_price_minor: handlingMinor,
    })
  }
  return lines
}

// ── issue ────────────────────────────────────────────────────────────────────

export interface ProformaCounterparty {
  legal_name: string
  country: string
  contact_id?: string | null
  address?: string | null
  vat_id?: string | null
  email?: string | null
}

/** The recipient fields invoicing REFUSES to issue without (its own
 *  `REQUIRED_COUNTERPARTY_FIELDS`, bundled-apps/invoicing/src/issue.ts): an issued document is a
 *  legal record, so it must name its recipient, say where they are and how to reach them. Checked
 *  HERE, before the cross-app call, so the row reports the missing field by name instead of
 *  surfacing invoicing's `counterparty_incomplete` code to the operator. */
const REQUIRED_RECIPIENT_FIELDS = ["legal_name", "country", "address", "email"] as const

function blankField(v: string | null | undefined): boolean {
  return typeof v !== "string" || v.trim().length === 0
}

/** Names every recipient field this proforma cannot be issued without, else null. */
export function missingRecipientFields(c: ProformaCounterparty): string[] {
  return REQUIRED_RECIPIENT_FIELDS.filter((f) => blankField(c[f])).slice()
}

export interface EnsureNominalProformaInput {
  order_key: string
  category: NominalCategory
  counterparty: ProformaCounterparty
  items: ProformaItem[]
  shopify_order_id?: string | null
  shopify_order_number?: string | null
}

export type EnsureNominalProformaResult =
  | { status: "completed"; document_id: string; number: string | null }
  | { status: "pending_approval"; approval_id: string }
  | { status: "error"; code: string; message: string }

interface IssuerProfile {
  id?: string
  active?: boolean
  is_active?: boolean
  name?: string
}

/** The org's issuer profile to issue under. Without one the invoicing call fails issuer_not_found,
 *  so resolve it here and surface a readable error instead of a raw invoicing code.
 *
 *  A FAILED read is reported as a failed read (`{ error }`), never as "no profile configured": that
 *  conflation is what produced the "no issuer profile is configured" misdiagnosis against a fully
 *  configured org. */
type IssuerLookup = { id: string | null } | { error: string }

async function resolveIssuerProfileId(ctx: BoxtalToolCtx): Promise<IssuerLookup> {
  try {
    const env = await ctx.executeTool("invoicing:settings_issuer_profile_list", {})
    if (env.status !== "completed" || env.result == null) {
      const message =
        env.status === "error"
          ? env.error.message
          : "the invoicing app did not answer the issuer-profile read"
      ctx.logger?.warn?.("prep: issuer profile read did not complete", {
        status: env.status,
        err: message,
      })
      return { error: message }
    }
    // The invoicing tool answers `{ items: [...] }` (reads.ts settingsIssuerProfileList). The other
    // shapes are tolerated because a cross-app read should not break on an envelope rename, but
    // `items` is the one that is actually served: reading only `profiles`/`results` made every
    // proforma issue fail with "no issuer profile is configured" against a fully configured org.
    const raw = env.result as
      | IssuerProfile[]
      | { items?: IssuerProfile[]; profiles?: IssuerProfile[]; results?: IssuerProfile[] }
    const list = Array.isArray(raw) ? raw : (raw.items ?? raw.profiles ?? raw.results ?? [])
    const first = list.find((p) => p?.id && p.active !== false && p.is_active !== false)
    return { id: first?.id ?? null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger?.warn?.("prep: issuer profile read threw", { err: message })
    return { error: message }
  }
}

const ISSUER_MISSING_MESSAGE =
  "No issuer profile is configured in the invoicing app, so the proforma cannot be issued. Set one up in Invoicing settings, then set the category again."

/**
 * Issue the nominal proforma for a row.
 *
 * Callers must have checked that the row does NOT already carry a proforma: this always issues.
 * A user holding invoicing approval rights gets `completed` inline (the cross-app bridge forwards
 * the inherited user actor with no origin, so the kernel's direct-human-call path applies); anyone
 * else gets `pending_approval` and the row parks on the approval id until the scan resolves it.
 */
export async function ensureNominalProforma(
  ctx: BoxtalToolCtx,
  input: EnsureNominalProformaInput,
): Promise<EnsureNominalProformaResult> {
  if (!input.items || input.items.length === 0) {
    return {
      status: "error",
      code: "no_items",
      message: "The proforma needs at least one item: list what is physically in the parcel.",
    }
  }
  // Refuse BEFORE the cross-app call when the recipient is incomplete: invoicing rejects such an
  // issuance outright, and its error names its own field set, which the operator cannot map back
  // to this row. Naming the missing field here is the difference between "fill the customer email"
  // and an opaque `counterparty_incomplete`.
  const missing = missingRecipientFields(input.counterparty)
  if (missing.length > 0) {
    return {
      status: "error",
      code: "recipient_incomplete",
      message:
        `This row has no ${missing.join(", ")} for the recipient, so no shipping document can be ` +
        `issued for it. Complete the customer on the Shopify order (or the shipment recipient) and ` +
        `set the category again.`,
    }
  }
  // The declared value is the org's own packing policy, never a figure this app invents.
  const nominalMinor = (await loadPackagingPolicy(ctx)).nominal_proforma_value_minor
  if (nominalMinor == null) {
    return {
      status: "error",
      code: "nominal_value_unset",
      message:
        "No nominal declared value is set for return after repair and sample proformas, so none can be issued. " +
        "Set nominal_proforma_value_minor with boxtal__settings_packaging_policy_set, then set the category again.",
    }
  }
  const issuer = await resolveIssuerProfileId(ctx)
  if ("error" in issuer) {
    return {
      status: "error",
      code: "issuer_lookup_failed",
      message: `The invoicing app could not be read to find the issuer profile: ${issuer.error}. Try again in a moment.`,
    }
  }
  const issuerProfileId = issuer.id
  if (!issuerProfileId) {
    return { status: "error", code: "issuer_not_found", message: ISSUER_MISSING_MESSAGE }
  }
  const params: Record<string, unknown> = {
    // All four required fields go out ALWAYS (never spread-conditionally): invoicing requires
    // legal_name + country + address + email, so omitting one is a refused issuance.
    counterparty: {
      legal_name: input.counterparty.legal_name,
      country: input.counterparty.country,
      address: input.counterparty.address,
      email: input.counterparty.email,
      ...(input.counterparty.contact_id ? { contact_id: input.counterparty.contact_id } : {}),
      ...(input.counterparty.vat_id ? { vat_id: input.counterparty.vat_id } : {}),
    },
    items: buildNominalLines(input.items, input.category, nominalMinor),
    reason: `${NOMINAL_REASON_LABEL[input.category]} ${prepProformaToken(input.order_key)}`,
    declared_value_minor: nominalMinor,
    currency: "EUR",
    incoterm: "DAP",
    issuer_profile_id: issuerProfileId,
    shipment_ref: prepProformaShipmentRef(input.order_key),
    ...(input.shopify_order_id ? { shopify_order_id: input.shopify_order_id } : {}),
    ...(input.shopify_order_number ? { shopify_order_number: input.shopify_order_number } : {}),
  }

  let env: Awaited<ReturnType<BoxtalToolCtx["executeTool"]>>
  try {
    env = await ctx.executeTool("invoicing:proforma_create_and_issue", params)
  } catch (err) {
    return {
      status: "error",
      code: "invoicing_unavailable",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  if (env.status === "pending_approval") {
    return { status: "pending_approval", approval_id: env.approval_id }
  }
  if (env.status === "error") {
    return { status: "error", code: env.error.code, message: env.error.message }
  }
  // The invoicing mutation returns its OWN result envelope inside the cross-app one.
  const res = env.result as {
    status?: string
    document_id?: string
    id?: string
    number?: string | null
    approval_id?: string
    error?: { code?: string; message?: string }
    document?: { id?: string }
  } | null
  if (res?.status === "pending_approval" && res.approval_id) {
    return { status: "pending_approval", approval_id: res.approval_id }
  }
  if (res?.status === "error") {
    return {
      status: "error",
      code: res.error?.code ?? "proforma_failed",
      message: res.error?.message ?? "The proforma could not be issued.",
    }
  }
  const documentId = res?.document_id ?? res?.id ?? res?.document?.id ?? null
  if (!documentId) {
    return {
      status: "error",
      code: "proforma_not_issued",
      message: "Invoicing accepted the proforma but returned no document id.",
    }
  }
  return { status: "completed", document_id: documentId, number: res?.number ?? null }
}

// ── pending resolution ───────────────────────────────────────────────────────

export interface PendingProformaRow {
  order_key: string
  proforma_pending_approval_id?: string | null
  proforma_requested_at?: string | null
}

export interface ResolvedProforma {
  order_key: string
  document_id: string
  number: string | null
}

interface ProformaHeader {
  id?: string
  number?: string | null
  shipment_ref?: string | null
}

/**
 * Match rows whose proforma was still awaiting approval against the proformas that now exist.
 *
 * ONE documents_search for the whole scan (not one per row), matched on the correlation reference.
 * A proforma that is not one of ours (no `prep:` shipment_ref, or a key we are not waiting on) is
 * ignored, so the partial-shipment batch proformas the shipment module issues are never mistaken
 * for a prep-row anchor.
 */
export async function resolvePendingProformas(
  ctx: BoxtalToolCtx,
  pendingRows: PendingProformaRow[],
): Promise<Map<string, ResolvedProforma>> {
  const out = new Map<string, ResolvedProforma>()
  const waiting = new Set(pendingRows.map((r) => r.order_key))
  if (waiting.size === 0) return out
  let env: Awaited<ReturnType<BoxtalToolCtx["executeTool"]>>
  try {
    env = await ctx.executeTool("invoicing:documents_search", {
      type: "proforma",
      status: "issued",
      limit: 100,
    })
  } catch (err) {
    ctx.logger?.warn?.("prep: pending proforma search threw", {
      waiting: waiting.size,
      err: err instanceof Error ? err.message : String(err),
    })
    return out
  }
  if (env.status !== "completed" || env.result == null) {
    ctx.logger?.warn?.("prep: pending proforma search did not complete", {
      waiting: waiting.size,
      status: env.status,
      err: env.status === "error" ? env.error.message : null,
    })
    return out
  }
  const raw = env.result as ProformaHeader[] | { results?: ProformaHeader[] }
  const docs = Array.isArray(raw) ? raw : (raw.results ?? [])
  for (const d of docs) {
    const ref = typeof d?.shipment_ref === "string" ? d.shipment_ref : null
    if (!ref || !ref.startsWith(PREP_PROFORMA_REF_PREFIX) || !d.id) continue
    const orderKey = ref.slice(PREP_PROFORMA_REF_PREFIX.length)
    if (!waiting.has(orderKey) || out.has(orderKey)) continue
    out.set(orderKey, { order_key: orderKey, document_id: String(d.id), number: d.number ?? null })
  }
  return out
}

/** How long a pending proforma approval is worth waiting on before the row says so out loud. */
export const PROFORMA_PENDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export function isProformaApprovalExpired(
  requestedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!requestedAt) return false
  const t = Date.parse(requestedAt)
  if (Number.isNaN(t)) return false
  return now - t > PROFORMA_PENDING_MAX_AGE_MS
}
