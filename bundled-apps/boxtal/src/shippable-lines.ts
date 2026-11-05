// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE rule for which invoice lines are parcel lines (physical goods the resolver must pack), and
// ONE rule for when the lines it could not resolve block a label. The draft build applies the first
// before it calls the resolver; staging (create_shipment and its preflight) and the prep worklist
// both read the second. They used to keep their own rules: the worklist ignored an unresolved line
// with no product link, staging refused it, so a free-text "Shipping" line kinded as goods showed the
// row as ready while Ship refused it with `unresolved_lines`.

/** The fields of an invoice line the rule reads. */
export interface ShippableLineInput {
  line_kind?: string | null
  product_source: string | null
  external_id: string | null
  description?: string | null
  customs_description?: string | null
  hs_code?: string | null
  quantity?: number | string | null
}

/** A free-text line whose description IS a shipping charge or fee, in the languages invoices are
 *  written in: the charge word alone, optionally followed by "costs"/"fee"/"& handling" and a
 *  parenthetical that names only a carrier or service ("Shipping (DHL Express)"). Anything else is
 *  read as a product ("Shipping crate", "Shipping - replacement unit", "Delivery: carry case"): a
 *  false product only blocks the label visibly, a false charge would ship the parcel short with no
 *  warning, so the rule stays narrow. Ambiguous bare words (an unaccented "Expedition", "Porto",
 *  "Carriage") are products. */
const CHARGE_WORD =
  "shipping|delivery|freight|postage|surcharge|frais\\s+(?:de\\s+port|d['’]envoi|de\\s+livraison|d['’]exp[ée]dition|de\\s+transport)|livraison|expédition|versand(?:kosten)?|portokosten|verzend(?:kosten|ing)?|gastos\\s+de\\s+env[ií]o|env[ií]o|spedizione|spese\\s+di\\s+spedizione|wysy[łl]ka|koszty?\\s+wysy[łl]ki"
/** Words a charge's parenthetical may hold: carriers, service levels, zones, weights. */
const SERVICE_WORD =
  "dhl|ups|fedex|tnt|gls|dpd|colissimo|chronopost|la\\s+poste|poste|postnl|bpost|correos|royal\\s+mail|usps|boxtal|mondial\\s+relay|relais|relay|point|express|standard|economy|eco|priority|prioritaire|international|domestic|europe|eu|ue|worldwide|world|ground|saver|plus|premium|home|domicile|signature|tracked|suivi|insured|kg|\\d+(?:[.,]\\d+)?"
const CHARGE_LINE = new RegExp(
  `^(?:${CHARGE_WORD})(?:\\s+(?:costs?|fees?|charges?|(?:&|and)\\s+handling))?` +
    `(?:\\s*\\(\\s*(?:${SERVICE_WORD})(?:[\\s&+/,-]+(?:${SERVICE_WORD}))*\\s*\\))?\\s*$`,
  "i",
)

/** True when the line carries a catalog product link (the resolver's join key). */
export function hasProductLink(line: Pick<ShippableLineInput, "product_source" | "external_id">): boolean {
  return Boolean(line.product_source && line.external_id)
}

/**
 * Whether an invoice line is a parcel line: physical goods that must be packed, and that block a
 * label when no shipping profile resolves them.
 *
 * - A line with a product link is always a parcel line (whatever its kind): a missing profile is a
 *   setup gap the operator must see.
 * - A line with no product link is NOT a parcel line when it is kinded shipping/software, when it
 *   carries no quantity (a text line), or when it is a goods line whose description names a
 *   shipping charge or fee. It ships nothing.
 * - Any other unlinked goods line is a parcel line: it is a real product whose link is missing, so it
 *   stays unresolved and blocks, visibly, in the worklist and at staging alike. An HS code marks a
 *   line as goods, so such a line is never treated as a charge.
 */
export function isParcelLine(line: ShippableLineInput): boolean {
  if (hasProductLink(line)) return true
  if ((line.line_kind ?? "goods") !== "goods") return false
  // An unreadable quantity ("2,0") counts as goods: it stays visible as unresolved, never skipped.
  const quantity = Number(line.quantity ?? 1)
  if (Number.isFinite(quantity) && quantity <= 0) return false
  if (line.hs_code) return true
  const text = `${line.description ?? ""}`.trim() || `${line.customs_description ?? ""}`.trim()
  return !CHARGE_LINE.test(text)
}

/** The facts of a draft the blocking rule reads. */
export interface UnresolvedBlockInput {
  unresolved: ReadonlyArray<unknown>
  parcel_override?: boolean
  customs_required?: boolean
}

/**
 * Whether the draft's unresolved parcel lines block a label. An explicit operator carton (a
 * persisted set_package override) makes per-line profiles irrelevant for PARCELS, so on a
 * customs-free route the draft ships anyway; when the route needs a customs declaration the
 * per-line weights and values still derive from profiles, so unresolved lines keep blocking.
 */
export function unresolvedLinesBlockLabel(draft: UnresolvedBlockInput): boolean {
  if (draft.unresolved.length === 0) return false
  return !(draft.parcel_override && !draft.customs_required)
}
