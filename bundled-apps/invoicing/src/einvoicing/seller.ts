// SPDX-License-Identifier: FSL-1.1-ALv2
// The seller half of an e-invoice: a French e-invoice's legal original (its Factur-X) names the
// issuing company by its SIREN and structured address. When the issuer profile lacks them, the
// legal original cannot be built. In enforce mode the document is refused before a number is
// taken, with the Settings fields a person fills in and the tool an agent would use; in warn mode
// it is issued with a plain PDF and a warning naming the same fields. A French issuer's invoices
// and credit notes also need its identity mentions (SIREN, legal form, share capital, RCS city):
// those missing refuse the document in every mode, Shopify orders and stream sales included.
import { type FacturxPartyGap, facturxPartyGaps } from "../facturx/cii"
import { facturxSellerFrom } from "../facturx/input"
import type { MissingItem } from "./gate"
import { isValidSiren, sirenFromFrVat } from "./identity"

/** An issuer field a document cannot go without: an e-invoice's Factur-X party fields, or one of
 *  the French seller identity mentions. */
export type IssuerGap = FacturxPartyGap | "legal_form" | "share_capital" | "rcs_city"

/** How Settings > Invoicing labels each issuer field a person fills in. */
const FIELD_SAID: Record<IssuerGap, string> = {
  legal_name: "legal name",
  siren: "SIREN",
  address_line1: "street address",
  postcode: "postcode",
  city: "city",
  country_code: "country",
  legal_form: "legal form",
  share_capital: "share capital",
  rcs_city: "RCS registration city",
}

const IDENTITY_MENTIONS: ReadonlySet<IssuerGap> = new Set([
  "siren",
  "legal_form",
  "share_capital",
  "rcs_city",
])

export interface SellerIncompleteError {
  code: "issuer_incomplete"
  message: string
  retryable: true
  /** `always`: a legal mention every invoice must print is missing, whatever the e-invoicing mode.
   *  `enforce`: only the e-invoice file cannot be built; warn mode issues a plain PDF. */
  blocking: "always" | "enforce"
  body: {
    issuer_profile_id: string | null
    missing_fields: IssuerGap[]
    fix_tool: "settings_issuer_profile_update"
  }
}

const blank = (v: unknown) => typeof v !== "string" || v.trim() === ""

/** The issuer's SIREN as printed: the stored one, else the one a French VAT number carries. */
export function issuerSiren(issuer: {
  siren?: unknown
  vat_id?: unknown
  country_code?: unknown
  country?: unknown
}): string | null {
  const own = typeof issuer.siren === "string" ? issuer.siren.replace(/\s+/g, "") : ""
  if (own !== "") return own
  return sirenFromFrVat(typeof issuer.vat_id === "string" ? issuer.vat_id : null, {
    billingCountry:
      (typeof issuer.country_code === "string" && issuer.country_code) ||
      (typeof issuer.country === "string" ? issuer.country : null),
  })
}

/** A legal form of a sole trader (entreprise individuelle): no share capital, and an RCS number
 *  only for a trader (an artisan or a liberal profession has none). */
const SOLE_TRADER_FORM =
  /^(e\.?i\.?(r\.?l\.?)?|micro|auto|entrepreneur individuel|entreprise individuelle)\b/i

/**
 * The French seller identity mentions a French issuer's invoices and credit notes must print and
 * the profile lacks: SIREN and "RCS <city>" (C. com. R123-237), legal form and share capital
 * (R123-238), as CGI ann. II art. 242 nonies A I 1° requires on every invoice, B2C included.
 * A sole trader (EI) is asked for its SIREN and legal form only. Empty for any other country.
 */
export function issuerMentionGaps(issuer: Record<string, unknown>): IssuerGap[] {
  const country = String(issuer.country_code || issuer.country || "")
    .trim()
    .toUpperCase()
  if (country !== "FR") return []
  const missing: IssuerGap[] = []
  if (!isValidSiren(issuerSiren(issuer))) missing.push("siren")
  const form = typeof issuer.legal_form === "string" ? issuer.legal_form.trim() : ""
  if (form === "") missing.push("legal_form")
  if (!SOLE_TRADER_FORM.test(form)) {
    if (blank(issuer.share_capital)) missing.push("share_capital")
    if (blank(issuer.rcs_city)) missing.push("rcs_city")
  }
  return missing
}

function incompleteError(
  issuer: Record<string, unknown>,
  docType: string,
  facturx: readonly FacturxPartyGap[],
  mentions: readonly IssuerGap[],
): SellerIncompleteError | null {
  const missing: IssuerGap[] = [...facturx]
  for (const m of mentions) if (!missing.includes(m)) missing.push(m)
  if (missing.length === 0) return null
  const list = fieldList(missing)
  const what = docType === "credit_note" ? "credit note" : "invoice"
  const are = missing.length === 1 ? "is" : "are"
  const why =
    mentions.length > 0
      ? `a French ${what} must state the seller's SIREN, legal form, share capital and RCS registration, and your company's ${list} ${are} missing`
      : `it is an e-invoice, and your company's ${list} ${are} missing`
  return {
    code: "issuer_incomplete",
    message: `This ${what} cannot be issued yet: ${why}. Add ${missing.length === 1 ? "it" : "them"} in Settings > Invoicing, Issuer profiles (settings_issuer_profile_update), then issue again. Nothing was issued and no number was taken.`,
    retryable: true,
    blocking: mentions.length > 0 ? "always" : "enforce",
    body: {
      issuer_profile_id: typeof issuer.id === "string" ? issuer.id : null,
      missing_fields: missing,
      fix_tool: "settings_issuer_profile_update",
    },
  }
}

/** The refusal for an e-invoice whose issuer profile cannot sign its legal original, else null. */
export function sellerIncompleteError(
  issuer: Record<string, unknown>,
  docType: string,
): SellerIncompleteError | null {
  return incompleteError(issuer, docType, facturxPartyGaps(facturxSellerFrom(issuer)), [])
}

/**
 * The one issuer check every issuing path runs, before a number is taken: for an invoice or a
 * credit note (not an internal cancellation), the French identity mentions it must print (blocks
 * in every e-invoicing mode) and, in the e-invoice regime, the fields its Factur-X needs (blocks
 * in enforce mode, a warning otherwise). Null when nothing is missing.
 */
export function sellerGapFor(
  docType: string,
  evaluation: { regime: string | null; internalCancellation: boolean },
  issuer: object,
): SellerIncompleteError | null {
  if (docType !== "invoice" && docType !== "credit_note") return null
  if (evaluation.internalCancellation) return null
  const row = issuer as Record<string, unknown>
  const facturx = evaluation.regime === "e_invoice" ? facturxPartyGaps(facturxSellerFrom(row)) : []
  return incompleteError(row, docType, facturx, issuerMentionGaps(row))
}

/** True when `gap` stops the issue under the organization's e-invoicing `mode`. */
export function sellerGapBlocks(gap: SellerIncompleteError | null, mode: string): boolean {
  return gap !== null && (gap.blocking === "always" || mode === "enforce")
}

/** Thrown by the issue backstop when a path skipped the up-front seller check. */
export class SellerIncompleteRefusal extends Error {
  readonly error: SellerIncompleteError
  constructor(error: SellerIncompleteError) {
    super(error.message)
    this.name = "SellerIncompleteRefusal"
    this.error = error
  }
}

/** The listed fields, as a person reads them: "SIREN, street address and city". */
function fieldList(missing: readonly IssuerGap[]): string {
  const said = missing.map((f) => FIELD_SAID[f])
  return said.length === 1 ? (said[0] ?? "") : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`
}

/**
 * Warn mode: the seller gap does not block. The document is issued with a plain PDF instead of
 * its e-invoice file, and this warning travels with the result, naming the Settings fields.
 */
export function sellerWarning(gap: SellerIncompleteError): {
  code: "issuer_incomplete"
  message: string
  missing: MissingItem[]
} {
  const n = gap.body.missing_fields.length
  const list = fieldList(gap.body.missing_fields)
  return {
    code: "issuer_incomplete",
    message: `Issued with a plain PDF, without its e-invoice file (Factur-X): your company's ${list} ${n === 1 ? "is" : "are"} missing. Add ${n === 1 ? "it" : "them"} in Settings > Invoicing, Issuer profiles before e-invoicing is enforced.`,
    missing: gap.body.missing_fields.map((f) => ({
      field: `issuer.${f}`,
      why: IDENTITY_MENTIONS.has(f)
        ? `Your company's ${FIELD_SAID[f]} is printed on every French invoice.`
        : `Your company's ${FIELD_SAID[f]} is printed on every e-invoice.`,
      fix_tool: "settings_issuer_profile_update",
      fix_hint: `Settings > Invoicing, Issuer profiles: ${FIELD_SAID[f]}.`,
    })),
  }
}

/** One warning from the buyer gate's and the seller's, when both apply. */
export function mergeEinvoicingWarnings<
  W extends { code: string; message: string; missing: MissingItem[] },
>(
  gate: W | null,
  seller: ReturnType<typeof sellerWarning> | null,
): W | ReturnType<typeof sellerWarning> | null {
  if (!gate) return seller
  if (!seller) return gate
  return {
    ...gate,
    message: `${gate.message} ${seller.message}`,
    missing: [...gate.missing, ...seller.missing],
  }
}

interface IssuerAttentionCtx {
  db: { findMany(entity: string, q: Record<string, unknown>): Promise<unknown[]> }
  emit?(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

/** The park kind of a document waiting on its issuer profile. */
export const ISSUER_PARK_KIND = "issuer_incomplete"

/** True when an open issuer park other than `parkId` waits on the same issuer profile. */
async function otherOpenIssuerPark(
  db: IssuerAttentionCtx["db"],
  issuerId: string,
  parkId: string,
): Promise<boolean> {
  const open = (await db.findMany("deferred_events", {
    where: { status: "awaiting_dependency" },
    limit: 500,
  })) as Array<Record<string, unknown>>
  return open.some((r) => {
    const b = (r.blocked_on ?? {}) as Record<string, unknown>
    return (
      String(r.id) !== parkId && b.kind === ISSUER_PARK_KIND && b.issuer_profile_id === issuerId
    )
  })
}

/** The `blocked_on` of a park waiting on the issuer profile. */
export function issuerParkBlockedOn(gap: SellerIncompleteError): Record<string, unknown> {
  return {
    kind: ISSUER_PARK_KIND,
    code: gap.code,
    issuer_profile_id: gap.body.issuer_profile_id,
    missing_fields: gap.body.missing_fields,
  }
}

/**
 * Raise the `einvoicing:issuer_incomplete` attention item for the people who may edit the issuer
 * profile: once per issuer (only for a park just created, and when no other park already waits
 * on the same profile), naming the Settings fields to fill in and the first document waiting.
 */
export async function raiseIssuerAttention(
  ctx: IssuerAttentionCtx,
  input: { park: { id: string; created: boolean }; gap: SellerIncompleteError; waiting: string },
): Promise<boolean> {
  if (!input.park.created || !ctx.emit) return false
  const issuerId = input.gap.body.issuer_profile_id
  if (issuerId && (await otherOpenIssuerPark(ctx.db, issuerId, input.park.id))) return false
  const n = input.gap.body.missing_fields.length
  const list = fieldList(input.gap.body.missing_fields)
  await ctx.emit({
    entity: "einvoicing",
    action: "issuer_incomplete",
    entityId: issuerId ?? input.park.id,
    data: {
      issuer_profile_id: issuerId,
      deferred_id: input.park.id,
      missing_fields: input.gap.body.missing_fields,
      text: `${input.waiting} cannot be issued: your company's ${list} ${n === 1 ? "is" : "are"} missing. Add ${n === 1 ? "it" : "them"} in Settings > Invoicing, Issuer profiles, and the waiting invoices are issued.`,
      resolved: false,
    },
  })
  return true
}

/** Close the issuer item once no open park waits on that issuer profile any more. */
export async function resolveIssuerAttention(
  ctx: IssuerAttentionCtx,
  input: { parkId: string; issuer_profile_id: string | null },
): Promise<boolean> {
  if (!ctx.emit) return false
  if (
    input.issuer_profile_id &&
    (await otherOpenIssuerPark(ctx.db, input.issuer_profile_id, input.parkId))
  )
    return false
  await ctx.emit({
    entity: "einvoicing",
    action: "issuer_incomplete",
    entityId: input.issuer_profile_id ?? input.parkId,
    data: { issuer_profile_id: input.issuer_profile_id, deferred_id: input.parkId, resolved: true },
  })
  return true
}
