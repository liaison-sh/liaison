// SPDX-License-Identifier: FSL-1.1-ALv2
// The seller half of an e-invoice: a French e-invoice's legal original (its Factur-X) names the
// issuing company by its SIREN and structured address. When the issuer profile lacks them, the
// legal original cannot be built. In enforce mode the document is refused before a number is
// taken, with the Settings fields a person fills in and the tool an agent would use; in warn mode
// it is issued with a plain PDF and a warning naming the same fields.
import { type FacturxPartyGap, facturxPartyGaps } from "../facturx/cii"
import { facturxSellerFrom } from "../facturx/input"
import type { MissingItem } from "./gate"

/** How Settings > Invoicing labels each issuer field a person fills in. */
const FIELD_SAID: Record<FacturxPartyGap, string> = {
  legal_name: "legal name",
  siren: "SIREN",
  address_line1: "street address",
  postcode: "postcode",
  city: "city",
  country_code: "country",
}

export interface SellerIncompleteError {
  code: "issuer_incomplete"
  message: string
  retryable: true
  body: {
    issuer_profile_id: string | null
    missing_fields: FacturxPartyGap[]
    fix_tool: "settings_issuer_profile_update"
  }
}

/** The refusal for an e-invoice whose issuer profile cannot sign its legal original, else null. */
export function sellerIncompleteError(
  issuer: Record<string, unknown>,
  docType: string,
): SellerIncompleteError | null {
  const missing = facturxPartyGaps(facturxSellerFrom(issuer))
  if (missing.length === 0) return null
  const list = fieldList(missing)
  const what = docType === "credit_note" ? "credit note" : "invoice"
  return {
    code: "issuer_incomplete",
    message: `This ${what} cannot be issued yet: it is an e-invoice, and your company's ${list} ${missing.length === 1 ? "is" : "are"} missing. Add ${missing.length === 1 ? "it" : "them"} in Settings > Invoicing, Issuer profiles, then issue again. Nothing was issued and no number was taken.`,
    retryable: true,
    body: {
      issuer_profile_id: typeof issuer.id === "string" ? issuer.id : null,
      missing_fields: missing,
      fix_tool: "settings_issuer_profile_update",
    },
  }
}

/** The seller refusal for a document that will carry a Factur-X (an invoice or credit note in
 *  the e-invoice regime, not an internal cancellation), else null. */
export function sellerGapFor(
  docType: string,
  evaluation: { regime: string | null; internalCancellation: boolean },
  issuer: object,
): SellerIncompleteError | null {
  if (docType !== "invoice" && docType !== "credit_note") return null
  if (evaluation.regime !== "e_invoice" || evaluation.internalCancellation) return null
  return sellerIncompleteError(issuer as Record<string, unknown>, docType)
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
function fieldList(missing: readonly FacturxPartyGap[]): string {
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
      why: `Your company's ${FIELD_SAID[f]} is printed on every e-invoice.`,
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
      text: `${input.waiting} cannot be issued as an e-invoice: your company's ${list} ${n === 1 ? "is" : "are"} missing. Add ${n === 1 ? "it" : "them"} in Settings > Invoicing, Issuer profiles, and the waiting invoices are issued.`,
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
