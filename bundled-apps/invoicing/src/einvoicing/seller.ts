// SPDX-License-Identifier: FSL-1.1-ALv2
// The seller half of an e-invoice: a French e-invoice's legal original (its Factur-X) names the
// issuing company by its SIREN and structured address. When the issuer profile lacks them, the
// legal original cannot be built, so the document is refused before a number is taken, with the
// Settings fields a person fills in and the tool an agent would use.
import { type FacturxPartyGap, facturxPartyGaps } from "../facturx/cii"
import { facturxSellerFrom } from "../facturx/input"

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
  const said = missing.map((f) => FIELD_SAID[f])
  const list = said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`
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
